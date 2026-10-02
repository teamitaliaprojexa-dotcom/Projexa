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
//   3. UPDATE per solo codice (chiave Jira = colonna codice): tutte le righe del
//      tenant con quel codice, di qualunque cliente o senza cliente, se ancora
//      valide (scadenza > oggi) e solo nelle colonne cambiate; scadute = non si toccano.
//   4. INSERT: si cerca il cliente (colonna Jira del nome cliente confrontata con
//      clients.valore2); se il codice non esiste per quel cliente -> INSERT.
//      Senza cliente corrispondente non si inserisce nulla.
//
// PERIMETRO: un lancio aggiorna i dati di TUTTO il tenant in un solo passaggio.
//   * Configurazione di UN utente: mappatura (jira_*), filtro, filtro aggiuntivo e
//     account Jira (token) sono quelli dell'utente indicato (userId).
//   * Dati di TUTTO il tenant: i ticket vengono abbinati ai clienti di tutti gli
//     utenti del tenant e le righe già presenti si cercano su tutto il tenant. Le
//     righe nuove sono intestate al proprietario del cliente, così le vede nelle sue
//     griglie.
// runJiraSyncTenant (pulsante e schedulatore) sceglie di chi usare la configurazione:
// chi lancia, se l'ha, altrimenti un altro utente del tenant configurato.
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

const PAGE_SIZE = 100;

// Tetto di sicurezza alla lettura di un filtro: oltre questo numero di pagine il
// programma si ferma e lo SEGNALA nel report (meglio un avviso che credere di aver
// letto tutto). Ogni pagina è una chiamata API, quindi il limite è anche il freno
// alla durata del programma: 500 pagine = 50.000 righe.
// Regolabile senza toccare il codice con la variabile d'ambiente JIRA_SYNC_MAX_PAGINE.
const MAX_PAGINE = Math.max(1, Number(process.env.JIRA_SYNC_MAX_PAGINE) || 500);

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

// Restituisce { righe, troncato }: "troncato" avvisa che il filtro ha più risultati
// del limite di sicurezza (MAX_PAGINE x PAGE_SIZE) e che quindi NON è stato letto
// per intero. Meglio dirlo nel report che lasciar credere a una lettura completa.
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

  return { righe: issues, troncato: !!token };
}

// ----------------------------------------------------------------------------
// CLIENTI
// ----------------------------------------------------------------------------

