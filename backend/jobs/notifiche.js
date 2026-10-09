// ============================================================================
// NOTIFICHE (campanella della dashboard) - tabelle in projexa_notif
// (Supporto/CreaDB/notifiche.sql)
// ----------------------------------------------------------------------------
// Due sorgenti:
//   1. JIRA e QLIK: nascono dal log variazioni. auditShipper.js, dopo aver inviato a Oracle
//      un blocco della coda audit_outbox, passa qui le righe "variazione": ogni riga è una
//      modifica VERA (il job Jira scrive solo le colonne cambiate, l'import Qlik non riscrive
//      le righe uguali, i cambi di sola cifratura sono già scartati), quindi nessuna notifica
//      doppia. Si tengono solo le modifiche fatte da Jira o da Qlik (origine) e solo i campi
//      previsti in notifiche_regole.
//   2. SCADENZE: job schedulato "notifiche_scadenze" (eseguiNotificheScadenze), To-Do aperte
//      con due_date domani, oggi o ieri. Una notifica per To-Do e soglia (chiave_dedup):
//      già presente e non letta -> niente; assente -> si crea; presente e letta -> torna da
//      leggere (regola dell'utente).
// Titolo e messaggio si salvano cifrati; il pool di projexa_notif li decifra in lettura.
// ============================================================================
import db from '../config/database.js';
import notifDb from '../config/notifDatabase.js';
import { decryptDeep, encryptValue } from '../config/crypto.js';

// Origine della modifica (log variazioni) -> fonte della notifica.
function fonteDa(origine) {
  const o = String(origine || '');
  if (o === 'job:aggiorna_integrazioni' || o.startsWith('POST /api/integrazioni/aggiorna')) return 'jira';
  if (o.startsWith('POST /api/qlik-voucher/import')) return 'qlik';
  return null;
}

// Tabelle osservabili (i nomi finiscono nelle query: restano in whitelist).
//   codice: colonna con il codice da mostrare; nome: come si chiama la riga nel testo;
//   f: nome femminile (Nuova / aggiornata).
const TABELLE = {
  task_app: { nome: 'Task Jira', codice: 'cod_task', f: false },
  cl_quotazioni: { nome: 'Quotazione Jira', codice: 'codice', f: true },
  // Qlik (import voucher): proj_componenti = una riga per persona e progetto.
  //   INSERT = nuovo "Nome Dipendente" (nominativo) sul progetto;
  //   UPDATE delle ore: raggruppate per progetto (raggruppa), vedi notificaRaggruppata.
  // Ogni tabella qui deve avere tenant_id, user_id, client_id e project_id.
  proj_componenti: { nome: 'Dipendente', codice: 'nominativo', f: false, raggruppa: true }
};

let cacheRegole = null; // { t, regole }
const REGOLE_TTL_MS = 60 * 1000;

async function regoleAttive() {
  if (cacheRegole && Date.now() - cacheRegole.t < REGOLE_TTL_MS) return cacheRegole.regole;
  const r = await notifDb.query(
    'SELECT fonte, tabella, operazione, colonna, etichetta FROM notifiche_regole WHERE attiva'
  );
  cacheRegole = { t: Date.now(), regole: r.rows };
  return r.rows;
}

const cifra = (v) => (v === null || v === undefined ? v : encryptValue(String(v)));

function valoreTesto(v) {
  if (v === null || v === undefined || v === '') return 'vuoto';
  let t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(t)) t = t.slice(0, 10).split('-').reverse().join('/');
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

