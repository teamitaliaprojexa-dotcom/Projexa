// ============================================================================
// MOTORE DI SINCRONIZZAZIONE JIRA -> PROJEXA
// ----------------------------------------------------------------------------
// Non è un programma a sé: è la libreria condivisa dai due programmi
//   * jobs/aggiornaJiraQuotazioni.js  (jira_quotazioni -> cl_quotazioni)
//   * jobs/aggiornaJiraTask.js        (jira_task       -> task_app)
// che si differenziano solo per la configurazione passata a runJiraSync().
//
// COME LAVORA
//   1. Legge la mappatura (tabella jira_*) per tenant/utente. La riga
//      colonna_projexa = 'Nome_Filtro' dice QUALE filtro salvato su Jira eseguire;
//      tutte le altre righe dicono "colonna Projexa <- colonna del report Jira".
//   2. Esegue il filtro su Jira e scorre TUTTE le pagine del risultato.
//   3. Per ogni riga del report cerca il cliente: il valore della colonna Jira del
//      nome cliente viene confrontato con clients.valore2 (campo indicato nella
//      configurazione). Riga senza cliente corrispondente = riga ignorata.
//   4. Se il codice non esiste per quel cliente -> INSERT; se esiste ed è ancora
//      valido (scadenza > oggi) -> UPDATE; se esiste ma è scaduto -> non si tocca.
//
// CIFRATURA: cl_quotazioni e task_app nascono con crypto = 1, quindi i dati sul
// database sono cifrati. La cifratura è randomizzata: NON si può cercare il codice
// con una WHERE. I confronti si fanno quindi in memoria sulle righe lette dal pool
// (che decifra in automatico) e le scritture passano da encryptRowForWrite.
// ============================================================================
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import {
  getJiraSession,
  jiraApi,
  listFilters,
  loadFilter,
  isJiraEnabled,
  formatValue
} from '../routes/jira.js';

// Righe di mappatura che NON sono colonne di destinazione ma istruzioni di servizio.
const CAMPO_FILTRO = 'nome_filtro';

// Colonne che il job non scrive mai: le imposta lui dal contesto del login.
const COLONNE_DI_CONTESTO = new Set(['id', 'tenant_id', 'user_id', 'client_id', 'crypto']);

// Tabelle ammesse: i nomi finiscono dentro la query, quindi restano in whitelist.
const TABELLE_MAPPATURA = new Set(['jira_quotazioni', 'jira_task']);
const TABELLE_DESTINAZIONE = new Set(['cl_quotazioni', 'task_app']);

const MAX_PAGINE = 50;      // 50 x 100 = 5.000 righe per filtro
const PAGE_SIZE = 100;

// ----------------------------------------------------------------------------
// NORMALIZZAZIONE E CONVERSIONE DEI VALORI
// ----------------------------------------------------------------------------

// I nomi delle colonne Jira sono scritti a mano in jira_*.colonna_jira: capita di
// trovarli con maiuscole diverse o con spazi di troppo (es. ' riepilogo').
function norm(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function vuoto(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})/;
const IT_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/;