// Clienti di TUTTO il tenant con il nome Jira valorizzato. In clients il collegamento
// al cliente è la colonna "argument" (contiene l'id della riga identità del cliente),
// che è esattamente il client_id da scrivere sulla tabella di destinazione; user_id è
// il proprietario del cliente, a cui si intestano le righe nuove.
async function leggiClienti(tenantId, campo) {
  const { rows } = await db.query(
    `SELECT argument, valore2, user_id FROM clients
      WHERE tenant_id = $1 AND lower(campo) = lower($2)`,
    [tenantId, campo]
  );
  return rows
    .filter((r) => !vuoto(r.argument) && !vuoto(r.valore2) && norm(r.valore2) !== 'null')
    .map((r) => ({ clientId: String(r.argument), userId: r.user_id, nome: String(r.valore2).trim(), chiave: norm(r.valore2) }))
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

// Il codice si indicizza in due modi, perché i due passaggi cercano le righe in
// modo diverso:
//
//   perChiave  cliente + codice -> riga.  Decide l'INSERIMENTO nel passaggio
//              principale: lo stesso codice su clienti diversi è una riga diversa
//              (perimetro: tenant + cliente, qualunque sia l'utente proprietario).
//   perCodice  codice -> tutte le righe con quel codice, cliente compreso quello
//              vuoto. Lo usano gli AGGIORNAMENTI di entrambi i passaggi, per solo
//              codice Jira: una riga inserita a mano o legata a un altro cliente
//              riceve comunque i valori aggiornati.
function chiaveRiga(clientId, codice) {
  return `${String(clientId)}|${norm(codice)}`;
}

// Righe già presenti di TUTTO il tenant (di qualunque utente), con i valori attuali
// (già decifrati dal pool) delle colonne che il job scrive: servono a non riscrivere
// le righe in cui Jira non ha cambiato nulla (vedi campiCambiati).
async function leggiEsistenti(tabella, colonnaCodice, tenantId, colonneConfronto) {
  const extra = colonneConfronto.map((c, i) => `, "${c}" AS "v${i}"`).join('');
  const { rows } = await db.query(
    `SELECT id, client_id, "${colonnaCodice}" AS codice, scadenza${extra} FROM "${tabella}"
      WHERE tenant_id = $1`,
    [tenantId]
  );
  const perChiave = new Map();
  const perCodice = new Map();
  for (const r of rows) {
    if (vuoto(r.codice)) continue;
    // Stesso oggetto nei due indici: aggiornarlo da una parte lo aggiorna anche
    // dall'altra (serve dopo un inserimento, per non reinserire la stessa riga).
    const valori = {};
    colonneConfronto.forEach((c, i) => { valori[c] = r[`v${i}`]; });
    const riga = { id: r.id, scadenza: r.scadenza, valori };
    const codice = norm(r.codice);
    if (!perCodice.has(codice)) perCodice.set(codice, []);
    perCodice.get(codice).push(riga);
    if (!vuoto(r.client_id)) {
      const k = chiaveRiga(r.client_id, r.codice);
      if (!perChiave.has(k)) perChiave.set(k, riga);
    }
  }
  return { perChiave, perCodice };
}

// Confronto fra il valore sul database e quello che arriva da Jira, nel tipo della
// colonna. Senza questo controllo ogni giro riscriveva tutte le righe: i testi cifrati
// cambiano a ogni scrittura (IV casuale) e il log variazioni registrava migliaia di
// modifiche "finte". Vuoto e null valgono uguale; un valore rimasto cifrato (chiave
// non disponibile) risulta diverso e la riga viene riscritta, come prima.
function confrontabile(valore, tipo) {
  if (valore === null || valore === undefined) return null;
  if (tipo === 'date') return String(valore).slice(0, 10);
  if (tipo.startsWith('timestamp')) {
    // Il job scrive 'YYYY-MM-DD' (mezzanotte): una data-ora a mezzanotte equivale al giorno.
    if (typeof valore === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valore)) return valore;
    const d = valore instanceof Date ? valore : new Date(valore);
    if (Number.isNaN(d.getTime())) return String(valore);
    const giorno = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return d.getHours() || d.getMinutes() || d.getSeconds() || d.getMilliseconds() ? d.toISOString() : giorno;
  }
  if (/^(numeric|integer|smallint|bigint|real|double precision)/.test(tipo)) {
    const n = Number(valore);
    return Number.isFinite(n) ? n : String(valore);
  }
  if (tipo === 'boolean') return valore === true || valore === 't' || valore === 'true';
  const t = String(valore);
  return t.trim() === '' ? null : t;
}