async function inserisci(n) {
  await notifDb.query(
    `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [n.tenantId, n.userId, n.fonte, cifra(n.titolo), cifra(n.messaggio), n.tabella, n.rigaId]
  );
}

// Aggiornamenti raggruppati (ore Qlik): UNA notifica per progetto e per giorno, anche se
// l'import scrive molte righe e arriva in più blocchi. Se esiste già quella del giorno si
// aggiorna (righe sommate in conteggio) e torna da leggere.
async function notificaRaggruppata(g) {
  const giorno = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }); // AAAA-MM-GG
  await notifDb.query(
    `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id, chiave_dedup, conteggio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, user_id, chiave_dedup) WHERE chiave_dedup IS NOT NULL
     DO UPDATE SET conteggio = notifiche.conteggio + EXCLUDED.conteggio,
                   titolo = EXCLUDED.titolo, messaggio = EXCLUDED.messaggio,
                   letta = false, letta_il = NULL, aggiornata_il = now()`,
    [g.tenantId, g.userId, g.fonte, cifra(g.titolo), cifra(g.messaggio), g.tabella, g.projectId,
      `${g.fonte}|${g.tabella}|ore|${g.projectId}|${giorno}`, g.conteggio]
  );
}

// Nome del cliente (clients: argument = campo = 'Cliente') e del progetto
// (projects: argument = campo = 'Progetto'; la riga del progetto può rimandare con
// argument = id della riga anagrafica, come in resolveProjectDescriptions di server.js).
async function nomiClientiProgetti(clientIds, projectIds) {
  const clienti = new Map();
  const progetti = new Map();
  const cid = [...new Set(clientIds.filter(Boolean).map(String))];
  const pid = [...new Set(projectIds.filter(Boolean).map(String))];
  if (cid.length) {
    const r = await db.query(
      `SELECT id::text AS id, valore2 FROM clients WHERE id::text = ANY($1) AND argument = 'Cliente' AND campo = 'Cliente'`,
      [cid]
    );
    for (const x of r.rows) clienti.set(x.id, x.valore2);
  }
  if (pid.length) {
    const src = await db.query('SELECT id::text AS id, argument FROM projects WHERE id::text = ANY($1)', [pid]);
    const rimando = new Map(src.rows.map((x) => [x.id, x.argument]));
    const candidati = [...new Set([...pid, ...src.rows.map((x) => x.argument).filter((a) => /^[0-9a-f-]{36}$/i.test(String(a || '')))])];
    const r = await db.query(
      `SELECT id::text AS id, valore2 FROM projects WHERE id::text = ANY($1) AND argument = 'Progetto' AND campo = 'Progetto'`,
      [candidati]
    );
    const nome = new Map(r.rows.map((x) => [x.id, x.valore2]));
    for (const p of pid) {
      const n = nome.get(p) || nome.get(String(rimando.get(p) || ''));
      if (n) progetti.set(p, n);
    }
  }
  return { clienti, progetti };
}

/**
 * Righe della coda audit_outbox già inviate a Oracle (tipo 'variazione', dati come scritti
 * dal trigger, valori ancora cifrati). Errori: si registrano e basta (la coda è già salva).
 */
export async function notificheDaVariazioni(righe) {
  try {
    const candidate = [];
    for (const r of righe) {
      if (r.tipo !== 'variazione') continue;
      const d = r.dati || {};
      const fonte = fonteDa(d.origine);
      if (!fonte || !TABELLE[d.tabella] || !['INSERT', 'UPDATE'].includes(d.operazione)) continue;
      candidate.push({ ...d, fonte });
    }
    if (!candidate.length) return 0;

    const regole = await regoleAttive();
    const daFare = [];
    for (const d of candidate) {
      const rr = regole.filter((x) => x.fonte === d.fonte && x.tabella === d.tabella && x.operazione === d.operazione);
      if (!rr.length) continue;
      if (d.operazione === 'INSERT') { daFare.push({ d, cambi: [] }); continue; }
      const prima = decryptDeep(d.prima || {});
      const dopo = decryptDeep(d.dopo || {});
      const campi = Array.isArray(d.campi) ? d.campi : Object.keys(dopo);
      const cambi = rr.filter((x) => campi.includes(x.colonna) &&
          JSON.stringify(prima[x.colonna] ?? null) !== JSON.stringify(dopo[x.colonna] ?? null))
        .map((x) => ({ etichetta: x.etichetta || x.colonna, prima: prima[x.colonna], dopo: dopo[x.colonna] }));
      if (cambi.length) daFare.push({ d, cambi });
    }
    if (!daFare.length) return 0;

    // Dati attuali delle righe (proprietario, cliente, progetto, codice), per tabella.
    const righeDb = new Map(); // "tabella|id" -> riga
    for (const tabella of new Set(daFare.map((x) => x.d.tabella))) {
      const conf = TABELLE[tabella];
      const ids = [...new Set(daFare.filter((x) => x.d.tabella === tabella).map((x) => String(x.d.chiave)))];
      const r = await db.query(
        `SELECT id::text AS id, tenant_id, user_id, client_id, project_id${conf.codice ? `, "${conf.codice}" AS codice` : ''}
           FROM "${tabella}" WHERE id::text = ANY($1)`,
        [ids]
      );
      for (const x of r.rows) righeDb.set(`${tabella}|${x.id}`, x);
    }
    const tutte = [...righeDb.values()];
    const { clienti, progetti } = await nomiClientiProgetti(tutte.map((x) => x.client_id), tutte.map((x) => x.project_id));

    let create = 0;
    const gruppi = new Map(); // aggiornamenti raggruppati per progetto
    for (const { d, cambi } of daFare) {
      const conf = TABELLE[d.tabella];
      // Riga eliminata nel frattempo: si usano i valori del log (INSERT = riga completa).
      const dopo = d.operazione === 'INSERT' ? decryptDeep(d.dopo || {}) : {};
      const riga = righeDb.get(`${d.tabella}|${d.chiave}`) || {
        tenant_id: d.tenant_id || dopo.tenant_id, user_id: dopo.user_id, client_id: dopo.client_id,
        project_id: dopo.project_id, codice: conf.codice ? dopo[conf.codice] : null
      };
      if (!riga.tenant_id || !riga.user_id) continue; // nessun destinatario
      const codice = riga.codice ? ` ${riga.codice}` : '';
      const cliente = clienti.get(String(riga.client_id || ''));
      const progetto = progetti.get(String(riga.project_id || ''));
      const contesto = [cliente ? `Cliente: ${cliente}` : null, progetto ? `Progetto: ${progetto}` : null].filter(Boolean).join(' · ');
      if (conf.raggruppa && d.operazione === 'UPDATE') {
        // Una sola notifica per progetto (e destinatario): si contano le righe cambiate.
        const k = `${riga.tenant_id}|${riga.user_id}|${riga.project_id || ''}`;
        const g = gruppi.get(k) || {
          tenantId: riga.tenant_id, userId: riga.user_id, fonte: d.fonte, tabella: d.tabella,
          projectId: String(riga.project_id || ''), conteggio: 0, campi: new Set(), contesto
        };
        g.conteggio += 1;
        for (const c of cambi) g.campi.add(c.etichetta);
        gruppi.set(k, g);
        continue;
      }
      const titolo = d.operazione === 'INSERT'
        ? `${conf.f ? 'Nuova' : 'Nuovo'} ${conf.nome}${codice}${cliente ? ` per ${cliente}` : ''}`
        : `${conf.nome}${codice} ${conf.f ? 'aggiornata' : 'aggiornato'}: ${cambi.map((c) => c.etichetta.toLowerCase()).join(', ')}`;
      const messaggio = [
        ...cambi.map((c) => `${c.etichetta}: ${valoreTesto(c.prima)} → ${valoreTesto(c.dopo)}`),
        contesto
      ].filter(Boolean).join('\n');
      await inserisci({
        tenantId: riga.tenant_id, userId: riga.user_id, fonte: d.fonte,
        titolo, messaggio, tabella: d.tabella, rigaId: String(d.chiave)
      });
      create += 1;
    }
    for (const g of gruppi.values()) {
      await notificaRaggruppata({
        ...g,
        titolo: `${[...g.campi].join(', ')} aggiornate da Qlik`,
        messaggio: g.contesto || null
      });
      create += 1;
    }
    if (create) console.log(`[NOTIFICHE] ${create} notifiche da Jira/Qlik`);
    return create;
  } catch (e) {
    if (e.code === '42P01') { avvisaTabellaMancante(); return 0; }
    console.error('[NOTIFICHE] Notifiche da Jira/Qlik non create:', e.message);
    return 0;
  }
}

// ----------------------------------------------------------------------------
// QLIK › MYSUPPORT: nuovi ticket (solo INSERT, mai gli aggiornamenti). mysupport non ha il
// log variazioni (scelta dell'utente), quindi la chiama direttamente l'import
// (POST /api/mysupport/import) dopo il COMMIT, con le righe davvero inserite.
// Attiva solo con la regola ('qlik', 'mysupport', 'INSERT') in notifiche_regole.
// Destinatario: il proprietario del cliente abbinato (user_id della riga).
//   righe: [{ id, tenantId, userId, clientId, codice }]
// Molti ticket nuovi nello stesso import (es. primo caricamento): invece di una notifica per
// ticket, una per cliente con l'elenco dei numeri.
// ----------------------------------------------------------------------------
const MYSUPPORT_MAX_SINGOLE = 20;
const MYSUPPORT_MAX_CODICI = 60; // numeri elencati nella notifica raggruppata

export async function notificheNuoviMySupport(righe) {
  try {
    if (!Array.isArray(righe) || !righe.length) return 0;
    const regole = await regoleAttive();
    if (!regole.some((x) => x.fonte === 'qlik' && x.tabella === 'mysupport' && x.operazione === 'INSERT')) return 0;
    const { clienti } = await nomiClientiProgetti(righe.map((r) => r.clientId), []);
    const nomeCliente = (id) => clienti.get(String(id || '')) || '(cliente non trovato)';
    let create = 0;
    if (righe.length <= MYSUPPORT_MAX_SINGOLE) {
      for (const r of righe) {
        const cliente = nomeCliente(r.clientId);
        await inserisci({
          tenantId: r.tenantId, userId: r.userId, fonte: 'qlik',
          titolo: `Nuovo ticket MySupport ${r.codice} per ${cliente}`,
          messaggio: `Ticket: ${r.codice}\nCliente: ${cliente}`,
          tabella: 'mysupport', rigaId: String(r.id)
        });
        create += 1;
      }
    } else {
      const gruppi = new Map(); // destinatario + cliente -> ticket
      for (const r of righe) {
        const k = `${r.tenantId}|${r.userId}|${r.clientId}`;
        if (!gruppi.has(k)) gruppi.set(k, { tenantId: r.tenantId, userId: r.userId, clientId: r.clientId, codici: [] });
        gruppi.get(k).codici.push(r.codice);
      }
      for (const g of gruppi.values()) {
        const cliente = nomeCliente(g.clientId);
        const n = g.codici.length;
        const elenco = g.codici.slice(0, MYSUPPORT_MAX_CODICI).join(', ')
          + (n > MYSUPPORT_MAX_CODICI ? ` e altri ${n - MYSUPPORT_MAX_CODICI}` : '');
        await inserisci({
          tenantId: g.tenantId, userId: g.userId, fonte: 'qlik',
          titolo: n === 1 ? `Nuovo ticket MySupport ${g.codici[0]} per ${cliente}` : `${n} nuovi ticket MySupport per ${cliente}`,
          messaggio: `Ticket: ${elenco}\nCliente: ${cliente}`,
          tabella: 'mysupport', rigaId: null
        });
        create += 1;
      }
    }
    if (create) console.log(`[NOTIFICHE] ${create} notifiche per ${righe.length} nuovi ticket MySupport`);
    return create;
  } catch (e) {
    if (e.code === '42P01') { avvisaTabellaMancante(); return 0; }
    console.error('[NOTIFICHE] Notifiche dei nuovi ticket MySupport non create:', e.message);
    return 0;
  }
}

// ----------------------------------------------------------------------------
// LAVORI AI IN BATCH (jobs/aiLavori.js): risultato pronto o non riuscito. La campanella
// mostra «Apri» (tabella ai_lavori, riga_id = id del lavoro) che apre «Risultati AI».
// ----------------------------------------------------------------------------
export async function notificaLavoroAi({ tenantId, userId, lavoroId, operazione, titolo, ok, errore }) {
  try {
    await inserisci({
      tenantId, userId, fonte: 'ai',
      titolo: `${operazione} ${ok ? 'pronto' : 'non riuscito'}${titolo ? `: ${titolo}` : ''}`,
      messaggio: ok ? 'Richiesta in modalità Batch completata: aprila da «Risultati AI».' : `Richiesta in modalità Batch non riuscita: ${String(errore || '').slice(0, 300)}`,
      tabella: 'ai_lavori', rigaId: lavoroId
    });
  } catch (e) {
    if (e.code === '42P01') { avvisaTabellaMancante(); return; }
    console.error(`[NOTIFICHE] Notifica del lavoro AI ${lavoroId} non creata:`, e.message);
  }
}

// ----------------------------------------------------------------------------
// RIUNIONI: trascrizione completata e recap pronto (jobs/meetingTranscription.js, negli
// stessi punti in cui si registra la riga unica del log). Destinatario: il proprietario
// della riunione; nel testo l'oggetto, il cliente e il progetto se ci sono.
// ----------------------------------------------------------------------------
export async function notificaRiunione({ tenantId, userId, idCalendar, tipo }) {
  try {
    const r = (await db.query(
      `SELECT id::text AS id, oggetto, client_id, project_id, data_calendar::text AS data
         FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [tenantId, userId, idCalendar]
    )).rows[0];
    if (!r) return;
    const { clienti, progetti } = await nomiClientiProgetti([r.client_id], [r.project_id]);
    const cliente = clienti.get(String(r.client_id || ''));
    const progetto = progetti.get(String(r.project_id || ''));
    const oggetto = r.oggetto || '(riunione senza titolo)';
    await inserisci({
      tenantId, userId, fonte: 'riunione',
      titolo: tipo === 'recap' ? `Recap pronto: ${oggetto}`
        : tipo === 'recap_interno' ? `Recap interno pronto: ${oggetto}`
        // Recap in modalità Batch non riuscito (jobs/recapBatch.js): si rigenera col pulsante Recap.
        : tipo === 'recap_fallito' ? `Recap non generato (Batch): ${oggetto}`
        : `Trascrizione completata: ${oggetto}`,
      messaggio: [
        r.data ? `Riunione del ${r.data.split('-').reverse().join('/')}` : null,
        [cliente ? `Cliente: ${cliente}` : null, progetto ? `Progetto: ${progetto}` : null].filter(Boolean).join(' · ')
      ].filter(Boolean).join('\n') || null,
      tabella: 'rec_meeting', rigaId: r.id
    });
  } catch (e) {
    if (e.code === '42P01') { avvisaTabellaMancante(); return; }
    console.error(`[NOTIFICHE] Notifica ${tipo} della riunione ${idCalendar} non creata:`, e.message);
  }
}