// Restituisce 'YYYY-MM-DD' oppure null. Jira consegna le date già in ISO, ma i
// campi personalizzati possono arrivare come oggetto o come testo all'italiana.
function toDate(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  const text = typeof raw === 'object' ? formatValue(raw) : String(raw);
  if (!text.trim()) return null;
  const it = IT_DATE.exec(text.trim());
  if (it) return `${it[3]}-${it[2].padStart(2, '0')}-${it[1].padStart(2, '0')}`;
  const iso = ISO_DATE.exec(text);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

// Restituisce un numero oppure null. Gestisce sia '3.5' sia '3,5' e ignora le
// unità di misura eventualmente scritte accanto al numero (es. '3,5 gg').
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = (typeof raw === 'object' ? formatValue(raw) : String(raw)).trim();
  if (!text) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(text.replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Converte il valore Jira nel tipo della colonna Projexa di destinazione.
function coerce(raw, dataType) {
  if (dataType === 'date' || dataType.startsWith('timestamp')) return toDate(raw);
  if (/^(numeric|integer|smallint|bigint|real|double precision)/.test(dataType)) return toNumber(raw);
  if (dataType === 'boolean') {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'boolean') return raw;
    const t = norm(typeof raw === 'object' ? formatValue(raw) : raw);
    if (['true', 't', '1', 'si', 'sì', 'yes'].includes(t)) return true;
    if (['false', 'f', '0', 'no'].includes(t)) return false;
    return null;
  }
  // Testo: stessa resa che si vede nella griglia Jira (oggetti, elenchi, ADF).
  const text = formatValue(raw);
  return vuoto(text) ? null : text;
}

// ----------------------------------------------------------------------------
// METADATI DELLA TABELLA DI DESTINAZIONE
// ----------------------------------------------------------------------------

const cacheColonne = new Map(); // tabella -> Map(colonna -> data_type)

async function colonneDestinazione(tabella) {
  if (cacheColonne.has(tabella)) return cacheColonne.get(tabella);
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated <> 'ALWAYS'`,
    [tabella]
  );
  const map = new Map(rows.map((r) => [r.column_name, r.data_type]));
  cacheColonne.set(tabella, map);
  return map;
}

// ----------------------------------------------------------------------------
// MAPPATURA (tabelle jira_quotazioni / jira_task)
// ----------------------------------------------------------------------------

async function leggiMappatura(tabella, tenantId, userId) {
  const { rows } = await db.query(
    `SELECT colonna_projexa, colonna_jira FROM "${tabella}"
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY ordinamento NULLS LAST, colonna_projexa`,
    [tenantId, userId]
  );
  return rows
    .filter((r) => !vuoto(r.colonna_projexa) && !vuoto(r.colonna_jira))
    .map((r) => ({ projexa: String(r.colonna_projexa).trim(), jira: String(r.colonna_jira).trim() }));
}

// ----------------------------------------------------------------------------
// RISOLUZIONE DELLE COLONNE JIRA
// ----------------------------------------------------------------------------

// In jira_*.colonna_jira è scritta l'ETICHETTA della colonna così come si legge su
// Jira ('Chiave', 'Creati', 'Riepilogo'), non l'identificativo tecnico del campo
// ('issuekey', 'created', 'summary'). Qui si costruisce il dizionario
// etichetta -> identificativo usando prima le colonne configurate nel filtro e poi
// l'elenco completo dei campi del sito Jira (che li restituisce già in italiano).
async function costruisciDizionarioCampi(session, colonneFiltro) {
  const dizionario = new Map();
  const aggiungi = (chiave, valore) => {
    const k = norm(chiave);
    if (k && valore && !dizionario.has(k)) dizionario.set(k, valore);
  };

  // Priorità alle colonne del filtro: sono quelle che l'utente vede nel report.
  for (const c of colonneFiltro) {
    aggiungi(c.label, c.value);
    aggiungi(c.value, c.value);
  }

  // Rete di sicurezza: un campo mappato ma non presente fra le colonne del filtro
  // resta comunque leggibile se esiste sul sito Jira.
  try {
    const campi = await jiraApi(session, '/rest/api/3/field');
    for (const f of campi || []) {
      aggiungi(f.name, f.id);
      aggiungi(f.id, f.id);
      for (const alias of f.clauseNames || []) aggiungi(alias, f.id);
    }
  } catch (e) {
    console.warn('[SYNC JIRA] Elenco campi non disponibile:', e.message);
  }

  // La chiave dell'issue non è un campo richiedibile via API: si legge da issue.key.
  for (const alias of ['chiave', 'key', 'issuekey', 'chiave ticket']) {
    dizionario.set(alias, 'issuekey');
  }

  return dizionario;
}

// ----------------------------------------------------------------------------
// LETTURA DEL REPORT JIRA
// ----------------------------------------------------------------------------

async function eseguiFiltro(session, jql, campi) {
  const issues = [];
  let token = null;

  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    let data;
    try {
      data = await jiraApi(session, '/rest/api/3/search/jql', {
        method: 'POST',
        body: { jql, maxResults: PAGE_SIZE, fields: campi, ...(token ? { nextPageToken: token } : {}) }
      });
    } catch (e) {
      // Jira rifiuta l'elenco dei campi (campo non più esistente): si ripiega su
      // tutti i campi navigabili, così la mappatura resta comunque risolvibile.
      if (e.jiraStatus !== 400 || campi.length === 1) throw e;
      console.warn('[SYNC JIRA] Campi rifiutati da Jira, riprovo con *navigable:', e.message);
      campi = ['*navigable'];
      pagina -= 1;
      continue;
    }
    issues.push(...(data.issues || []));
    token = data.nextPageToken || null;
    if (!token) break;
  }

  return issues;
}

// ----------------------------------------------------------------------------
// CLIENTI
// ----------------------------------------------------------------------------

// Clienti con il nome Jira valorizzato. In clients il collegamento al cliente è
// la colonna "argument" (contiene l'id della riga identità del cliente), che è
// esattamente il client_id da scrivere sulla tabella di destinazione.
async function leggiClienti(tenantId, userId, campo) {
  const { rows } = await db.query(
    `SELECT argument, valore2 FROM clients
      WHERE tenant_id = $1 AND user_id = $2 AND lower(campo) = lower($3)`,
    [tenantId, userId, campo]
  );
  return rows
    .filter((r) => !vuoto(r.argument) && !vuoto(r.valore2) && norm(r.valore2) !== 'null')
    .map((r) => ({ clientId: String(r.argument), nome: String(r.valore2).trim(), chiave: norm(r.valore2) }))
    // Nel confronto "contenuto in" vince il nome più lungo: è il più specifico.
    .sort((a, b) => b.chiave.length - a.chiave.length);
}

function trovaCliente(clienti, valoreJira, modo) {
  const v = norm(valoreJira);
  if (!v) return null;
  if (modo === 'contains') return clienti.find((c) => v.includes(c.chiave)) || null;
  return clienti.find((c) => c.chiave === v) || null;
}

// ----------------------------------------------------------------------------
// RIGHE GIÀ PRESENTI SULLA TABELLA DI DESTINAZIONE
// ----------------------------------------------------------------------------

// Indicizzate per cliente + codice: lo stesso codice su clienti diversi è una riga
// diversa (perimetro concordato: tenant + utente + cliente).
function chiaveRiga(clientId, codice) {
  return `${String(clientId)}|${norm(codice)}`;
}

async function leggiEsistenti(tabella, colonnaCodice, tenantId, userId) {
  const { rows } = await db.query(
    `SELECT id, client_id, "${colonnaCodice}" AS codice, scadenza FROM "${tabella}"
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId]
  );
  const map = new Map();
  for (const r of rows) {
    if (vuoto(r.client_id) || vuoto(r.codice)) continue;
    const k = chiaveRiga(r.client_id, r.codice);
    if (!map.has(k)) map.set(k, { id: r.id, scadenza: r.scadenza });
  }
  return map;
}