// Colonne da scrivere: solo quelle con un valore diverso da quello già presente.
function campiCambiati(attuali, nuovi, tipi) {
  const out = {};
  for (const [colonna, valore] of Object.entries(nuovi)) {
    const tipo = tipi.get(colonna) || 'text';
    if (confrontabile(attuali ? attuali[colonna] : undefined, tipo) !== confrontabile(valore, tipo)) out[colonna] = valore;
  }
  return out;
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
// FILTRO AGGIUNTIVO (SOLO AGGIORNAMENTO)
// ----------------------------------------------------------------------------

// Oltre al filtro principale, l'utente può indicare in Impostazioni -> Integrazioni
// un secondo filtro Jira da usare SOLO per aggiornare righe già presenti: serve a
// riportare su Projexa i cambiamenti di ticket che il filtro principale non estrae
// più (es. quelli chiusi). Il campo è di tipo 14 (interruttore + testo): il nome del
// filtro sta in valore2 e, quando l'interruttore è spento, l'interfaccia lo svuota.
// Qui basta quindi guardare valore2: se è vuoto, il passaggio aggiuntivo non si fa.
async function leggiFiltroAggiuntivo(tenantId, userId, campo) {
  if (!campo) return '';
  const { rows } = await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2 AND tipo_valore::text = '14' AND lower(campo) = lower($3)
      LIMIT 1`,
    [tenantId, userId, campo]
  );
  const valore = rows[0] ? rows[0].valore2 : null;
  if (vuoto(valore) || norm(valore) === 'null') return '';
  return String(valore).trim();
}

// ----------------------------------------------------------------------------
// SCRITTURA
// ----------------------------------------------------------------------------

// Restituisce l'id della riga creata: serve a poterla aggiornare subito dopo, se
// la stessa chiave ricompare (filtro con righe ripetute o passaggio aggiuntivo).
async function inserisci(tabella, valori) {
  const { data } = await encryptRowForWrite(db, tabella, valori, { dbKey: 'main' });
  const cols = Object.keys(data);
  const result = await db.query(
    `INSERT INTO "${tabella}" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    cols.map((c) => data[c])
  );
  return result.rows[0] ? result.rows[0].id : null;
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
 *   campoFiltroAggiuntivo
 *                     settings.campo (tipo_valore 14) che contiene, in valore2, il
 *                     nome di un secondo filtro Jira usato SOLO per aggiornare righe
 *                     già presenti. Se il campo è vuoto il passaggio non viene fatto.
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
    // Righe già presenti in cui Jira non ha cambiato nulla: non vengono riscritte.
    invariate: 0,
    ignorateSenzaCliente: 0,
    ignorateSenzaCodice: 0,
    ignorateScadute: 0,
    troncato: false,
    colonneIgnorate: [],
    mappatureNonRisolte: [],
    errori: [],
    // Valorizzato solo se in Impostazioni è configurato un filtro aggiuntivo.
    passaggioAggiuntivo: null
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
  const esito = await eseguiFiltro(session, dettaglio.jql, campiRichiesti.length ? campiRichiesti : ['summary']);
  const issues = esito.righe;
  report.righeJira = issues.length;
  report.troncato = esito.troncato;
  if (esito.troncato) {
    report.errori.push(`Il filtro "${filtro.name}" ha più di ${MAX_PAGINE * PAGE_SIZE} risultati: lette solo le prime ${issues.length} righe. Restringi il filtro su Jira.`);
  }

  // --- 4) Clienti e righe già presenti -------------------------------------
  // Senza clienti configurati il passaggio principale non inserisce nulla, ma aggiorna
  // comunque per solo codice (come il passaggio aggiuntivo).
  const clienti = await leggiClienti(tenantId, config.campoClients);
  report.clientiConfigurati = clienti.length;
  if (clienti.length === 0) {
    report.errori.push(`Nessun cliente ha il campo "${config.campoClients}" valorizzato: il filtro principale non inserisce righe nuove (aggiorna solo quelle già presenti, per codice)`);
  }

  const colonneConfronto = [...new Set(piano.map((p) => p.colonna))].filter((c) => c !== config.colonnaCodice);
  const { perChiave, perCodice } = await leggiEsistenti(config.tabellaDestinazione, config.colonnaCodice, tenantId, colonneConfronto);
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

  // Valori da scrivere per una riga del report Jira, convertiti nel tipo della
  // colonna Projexa di destinazione.
  function valoriDaIssue(issue) {
    const valori = {};
    for (const p of piano) {
      const raw = leggi(issue, p.campoJira);
      valori[p.colonna] = p.url
        ? (session.siteUrl && issue.key ? `${session.siteUrl}/browse/${issue.key}` : coerce(raw, p.tipo))
        : coerce(raw, p.tipo);
    }
    return valori;
  }

  // Aggiorna una riga già presente scrivendo solo le colonne cambiate. Il codice non
  // si tocca: è la chiave. Restituisce false se non c'era niente da cambiare (riga non
  // toccata, updated_at compreso): conta come "invariata" nel report.
  async function aggiornaRiga(riga, valori) {
    const nuovi = { ...valori };
    delete nuovi[config.colonnaCodice];
    const daAggiornare = campiCambiati(riga.valori, nuovi, colonne);
    if (Object.keys(daAggiornare).length === 0) return false;
    // Valori in memoria allineati: se la stessa riga ricompare nel giro (righe ripetute
    // o passaggio aggiuntivo) con gli stessi dati, non viene riscritta.
    riga.valori = { ...(riga.valori || {}), ...daAggiornare };
    if (haUpdatedAt) daAggiornare.updated_at = new Date();
    // In prova a vuoto non si scrive: si conta solo l'aggiornamento che verrebbe
    // fatto (riga.id è null per le righe "inserite" durante la simulazione).
    if (!dryRun && riga.id) await aggiorna(config.tabellaDestinazione, riga.id, daAggiornare);
    return true;
  }

  // PASSAGGIO PRINCIPALE.
  //   AGGIORNAMENTO: a parità di codice (chiave Jira = colonnaCodice), SENZA guardare
  //   il cliente: si aggiornano tutte le righe del tenant con quel codice, anche se
  //   sono di un altro cliente o di nessuno (richiesta dell'utente, 2026-10-02).
  //   INSERIMENTO: invariato. Serve il cliente abbinato e si inserisce solo se per quel
  //   cliente la riga con quel codice non c'è ancora (perimetro cliente + codice).
  async function elaboraPrincipale(righe, conteggi) {
    for (const issue of righe) {
      try {
        const codice = formatValue(leggi(issue, campoJiraCodice));
        if (vuoto(codice)) { conteggi.ignorateSenzaCodice += 1; continue; }

        const cliente = trovaCliente(clienti, formatValue(leggi(issue, campoJiraCliente)), config.confrontoCliente);
        const valori = valoriDaIssue(issue);

        // In prova a vuoto si tiene da parte la prima riga elaborata: serve a
        // controllare a colpo d'occhio che la mappatura produca i valori attesi.
        if (dryRun && !report.esempio) {
          report.esempio = {
            _clienteAbbinato: cliente ? cliente.nome : null,
            _clientId: cliente ? cliente.clientId : null,
            [config.colonnaCodice]: codice,
            ...valoriInserimento,
            ...valori
          };
        }

        // Aggiornamento per solo codice (copia dell'elenco: la riga eventualmente
        // inserita qui sotto non va aggiornata subito dopo).
        const daAggiornare = [...(perCodice.get(norm(codice)) || [])];
        for (const riga of daAggiornare) {
          if (!ancoraValida(riga.scadenza)) { conteggi.ignorateScadute += 1; continue; }
          if (await aggiornaRiga(riga, valori)) conteggi.aggiornate += 1;
          else conteggi.invariate += 1;
        }

        // Inserimento: solo con il cliente abbinato. "Senza cliente" conta le righe Jira
        // che non hanno né un cliente né una riga già presente da aggiornare.
        if (!cliente) {
          if (daAggiornare.length === 0) conteggi.ignorateSenzaCliente += 1;
          continue;
        }
        const chiave = chiaveRiga(cliente.clientId, codice);
        const esistente = perChiave.get(chiave);

        if (!esistente) {
          const nuovoId = dryRun ? null : await inserisci(config.tabellaDestinazione, {
            tenant_id: tenantId,
            // Intestata al proprietario del cliente: è lui che la vede in griglia.
            user_id: cliente.userId || userId,
            client_id: cliente.clientId,
            ...valoriInserimento,
            ...valori
          });
          // La riga appena creata entra subito nei due indici: se lo stesso codice
          // ricompare (filtro con righe ripetute, oppure passaggio aggiuntivo)
          // viene aggiornata invece di essere inserita una seconda volta.
          const riga = { id: nuovoId, scadenza: null, valori: { ...valoriInserimento, ...valori } };
          perChiave.set(chiave, riga);
          const perQuelCodice = perCodice.get(norm(codice)) || [];
          perQuelCodice.push(riga);
          perCodice.set(norm(codice), perQuelCodice);
          conteggi.inserite += 1;
        }
        // Riga già presente per questo cliente: è fra quelle aggiornate sopra per codice.
      } catch (e) {
        report.errori.push(`${issue.key || '?'}: ${e.message}`);
        if (report.errori.length >= 20) {
          report.errori.push('… ulteriori errori non elencati');
          return;
        }
      }
    }
  }

  // PASSAGGIO AGGIUNTIVO: NON guarda il cliente. Il suo unico scopo è rinfrescare
  // le righe già presenti a parità di codice Jira, ovunque siano: se un codice è
  // stato inserito a mano e non è legato ad alcun cliente, viene aggiornato lo
  // stesso. Non crea mai righe nuove.
  async function elaboraAggiuntivo(righe, conteggi) {
    for (const issue of righe) {
      try {
        const codice = formatValue(leggi(issue, campoJiraCodice));
        if (vuoto(codice)) { conteggi.ignorateSenzaCodice += 1; continue; }

        const daRinfrescare = perCodice.get(norm(codice));
        if (!daRinfrescare || daRinfrescare.length === 0) { conteggi.ignorateNonTrovate += 1; continue; }

        const valori = valoriDaIssue(issue);
        // Lo stesso codice può esistere su più righe (clienti o progetti diversi):
        // il filtro le rinfresca tutte.
        for (const riga of daRinfrescare) {
          if (!ancoraValida(riga.scadenza)) { conteggi.ignorateScadute += 1; continue; }
          if (await aggiornaRiga(riga, valori)) conteggi.aggiornate += 1;
          else conteggi.invariate += 1;
        }
      } catch (e) {
        report.errori.push(`${issue.key || '?'}: ${e.message}`);
        if (report.errori.length >= 20) {
          report.errori.push('… ulteriori errori non elencati');
          return;
        }
      }
    }
  }

  await elaboraPrincipale(issues, report);

  // --- 6) Passaggio aggiuntivo (solo aggiornamento) ------------------------
  const nomeFiltroAggiuntivo = await leggiFiltroAggiuntivo(tenantId, userId, config.campoFiltroAggiuntivo);
  if (nomeFiltroAggiuntivo) {
    const filtroAgg = filtri.find((f) => norm(f.name) === norm(nomeFiltroAggiuntivo));
    if (!filtroAgg) {
      report.errori.push(`Filtro aggiuntivo "${nomeFiltroAggiuntivo}" non trovato fra i filtri salvati: passaggio saltato`);
    } else {
      const conteggi = {
        filtro: filtroAgg.name,
        righeJira: 0,
        aggiornate: 0,
        invariate: 0,
        ignorateSenzaCodice: 0,
        ignorateScadute: 0,
        ignorateNonTrovate: 0
      };
      // Stessa mappatura e stessi campi del filtro principale: cambia solo la JQL.
      const esitoAgg = await eseguiFiltro(
        session,
        filtroAgg.jql,
        campiRichiesti.length ? campiRichiesti : ['summary']
      );
      conteggi.righeJira = esitoAgg.righe.length;
      conteggi.troncato = esitoAgg.troncato;
      if (esitoAgg.troncato) {
        report.errori.push(`Il filtro aggiuntivo "${filtroAgg.name}" ha più di ${MAX_PAGINE * PAGE_SIZE} risultati: lette solo le prime ${esitoAgg.righe.length} righe. Restringi il filtro su Jira.`);
      }
      await elaboraAggiuntivo(esitoAgg.righe, conteggi);
      report.passaggioAggiuntivo = conteggi;
    }
  }

  console.log(
    `[${config.nome}]${dryRun ? ' (PROVA, nessuna scrittura)' : ''} filtro "${report.filtro}": ${report.righeJira} righe Jira, ` +
    `${report.inserite} inserite, ${report.aggiornate} aggiornate, ${report.invariate} invariate, ` +
    `${report.ignorateSenzaCliente} senza cliente, ${report.ignorateScadute} scadute` +
    (report.passaggioAggiuntivo
      ? ` | aggiuntivo "${report.passaggioAggiuntivo.filtro}": ${report.passaggioAggiuntivo.righeJira} righe, ` +
        `${report.passaggioAggiuntivo.aggiornate} aggiornate, ${report.passaggioAggiuntivo.invariate} invariate, ${report.passaggioAggiuntivo.ignorateNonTrovate} non presenti`
      : '')
  );

  return report;
}

