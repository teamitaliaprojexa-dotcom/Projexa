// ============================================================================
// INVIO DEI LOG A ORACLE (coda audit_outbox -> Oracle Autonomous Database)
// ----------------------------------------------------------------------------
// Ogni minuto prende dalla coda locale (Supporto/CreaDB/audit_log.sql) blocchi di
// righe, le inserisce su Oracle (Supporto/CreaDB/oracle_audit.sql) e solo dopo la
// conferma le cancella dalla coda. Se Oracle non risponde le righe restano in coda
// e si riprova al giro dopo: non si perde nulla. Se un invio viene ripetuto, il
// indice UNIQUE (id_coda, quando) su Oracle scarta i doppioni.
//
// Si attiva SOLO con AUDIT_ORACLE_ENABLED=true e le variabili ORACLE_AUDIT_* nel
// .env (da impostare solo sulla VM, come JOB_SCHEDULER_ENABLED).
// Driver: node-oracledb in modalità "thin" (JavaScript puro, niente Instant Client).
// Connessione TLS senza wallet: l'accesso al database è limitato all'IP della VM.
// ============================================================================
import oracledb from 'oracledb';
import db from '../config/database.js';

const TICK_MS = 60 * 1000;
const LOTTO = 500;          // righe per invio
const LOTTI_PER_GIRO = 40;  // dopo un'interruzione recupera fino a 20.000 righe al minuto
const SCHEMA = (process.env.ORACLE_AUDIT_SCHEMA || 'AUDIT_OWNER').toUpperCase();

let poolOracle = null;
let giroInCorso = false;
let ultimoErrore = '';
let ultimoInvio = null;   // ultimo giro riuscito (anche senza righe)
let righeInviate = 0;     // righe inviate dall'avvio del backend

export function auditOracleAttivo() {
  return String(process.env.AUDIT_ORACLE_ENABLED || '').toLowerCase() === 'true';
}

function configurazioneMancante() {
  return ['ORACLE_AUDIT_USER', 'ORACLE_AUDIT_PASSWORD', 'ORACLE_AUDIT_CONNECT']
    .filter((k) => !String(process.env[k] || '').trim());
}

// Usato anche dalla pagina Log (routes/audit-log.js) per leggere le tabelle.
export async function getPoolOracle() {
  const mancanti = configurazioneMancante();
  if (mancanti.length) {
    throw Object.assign(new Error(`Log Oracle non configurato su questo server (mancano ${mancanti.join(', ')})`), { status: 503 });
  }
  // Si conserva la promessa: due richieste contemporanee non creano due pool.
  if (!poolOracle) {
    poolOracle = oracledb.createPool({
      user: process.env.ORACLE_AUDIT_USER,
      password: process.env.ORACLE_AUDIT_PASSWORD,
      connectString: process.env.ORACLE_AUDIT_CONNECT,
      poolMin: 0,
      poolMax: 3,     // invio + pagina Log
      poolTimeout: 300 // chiude le connessioni ferme da 5 minuti
    }).catch((e) => { poolOracle = null; throw e; });
  }
  return poolOracle;
}

const testo = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

const SQL_ACCESSI = `INSERT INTO ${SCHEMA}.log_accessi
  (id_coda, quando, evento, esito, user_id, email, tenant_id, ip, user_agent, dettaglio)
  VALUES (:id_coda, :quando, :evento, :esito, :user_id, :email, :tenant_id, :ip, :user_agent, :dettaglio)`;

const DEF_ACCESSI = {
  id_coda: { type: oracledb.NUMBER },
  quando: { type: oracledb.DB_TYPE_TIMESTAMP_TZ },
  evento: { type: oracledb.STRING, maxSize: 40 },
  esito: { type: oracledb.STRING, maxSize: 10 },
  user_id: { type: oracledb.STRING, maxSize: 64 },
  email: { type: oracledb.STRING, maxSize: 320 },
  tenant_id: { type: oracledb.STRING, maxSize: 64 },
  ip: { type: oracledb.STRING, maxSize: 64 },
  user_agent: { type: oracledb.STRING, maxSize: 500 },
  dettaglio: { type: oracledb.STRING, maxSize: 1000 }
};

const SQL_VARIAZIONI = `INSERT INTO ${SCHEMA}.log_variazioni
  (id_coda, quando, tenant_id, user_id, origine, tabella, operazione, chiave, campi, prima, dopo)
  VALUES (:id_coda, :quando, :tenant_id, :user_id, :origine, :tabella, :operazione, :chiave, :campi, :prima, :dopo)`;

const DEF_VARIAZIONI = {
  id_coda: { type: oracledb.NUMBER },
  quando: { type: oracledb.DB_TYPE_TIMESTAMP_TZ },
  tenant_id: { type: oracledb.STRING, maxSize: 64 },
  user_id: { type: oracledb.STRING, maxSize: 64 },
  origine: { type: oracledb.STRING, maxSize: 400 },
  tabella: { type: oracledb.STRING, maxSize: 128 },
  operazione: { type: oracledb.STRING, maxSize: 10 },
  chiave: { type: oracledb.STRING, maxSize: 400 },
  campi: { type: oracledb.STRING, maxSize: 4000 },
  prima: { type: oracledb.DB_TYPE_CLOB },
  dopo: { type: oracledb.DB_TYPE_CLOB }
};