let tabellaMancanteSegnalata = false;
function avvisaTabellaMancante() {
  if (!tabellaMancanteSegnalata) console.warn('[NOTIFICHE] Tabelle assenti su projexa_notif: eseguire Supporto/CreaDB/notifiche.sql');
  tabellaMancanteSegnalata = true;
}

// ----------------------------------------------------------------------------
// SCADENZE (job "notifiche_scadenze", tutti i tenant)
// ----------------------------------------------------------------------------
// To-Do (tabella tasks) aperte (Da fare / In corso) con due_date domani, oggi o ieri
// (= scaduta). Conta SOLO due_date: la colonna scadenza ha un'altra funzione e non si usa.
// Destinatario: il proprietario. Per ora solo le To-Do (altre scadenze: in seguito).
const STATI_APERTI = ['todo', 'in_progress'];
const SOGLIE = {
  domani: { titolo: 'To-Do in scadenza domani' },
  oggi: { titolo: 'To-Do in scadenza oggi' },
  scaduta: { titolo: 'To-Do scaduta' }
};

export async function eseguiNotificheScadenze() {
  const report = { ok: true, controllate: 0, create: 0, rimesseDaLeggere: 0, giaPresenti: 0, eliminateVecchie: 0 };
  const r = await db.query(
    `SELECT id::text AS id, tenant_id, user_id, titile, due_date::text AS due,
            CASE WHEN due_date = CURRENT_DATE + 1 THEN 'domani'
                 WHEN due_date = CURRENT_DATE THEN 'oggi'
                 ELSE 'scaduta' END AS soglia
       FROM tasks
      WHERE due_date BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + 1
        AND COALESCE(status, 'todo') = ANY($1)`,
    [STATI_APERTI]
  );
  report.controllate = r.rows.length;
  try {
    for (const t of r.rows) {
      const chiave = `scadenza|tasks|${t.id}|${t.due}|${t.soglia}`;
      const data = t.due.split('-').reverse().join('/');
      // Assente -> nuova; presente e letta -> di nuovo da leggere; presente non letta -> niente.
      const x = await notifDb.query(
        `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id, chiave_dedup)
         VALUES ($1, $2, 'scadenza', $3, $4, 'tasks', $5, $6)
         ON CONFLICT (tenant_id, user_id, chiave_dedup) WHERE chiave_dedup IS NOT NULL
         DO UPDATE SET letta = false, letta_il = NULL, aggiornata_il = now()
           WHERE notifiche.letta
         RETURNING (xmax = 0) AS nuova`,
        [t.tenant_id, t.user_id, cifra(SOGLIE[t.soglia].titolo), cifra(`${t.titile || '(senza titolo)'} · scadenza ${data}`), t.id, chiave]
      );
      if (!x.rows.length) report.giaPresenti += 1;
      else if (x.rows[0].nuova) report.create += 1;
      else report.rimesseDaLeggere += 1;
    }
    // Pulizia: notifiche lette da più di 90 giorni.
    report.eliminateVecchie = (await notifDb.query("DELETE FROM notifiche WHERE letta AND letta_il < now() - interval '90 days'")).rowCount;
  } catch (e) {
    if (e.code === '42P01') throw new Error('Tabelle delle notifiche assenti su projexa_notif: eseguire Supporto/CreaDB/notifiche.sql');
    throw e;
  }
  return report;
}