// ----------------------------------------------------------------------------
// ESECUZIONE PER TUTTO IL TENANT
// ----------------------------------------------------------------------------

// Utenti del tenant che hanno una mappatura configurata per il programma: sono
// quelli di cui si può usare la configurazione (mappatura + account Jira).
async function utentiConMappatura(tabella, tenantId) {
  const { rows } = await db.query(
    `SELECT DISTINCT user_id FROM "${tabella}" WHERE tenant_id = $1 AND user_id IS NOT NULL`,
    [tenantId]
  );
  const ids = rows.map((r) => String(r.user_id));
  if (ids.length === 0) return [];

  // Nome e cognome solo per rendere leggibile il riepilogo: se la lettura fallisce
  // si mostra l'id, la sincronizzazione va avanti lo stesso.
  const nomi = new Map();
  try {
    const u = await db.query('SELECT id, name, cognome FROM users WHERE id = ANY($1::uuid[])', [ids]);
    for (const r of u.rows) {
      const nome = [r.name, r.cognome].filter((x) => !vuoto(x)).join(' ');
      if (nome) nomi.set(String(r.id), nome);
    }
  } catch (e) {
    console.warn('[SYNC JIRA] Nomi utenti non disponibili:', e.message);
  }
  return ids.map((id) => ({ userId: id, nome: nomi.get(id) || id }));
}