function rigaAccesso(r) {
  const d = r.dati || {};
  return {
    id_coda: Number(r.id),
    quando: r.creato_il,
    evento: testo(d.evento, 40) || 'sconosciuto',
    esito: testo(d.esito, 10) || 'ok',
    user_id: testo(d.user_id, 64),
    email: testo(d.email, 320),
    tenant_id: testo(d.tenant_id, 64),
    ip: testo(d.ip, 64),
    user_agent: testo(d.user_agent, 500),
    dettaglio: testo(d.dettaglio, 1000)
  };
}

function rigaVariazione(r) {
  const d = r.dati || {};
  return {
    id_coda: Number(r.id),
    quando: r.creato_il,
    tenant_id: testo(d.tenant_id, 64),
    user_id: testo(d.user_id, 64),
    origine: testo(d.origine, 400),
    tabella: testo(d.tabella, 128) || '?',
    operazione: testo(d.operazione, 10) || '?',
    chiave: testo(d.chiave, 400),
    campi: Array.isArray(d.campi) ? testo(d.campi.join(','), 4000) : null,
    prima: json(d.prima),
    dopo: json(d.dopo)
  };
}

// Inserisce le righe; i doppioni (ORA-00001 sul vincolo UNIQUE) vengono ignorati,
// qualsiasi altro errore annulla tutto l'invio.
async function inserisci(conn, sql, righe, bindDefs) {
  if (!righe.length) return;
  const r = await conn.executeMany(sql, righe, { bindDefs, batchErrors: true, autoCommit: false });
  const veri = (r.batchErrors || []).filter((e) => e.errorNum !== 1);
  if (veri.length) throw new Error(`Oracle: ${veri[0].message} (${veri.length} righe)`);
}

// Un blocco: restituisce il numero di righe inviate (0 = coda vuota).
async function inviaLotto() {
  // Connessione "grezza": niente decifratura (i valori cifrati restano cifrati nei log)
  // e niente contesto audit.
  const client = await db.rawConnect();
  const q = (client.rawQuery || client.query).bind(client);
  try {
    await q('BEGIN');
    const { rows } = await q(
      'SELECT id, tipo, creato_il, dati FROM audit_outbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [LOTTO]
    );
    if (!rows.length) {
      await q('COMMIT');
      return 0;
    }

    const conn = await (await getPoolOracle()).getConnection();
    try {
      await inserisci(conn, SQL_ACCESSI, rows.filter((r) => r.tipo === 'accesso').map(rigaAccesso), DEF_ACCESSI);
      await inserisci(conn, SQL_VARIAZIONI, rows.filter((r) => r.tipo === 'variazione').map(rigaVariazione), DEF_VARIAZIONI);
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      await conn.close().catch(() => {});
    }

    // Oracle ha confermato: ora si possono togliere dalla coda.
    await q('DELETE FROM audit_outbox WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
    await q('COMMIT');
    return rows.length;
  } catch (e) {
    await q('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function giro() {
  if (giroInCorso) return;
  giroInCorso = true;
  let inviate = 0;
  try {
    for (let i = 0; i < LOTTI_PER_GIRO; i++) {
      const n = await inviaLotto();
      inviate += n;
      if (n < LOTTO) break;
    }
    if (ultimoErrore) console.log(`[AUDIT] Invio a Oracle ripreso (${inviate} righe inviate)`);
    ultimoErrore = '';
    ultimoInvio = new Date();
    righeInviate += inviate;
  } catch (e) {
    const msg = e.code === '42P01'
      ? 'tabella audit_outbox assente: eseguire Supporto/CreaDB/audit_log.sql'
      : e.message;
    // Lo stesso errore si scrive una volta sola, non a ogni minuto.
    if (msg !== ultimoErrore) console.error(`[AUDIT] Invio a Oracle non riuscito (le righe restano in coda): ${msg}`);
    ultimoErrore = msg;
  } finally {
    giroInCorso = false;
  }
}

// Stato dell'invio per la pagina Log.
export function statoInvioAudit() {
  return {
    attivo: auditOracleAttivo() && configurazioneMancante().length === 0,
    ultimoInvio,
    righeInviate,
    ultimoErrore: ultimoErrore || null
  };
}

export const SCHEMA_AUDIT = SCHEMA;

export function avviaInvioAudit() {
  if (!auditOracleAttivo()) {
    console.log('[AUDIT] Invio a Oracle disattivato (AUDIT_ORACLE_ENABLED non è true)');
    return;
  }
  const mancanti = configurazioneMancante();
  if (mancanti.length) {
    console.warn(`[AUDIT] Invio a Oracle non avviato: mancano ${mancanti.join(', ')} nel .env`);
    return;
  }
  console.log('[AUDIT] Invio dei log a Oracle attivo: ogni minuto');
  setTimeout(giro, 20 * 1000);
  setInterval(giro, TICK_MS);
}