// La riga è ancora aggiornabile se la scadenza è successiva a oggi.
// Una scadenza assente vale "senza limite": è il caso delle righe caricate prima
// che la colonna avesse il default '2099-12-31'.
function ancoraValida(scadenza) {
  if (scadenza === null || scadenza === undefined) return true;
  const d = scadenza instanceof Date ? scadenza : new Date(scadenza);
  if (Number.isNaN(d.getTime())) return true;
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);
  return d.getTime() > oggi.getTime();
}

// ----------------------------------------------------------------------------
// SCRITTURA
// ----------------------------------------------------------------------------

async function inserisci(tabella, valori) {
  const { data } = await encryptRowForWrite(db, tabella, valori, { dbKey: 'main' });
  const cols = Object.keys(data);
  await db.query(
    `INSERT INTO "${tabella}" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => data[c])
  );
}

async function aggiorna(tabella, id, valori) {
  const { data } = await encryptRowForWrite(db, tabella, valori, { id, dbKey: 'main' });
  const cols = Object.keys(data);
  if (cols.length === 0) return;
  await db.query(
    `UPDATE "${tabella}" SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
      WHERE id = $${cols.length + 1}`,
    [...cols.map((c) => data[c]), id]
  );
}

// ----------------------------------------------------------------------------
// PROGRAMMA
// ----------------------------------------------------------------------------

/**
 * Esegue una sincronizzazione Jira -> Projexa.
 *
 * @param {object} config
 *   nome              etichetta del programma (finisce nel report e nei log)
 *   tabellaMappatura  'jira_quotazioni' | 'jira_task'
 *   tabellaDestinazione 'cl_quotazioni' | 'task_app'
 *   colonnaCodice     colonna Projexa che identifica la riga ('codice' | 'cod_task')
 *   campoCliente      valore di colonna_projexa che indica la colonna Jira del cliente
 *   campoClienteAlt   valore alternativo, usato se il primo non è configurato
 *   campoClients      clients.campo che contiene il nome del cliente su Jira
 *   confrontoCliente  'exact' (uguaglianza) | 'contains' (nome contenuto nel testo)
 *   colonneUrl        colonne di destinazione da valorizzare con il link all'issue
 *   valoriInserimento valori fissi scritti solo alla creazione della riga (es.
 *                     { tipo: 'Jira' }): marcano l'origine del dato e NON vengono
 *                     riscritti negli aggiornamenti successivi, così una eventuale
 *                     modifica manuale resta
 * @param {object} ctx  { tenantId, userId, dryRun }
 *   dryRun = true: elabora tutto e produce il report SENZA scrivere sul database.
 *   Serve a verificare mappatura e abbinamenti prima di far girare il programma
 *   per davvero (da riga di comando: opzione --dry).
 * @returns {Promise<object>} report dell'elaborazione
 */
export async function runJiraSync(config, ctx) {
  const { tenantId, userId } = ctx || {};
  const dryRun = !!(ctx && ctx.dryRun);
  const report = {
    programma: config.nome,
    dryRun,
    filtro: null,
    righeJira: 0,
    clientiConfigurati: 0,
    inserite: 0,
    aggiornate: 0,
    ignorateSenzaCliente: 0,
    ignorateSenzaCodice: 0,
    ignorateScadute: 0,
    colonneIgnorate: [],
    mappatureNonRisolte: [],
    errori: []
  };

  if (!tenantId || !userId) throw new Error('Contesto mancante: tenant_id / user_id');
  if (!TABELLE_MAPPATURA.has(config.tabellaMappatura)) throw new Error(`Tabella di mappatura non ammessa: ${config.tabellaMappatura}`);
  if (!TABELLE_DESTINAZIONE.has(config.tabellaDestinazione)) throw new Error(`Tabella di destinazione non ammessa: ${config.tabellaDestinazione}`);

  if (!(await isJiraEnabled({ tenant_id: tenantId, user_id: userId }))) {
    const err = new Error('Integrazione Jira non abilitata nelle impostazioni');
    err.code = 'JIRA_DISABLED';
    err.status = 403;
    throw err;
  }

  // --- 1) Mappatura ---------------------------------------------------------
  const mappatura = await leggiMappatura(config.tabellaMappatura, tenantId, userId);
  if (mappatura.length === 0) {
    throw new Error(`Nessuna mappatura configurata in ${config.tabellaMappatura} per questo utente`);
  }

  const rigaFiltro = mappatura.find((m) => norm(m.projexa) === CAMPO_FILTRO);
  if (!rigaFiltro) {
    throw new Error(`Manca la riga colonna_projexa = 'Nome_Filtro' in ${config.tabellaMappatura}`);
  }
  const nomeFiltro = rigaFiltro.jira;

  // Colonna Jira che contiene il nome del cliente.
  const rigaCliente =
    mappatura.find((m) => norm(m.projexa) === norm(config.campoCliente)) ||
    (config.campoClienteAlt ? mappatura.find((m) => norm(m.projexa) === norm(config.campoClienteAlt)) : null);
  if (!rigaCliente) {
    throw new Error(`Manca la riga colonna_projexa = '${config.campoCliente}' in ${config.tabellaMappatura}: senza non si può abbinare il cliente`);
  }

  const rigaCodice = mappatura.find((m) => norm(m.projexa) === norm(config.colonnaCodice));
  if (!rigaCodice) {
    throw new Error(`Manca la riga colonna_projexa = '${config.colonnaCodice}' in ${config.tabellaMappatura}`);
  }

  // --- 2) Filtro Jira -------------------------------------------------------
  const session = await getJiraSession(userId);
  const filtri = await listFilters(session);
  const filtro = filtri.find((f) => norm(f.name) === norm(nomeFiltro));
  if (!filtro) {
    throw new Error(`Filtro Jira "${nomeFiltro}" non trovato fra i filtri salvati dell'account collegato`);
  }
  report.filtro = filtro.name;

  const dettaglio = await loadFilter(session, filtro.id);
  const dizionario = await costruisciDizionarioCampi(session, dettaglio.columns);

  // Colonne di destinazione realmente esistenti sulla tabella Projexa.
  const colonne = await colonneDestinazione(config.tabellaDestinazione);
  const colonneUrl = new Set(config.colonneUrl || []);

  // Piano di scrittura: una voce per ogni riga di mappatura utilizzabile.
  const piano = [];
  for (const m of mappatura) {
    if (norm(m.projexa) === CAMPO_FILTRO) continue;
    const campoJira = dizionario.get(norm(m.jira));
    if (!campoJira) {
      report.mappatureNonRisolte.push(`${m.projexa} <- "${m.jira}" (colonna non trovata su Jira)`);
      continue;
    }
    if (!colonne.has(m.projexa)) {
      // Non è un errore: es. 'Nome_cliente' serve solo per abbinare il cliente.
      if (norm(m.projexa) !== norm(rigaCliente.projexa)) {
        report.colonneIgnorate.push(`${m.projexa} (non esiste in ${config.tabellaDestinazione})`);
      }
      continue;
    }
    if (COLONNE_DI_CONTESTO.has(m.projexa)) continue;
    piano.push({ colonna: m.projexa, tipo: colonne.get(m.projexa), campoJira, url: colonneUrl.has(m.projexa) });
  }

  // Campo Jira da cui leggere il nome del cliente (può non essere una colonna Projexa).
  const campoJiraCliente = dizionario.get(norm(rigaCliente.jira));
  if (!campoJiraCliente) {
    throw new Error(`La colonna Jira "${rigaCliente.jira}" (nome cliente) non esiste sul sito Jira collegato`);
  }
  const campoJiraCodice = dizionario.get(norm(rigaCodice.jira));
  if (!campoJiraCodice) {
    throw new Error(`La colonna Jira "${rigaCodice.jira}" (${config.colonnaCodice}) non esiste sul sito Jira collegato`);
  }

  // --- 3) Esecuzione del filtro --------------------------------------------
  const campiRichiesti = [...new Set([...piano.map((p) => p.campoJira), campoJiraCliente, campoJiraCodice])]
    .filter((f) => f !== 'issuekey');
  const issues = await eseguiFiltro(session, dettaglio.jql, campiRichiesti.length ? campiRichiesti : ['summary']);
  report.righeJira = issues.length;

  // --- 4) Clienti e righe già presenti -------------------------------------
  const clienti = await leggiClienti(tenantId, userId, config.campoClients);
  report.clientiConfigurati = clienti.length;
  if (clienti.length === 0) {
    report.errori.push(`Nessun cliente ha il campo "${config.campoClients}" valorizzato: nessuna riga da elaborare`);
    return report;
  }

  const esistenti = await leggiEsistenti(config.tabellaDestinazione, config.colonnaCodice, tenantId, userId);
  const haUpdatedAt = colonne.has('updated_at');

  // Valori fissi della creazione (es. tipo = 'Jira'): solo colonne che esistono
  // davvero e che non sono già valorizzate dalla mappatura.
  const valoriInserimento = {};
  for (const [colonna, valore] of Object.entries(config.valoriInserimento || {})) {
    if (!colonne.has(colonna)) {
      report.colonneIgnorate.push(`${colonna} (valore fisso: non esiste in ${config.tabellaDestinazione})`);
      continue;
    }
    if (piano.some((p) => p.colonna === colonna)) continue; // vince la mappatura
    valoriInserimento[colonna] = valore;
  }

  // --- 5) Elaborazione riga per riga ---------------------------------------
  const leggi = (issue, campo) => (campo === 'issuekey' ? issue.key : (issue.fields || {})[campo]);

  for (const issue of issues) {
    try {
      const cliente = trovaCliente(clienti, formatValue(leggi(issue, campoJiraCliente)), config.confrontoCliente);
      if (!cliente) { report.ignorateSenzaCliente += 1; continue; }

      const codice = formatValue(leggi(issue, campoJiraCodice));
      if (vuoto(codice)) { report.ignorateSenzaCodice += 1; continue; }

      // Valori da scrivere, convertiti nel tipo della colonna di destinazione.
      const valori = {};
      for (const p of piano) {
        const raw = leggi(issue, p.campoJira);
        valori[p.colonna] = p.url
          ? (session.siteUrl && issue.key ? `${session.siteUrl}/browse/${issue.key}` : coerce(raw, p.tipo))
          : coerce(raw, p.tipo);
      }

      // In prova a vuoto si tiene da parte la prima riga elaborata: serve a
      // controllare a colpo d'occhio che la mappatura produca i valori attesi.
      if (dryRun && !report.esempio) {
        report.esempio = {
          _clienteAbbinato: cliente.nome,
          _clientId: cliente.clientId,
          [config.colonnaCodice]: codice,
          ...valoriInserimento,
          ...valori
        };
      }

      const esistente = esistenti.get(chiaveRiga(cliente.clientId, codice));

      if (!esistente) {
        if (!dryRun) {
          await inserisci(config.tabellaDestinazione, {
            tenant_id: tenantId,
            user_id: userId,
            client_id: cliente.clientId,
            ...valoriInserimento,
            ...valori
          });
        }
        // Evita un doppio inserimento se il filtro Jira contiene la stessa chiave
        // su più righe (capita con i filtri che espandono i sotto-task).
        esistenti.set(chiaveRiga(cliente.clientId, codice), { id: null, scadenza: null });
        report.inserite += 1;
        continue;
      }

      if (!ancoraValida(esistente.scadenza)) { report.ignorateScadute += 1; continue; }
      if (!esistente.id) continue; // riga appena inserita in questo stesso giro

      const daAggiornare = { ...valori };
      delete daAggiornare[config.colonnaCodice]; // il codice è la chiave: non si tocca
      if (haUpdatedAt) daAggiornare.updated_at = new Date();
      if (!dryRun) await aggiorna(config.tabellaDestinazione, esistente.id, daAggiornare);
      report.aggiornate += 1;
    } catch (e) {
      report.errori.push(`${issue.key || '?'}: ${e.message}`);
      if (report.errori.length >= 20) {
        report.errori.push('… ulteriori errori non elencati');
        break;
      }
    }
  }

  console.log(
    `[${config.nome}]${dryRun ? ' (PROVA, nessuna scrittura)' : ''} filtro "${report.filtro}": ${report.righeJira} righe Jira, ` +
    `${report.inserite} inserite, ${report.aggiornate} aggiornate, ` +
    `${report.ignorateSenzaCliente} senza cliente, ${report.ignorateScadute} scadute`
  );

  return report;
}

export { norm, toDate, toNumber, coerce, trovaCliente, ancoraValida, chiaveRiga };