// Errori che vuol dire "la configurazione di questo utente non è utilizzabile" (Jira
// disattivato o account non collegato), da distinguere dai veri errori.
const CODICI_SALTATO = new Set(['JIRA_DISABLED', 'JIRA_NOT_CONNECTED', 'JIRA_REAUTH_REQUIRED']);

/**
 * Aggiorna i dati di TUTTO il tenant con UN SOLO passaggio (runJiraSync), usando la
 * configurazione Jira di un utente del tenant:
 *   1. quella di ctx.utentePreferito (chi ha premuto il pulsante), se ha una mappatura;
 *   2. altrimenti, o se la sua non è utilizzabile (Jira scollegato, token scaduto,
 *      filtro inesistente...), quella di un altro utente del tenant con una mappatura.
 * Ci si ferma al primo utente con cui il passaggio riesce: i dati non vengono mai
 * elaborati due volte. Le configurazioni scartate restano nel report (utenti[]) con il
 * motivo, così un token scaduto si vede anche se l'aggiornamento è riuscito con un
 * altro utente. Gli errori che fanno scartare una configurazione avvengono prima di
 * qualunque scrittura, quindi il tentativo successivo riparte pulito.
 *
 * @param {object} ctx  { tenantId, utentePreferito?, dryRun }
 * @returns {Promise<object>} { programma, dryRun, configurazioneDi, utenti: [...], totali }
 */
export async function runJiraSyncTenant(config, ctx) {
  const { tenantId, utentePreferito } = ctx || {};
  const dryRun = !!(ctx && ctx.dryRun);
  if (!tenantId) throw new Error('Contesto mancante: tenant_id');
  if (!TABELLE_MAPPATURA.has(config.tabellaMappatura)) throw new Error(`Tabella di mappatura non ammessa: ${config.tabellaMappatura}`);

  const candidati = await utentiConMappatura(config.tabellaMappatura, tenantId);
  if (candidati.length === 0) {
    throw new Error(`Nessun utente del tenant ha una mappatura configurata in ${config.tabellaMappatura}`);
  }
  // Prima chi ha lanciato (se configurato), poi gli altri.
  const preferito = (u) => (String(u.userId) === String(utentePreferito) ? 1 : 0);
  candidati.sort((a, b) => preferito(b) - preferito(a));

  const risultato = {
    programma: config.nome,
    dryRun,
    configurazioneDi: null,
    utenti: [],
    totali: { righeJira: 0, inserite: 0, aggiornate: 0, invariate: 0, ignorateSenzaCliente: 0, ignorateScadute: 0 }
  };

  for (const u of candidati) {
    try {
      const report = await runJiraSync(config, { tenantId, userId: u.userId, dryRun });
      risultato.utenti.push({ userId: u.userId, nome: u.nome, ok: true, report });
      risultato.configurazioneDi = u.nome;
      for (const k of Object.keys(risultato.totali)) risultato.totali[k] += Number(report[k]) || 0;
      if (report.passaggioAggiuntivo) {
        risultato.totali.aggiornate += Number(report.passaggioAggiuntivo.aggiornate) || 0;
        risultato.totali.invariate += Number(report.passaggioAggiuntivo.invariate) || 0;
      }
      break; // un solo passaggio: tutto il tenant è già aggiornato
    } catch (e) {
      const saltato = CODICI_SALTATO.has(e.code);
      if (!saltato) console.error(`❌ ${config.nome} [configurazione di ${u.nome}]:`, e.message);
      risultato.utenti.push({ userId: u.userId, nome: u.nome, ok: false, saltato, errore: e.message, code: e.code || null });
    }
  }

  // Nessuna configurazione utilizzabile: il programma non è stato eseguito.
  if (!risultato.configurazioneDi) {
    const motivi = risultato.utenti.map((u) => `${u.nome}: ${u.errore}`).join('; ');
    throw Object.assign(new Error(`Nessuna configurazione Jira utilizzabile nel tenant (${motivi})`), { code: 'NESSUNA_CONFIGURAZIONE' });
  }
  return risultato;
}

export { norm, toDate, toNumber, coerce, trovaCliente, ancoraValida, chiaveRiga };
