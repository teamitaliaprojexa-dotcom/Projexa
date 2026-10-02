// Pagina Log (sito/audit-log.html): consultazione di accessi e variazioni salvati su
// Oracle (AUDIT_OWNER.LOG_ACCESSI / LOG_VARIAZIONI, vedi Supporto/CreaDB/oracle_audit.sql).
// Riservata all'admin del tenant PROJEXA, come Monitor VM e Schedulazioni.
//
// Le letture passano dal backend sulla VM: Oracle accetta connessioni solo dal suo IP.
// I valori cifrati ("enc:v1:...") restano cifrati nei log e vengono decifrati qui, solo
// per la visualizzazione. Una stessa informazione cifrata due volte dà testi diversi
// (cifratura con IV casuale): dopo la decifratura i campi rimasti uguali si tolgono
// dall'elenco dei cambiamenti.
import express from 'express';
import oracledb from 'oracledb';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjexaAdmin } from './vm-monitor.js';
import { decryptDeep } from '../config/crypto.js';
import { getPoolOracle, statoInvioAudit, SCHEMA_AUDIT } from '../jobs/auditShipper.js';

const router = express.Router();
router.use(requireAuth, requireProjexaAdmin);

const PER_PAGINA = 50;

function intervallo(q) {
  const a = q.a ? new Date(q.a) : new Date();
  const da = q.da ? new Date(q.da) : new Date(a.getTime() - 7 * 24 * 3600 * 1000);
  if (Number.isNaN(da.getTime()) || Number.isNaN(a.getTime())) {
    throw Object.assign(new Error('Date non valide'), { status: 400 });
  }
  return { da, a };
}

const pagina = (q) => Math.max(0, parseInt(q.pagina, 10) || 0);
const testo = (v, max = 200) => String(v || '').trim().slice(0, max);

async function conOracle(fn) {
  const conn = await (await getPoolOracle()).getConnection();
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Nomi di utenti e tenant per la visualizzazione (gli id sono uuid).
async function nomi(userIds, tenantIds) {
  const utenti = {};
  const tenant = {};
  const u = [...new Set(userIds.filter(Boolean))];
  const t = [...new Set(tenantIds.filter(Boolean))];
  const uuid = /^[0-9a-f-]{36}$/i;
  const uValidi = u.filter((x) => uuid.test(x));
  const tValidi = t.filter((x) => uuid.test(x));
  if (uValidi.length) {
    const r = await db.query('SELECT id::text AS id, name, cognome FROM users WHERE id = ANY($1::uuid[])', [uValidi]);
    for (const x of r.rows) utenti[x.id] = { nome: [x.name, x.cognome].filter(Boolean).join(' ').trim() };
    const e = await authDb.query('SELECT id::text AS id, email FROM users WHERE id = ANY($1::uuid[])', [uValidi]);
    for (const x of e.rows) utenti[x.id] = { ...(utenti[x.id] || {}), email: x.email };
  }
  if (tValidi.length) {
    const r = await db.query('SELECT id::text AS id, name FROM tenants WHERE id = ANY($1::uuid[])', [tValidi]);
    for (const x of r.rows) tenant[x.id] = x.name;
  }
  return { utenti, tenant };
}

function inviaErrore(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error('[AUDIT-LOG]', e.message);
  res.status(status).json({ error: e.message });
}

// Stato: coda locale, invio a Oracle, totali.
router.get('/stato', async (req, res) => {
  const out = { invio: statoInvioAudit(), coda: null, totali: null, errore: null };
  try {
    const r = await db.query('SELECT count(*)::int AS righe, min(creato_il) AS piu_vecchia FROM audit_outbox');
    out.coda = r.rows[0];
  } catch (e) {
    out.coda = { errore: e.code === '42P01' ? 'tabella audit_outbox assente' : e.message };
  }
  try {
    out.totali = await conOracle(async (conn) => {
      const r = await conn.execute(
        `SELECT (SELECT COUNT(*) FROM ${SCHEMA_AUDIT}.log_accessi) AS accessi,
                (SELECT COUNT(*) FROM ${SCHEMA_AUDIT}.log_variazioni) AS variazioni FROM dual`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const totali = { accessi: r.rows[0].ACCESSI, variazioni: r.rows[0].VARIAZIONI, email: null };
      try {
        const m = await conn.execute(`SELECT COUNT(*) AS n FROM ${SCHEMA_AUDIT}.log_email`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        totali.email = m.rows[0].N;
      } catch { /* tabella LOG_EMAIL non ancora creata */ }
      return totali;
    });
  } catch (e) {
    out.errore = e.message;
  }
  res.json(out);
});

// Database Oracle dei log: raggiungibilità, capienza (Always Free = 20 GB), spazio
// occupato da tutto il database (se la procedura lo può leggere) e da ogni tabella, con
// numero di righe e data del log più vecchio. Lo spazio lo legge la procedura
// AUDIT_OWNER.SPAZIO_LOG (sezione 4c di Supporto/CreaDB/oracle_audit.sql).
const CAPIENZA_BYTE = Number(process.env.ORACLE_AUDIT_CAPIENZA_GB || 20) * 1024 ** 3;
const TABELLE_LOG = { LOG_ACCESSI: 'Accessi', LOG_VARIAZIONI: 'Modifiche ai dati', LOG_EMAIL: 'Email' };

router.get('/spazio', async (req, res) => {
  const inizio = Date.now();
  try {
    const out = await conOracle(async (conn) => {
      await conn.execute('SELECT 1 FROM dual');
      const ms = Date.now() - inizio;
      let tabelle = [];
      let totaleDb = null;
      let procedura = true;
      try {
        const r = await conn.execute(
          `BEGIN ${SCHEMA_AUDIT}.spazio_log(:tabelle, :totale); END;`,
          { tabelle: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR }, totale: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const rs = r.outBinds.tabelle;
        tabelle = (await rs.getRows()).map((x) => ({ nome: x.TABELLA, byte: Number(x.BYTE) || 0 }));
        await rs.close();
        totaleDb = r.outBinds.totale;
      } catch (e) {
        if (!/PLS-00201|ORA-06550/.test(e.message)) throw e;
        procedura = false; // procedura non ancora creata: solo righe e date
      }
      // Righe e log più vecchio delle tabelle dei log (PROJEXA_LOG può leggerle).
      const dettaglio = [];
      for (const [nome, etichetta] of Object.entries(TABELLE_LOG)) {
        try {
          const c = await conn.execute(`SELECT COUNT(*) AS n, MIN(quando) AS primo FROM ${SCHEMA_AUDIT}.${nome}`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
          const sp = tabelle.find((t) => t.nome === nome);
          dettaglio.push({ nome, etichetta, righe: c.rows[0].N, piuVecchio: c.rows[0].PRIMO, byte: sp ? sp.byte : null });
        } catch { /* tabella non ancora creata */ }
      }
      const spazioLog = tabelle.reduce((s, t) => s + t.byte, 0);
      return { raggiungibile: true, ms, procedura, capienza: CAPIENZA_BYTE, totaleDb, spazioLog, tabelle: dettaglio };
    });
    res.json(out);
  } catch (e) {
    res.json({ raggiungibile: false, errore: e.message, capienza: CAPIENZA_BYTE });
  }
});

// Elenco per i filtri: utenti (tutti i tenant) e tabelle registrate.
router.get('/filtri', async (req, res) => {
  try {
    const u = await db.query(
      `SELECT u.id::text AS id, u.name, u.cognome, t.name AS tenant
         FROM users u
         LEFT JOIN user_tenants ut ON ut.user_id = u.id
         LEFT JOIN tenants t ON t.id = ut.tenant_id
        ORDER BY u.name, u.cognome`
    );
    const utenti = new Map();
    for (const x of u.rows) {
      const prev = utenti.get(x.id);
      const nome = [x.name, x.cognome].filter(Boolean).join(' ').trim() || x.id;
      if (prev) { if (x.tenant && !prev.tenant.includes(x.tenant)) prev.tenant.push(x.tenant); } else utenti.set(x.id, { id: x.id, nome, tenant: x.tenant ? [x.tenant] : [] });
    }
    const tabelle = await db.query(
      `SELECT event_object_table AS t FROM information_schema.triggers
        WHERE trigger_name = 'audit_variazioni' GROUP BY 1 ORDER BY 1`
    );
    res.json({ utenti: [...utenti.values()], tabelle: tabelle.rows.map((r) => r.t) });
  } catch (e) {
    inviaErrore(res, e);
  }
});

router.get('/accessi', async (req, res) => {
  try {
    const { da, a } = intervallo(req.query);
    const where = ['quando >= :da', 'quando < :a'];
    const binds = { da, a };
    if (req.query.esito === 'ok' || req.query.esito === 'ko') { where.push('esito = :esito'); binds.esito = req.query.esito; }
    if (testo(req.query.evento, 40)) { where.push('evento = :evento'); binds.evento = testo(req.query.evento, 40); }
    if (testo(req.query.utente, 64)) { where.push('user_id = :utente'); binds.utente = testo(req.query.utente, 64); }
    if (testo(req.query.cerca)) {
      where.push('(LOWER(email) LIKE :cerca OR ip LIKE :cerca OR LOWER(dettaglio) LIKE :cerca)');
      binds.cerca = `%${testo(req.query.cerca).toLowerCase()}%`;
    }
    binds.off = pagina(req.query) * PER_PAGINA;
    binds.lim = PER_PAGINA + 1;
    const righe = await conOracle(async (conn) => (await conn.execute(
      `SELECT id, quando, evento, esito, user_id, email, tenant_id, ip, user_agent, dettaglio
         FROM ${SCHEMA_AUDIT}.log_accessi
        WHERE ${where.join(' AND ')}
        ORDER BY quando DESC, id DESC
        OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows);
    const altre = righe.length > PER_PAGINA;
    const lista = righe.slice(0, PER_PAGINA);
    const n = await nomi(lista.map((r) => r.USER_ID), lista.map((r) => r.TENANT_ID));
    res.json({
      altre,
      righe: lista.map((r) => ({
        id: r.ID, quando: r.QUANDO, evento: r.EVENTO, esito: r.ESITO,
        userId: r.USER_ID, utente: (n.utenti[r.USER_ID] || {}).nome || null, email: r.EMAIL,
        tenantId: r.TENANT_ID, tenant: n.tenant[r.TENANT_ID] || null,
        ip: r.IP, userAgent: r.USER_AGENT, dettaglio: r.DETTAGLIO
      }))
    });
  } catch (e) {
    inviaErrore(res, e);
  }
});

router.get('/email', async (req, res) => {
  try {
    const { da, a } = intervallo(req.query);
    const where = ['quando >= :da', 'quando < :a'];
    const binds = { da, a };
    if (req.query.esito === 'ok' || req.query.esito === 'ko') { where.push('esito = :esito'); binds.esito = req.query.esito; }
    if (testo(req.query.tipoEmail, 40)) { where.push('tipo = :tipo'); binds.tipo = testo(req.query.tipoEmail, 40); }
    if (req.query.modalita === 'server' || req.query.modalita === 'client') { where.push('modalita = :modalita'); binds.modalita = req.query.modalita; }
    if (testo(req.query.utente, 64)) { where.push('user_id = :utente'); binds.utente = testo(req.query.utente, 64); }
    if (testo(req.query.cerca)) {
      where.push('(LOWER(destinatari) LIKE :cerca OR LOWER(cc) LIKE :cerca OR LOWER(oggetto) LIKE :cerca OR LOWER(mittente) LIKE :cerca)');
      binds.cerca = `%${testo(req.query.cerca).toLowerCase()}%`;
    }
    binds.off = pagina(req.query) * PER_PAGINA;
    binds.lim = PER_PAGINA + 1;
    const righe = await conOracle(async (conn) => (await conn.execute(
      `SELECT id, quando, tipo, modalita, esito, destinatari, cc, mittente, oggetto, riferimento, servizio, errore, user_id, tenant_id, ip
         FROM ${SCHEMA_AUDIT}.log_email
        WHERE ${where.join(' AND ')}
        ORDER BY quando DESC, id DESC
        OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows);
    const altre = righe.length > PER_PAGINA;
    const lista = righe.slice(0, PER_PAGINA);
    const n = await nomi(lista.map((r) => r.USER_ID), lista.map((r) => r.TENANT_ID));
    res.json({
      altre,
      righe: lista.map((r) => ({
        id: r.ID, quando: r.QUANDO, tipo: r.TIPO, modalita: r.MODALITA, esito: r.ESITO,
        destinatari: r.DESTINATARI, cc: r.CC, mittente: r.MITTENTE, oggetto: r.OGGETTO,
        riferimento: r.RIFERIMENTO, servizio: r.SERVIZIO, errore: r.ERRORE, ip: r.IP,
        userId: r.USER_ID, utente: (n.utenti[r.USER_ID] || {}).nome || null,
        tenantId: r.TENANT_ID, tenant: n.tenant[r.TENANT_ID] || null
      }))
    });
  } catch (e) {
    if (/ORA-00942/.test(e.message)) {
      e.message = 'Tabella LOG_EMAIL non presente su Oracle: eseguire la sezione 2b di Supporto/CreaDB/oracle_audit.sql';
      e.status = 503;
    }
    inviaErrore(res, e);
  }
});

// Toglie dai cambiamenti i campi che, decifrati, risultano uguali.
function confronta(operazione, prima, dopo) {
  if (operazione !== 'UPDATE' || !prima || !dopo) return { prima, dopo, campi: null };
  const campi = Object.keys({ ...prima, ...dopo })
    .filter((k) => JSON.stringify(prima[k] ?? null) !== JSON.stringify(dopo[k] ?? null));
  const p = {};
  const d = {};
  for (const k of campi) { p[k] = prima[k] ?? null; d[k] = dopo[k] ?? null; }
  return { prima: p, dopo: d, campi };
}

function leggiJson(s) {
  if (!s) return null;
  try { return decryptDeep(JSON.parse(s)); } catch { return null; }
}

router.get('/variazioni', async (req, res) => {
  try {
    const { da, a } = intervallo(req.query);
    const where = ['quando >= :da', 'quando < :a'];
    const binds = { da, a };
    if (testo(req.query.tabella, 128)) { where.push('tabella = :tabella'); binds.tabella = testo(req.query.tabella, 128); }
    if (testo(req.query.chiave, 400)) { where.push('chiave = :chiave'); binds.chiave = testo(req.query.chiave, 400); }
    if (testo(req.query.utente, 64)) { where.push('user_id = :utente'); binds.utente = testo(req.query.utente, 64); }
    if (['INSERT', 'UPDATE', 'DELETE'].includes(req.query.operazione)) { where.push('operazione = :op'); binds.op = req.query.operazione; }
    if (req.query.origine === 'utente') where.push('user_id IS NOT NULL');
    if (req.query.origine === 'job') where.push("origine LIKE 'job:%'");
    if (req.query.origine === 'sql') where.push("origine LIKE 'sql:%'");
    binds.off = pagina(req.query) * PER_PAGINA;
    binds.lim = PER_PAGINA + 1;
    const righe = await conOracle(async (conn) => (await conn.execute(
      `SELECT id, quando, tenant_id, user_id, origine, tabella, operazione, chiave, campi, prima, dopo
         FROM ${SCHEMA_AUDIT}.log_variazioni
        WHERE ${where.join(' AND ')}
        ORDER BY quando DESC, id DESC
        OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchInfo: { PRIMA: { type: oracledb.STRING }, DOPO: { type: oracledb.STRING } }
      })).rows);
    const altre = righe.length > PER_PAGINA;
    const lista = righe.slice(0, PER_PAGINA);
    const n = await nomi(lista.map((r) => r.USER_ID), lista.map((r) => r.TENANT_ID));
    res.json({
      altre,
      righe: lista.map((r) => {
        const c = confronta(r.OPERAZIONE, leggiJson(r.PRIMA), leggiJson(r.DOPO));
        return {
          id: r.ID, quando: r.QUANDO, tabella: r.TABELLA, operazione: r.OPERAZIONE, chiave: r.CHIAVE,
          userId: r.USER_ID, utente: (n.utenti[r.USER_ID] || {}).nome || null,
          email: (n.utenti[r.USER_ID] || {}).email || null,
          tenantId: r.TENANT_ID, tenant: n.tenant[r.TENANT_ID] || null,
          origine: r.ORIGINE,
          campi: c.campi || (r.CAMPI ? r.CAMPI.split(',') : null),
          soloRicifratura: Array.isArray(c.campi) && c.campi.length === 0,
          prima: c.prima, dopo: c.dopo
        };
      })
    });
  } catch (e) {
    inviaErrore(res, e);
  }
});

// Eliminazione manuale: passa SOLO dalla procedura AUDIT_OWNER.ELIMINA_LOG
// (Supporto/CreaDB/oracle_audit.sql), che accetta periodi fissi, protegge sempre gli
// ultimi 30 giorni e registra l'eliminazione in LOG_ACCESSI. Il backend non ha DELETE.
router.post('/elimina', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const tabella = { accessi: 'ACCESSI', variazioni: 'VARIAZIONI', email: 'EMAIL' }[b.tabella];
    const modo = { vecchi: 'VECCHI', ultimi: 'ULTIMI' }[b.modo];
    const mesi = Number(b.mesi);
    if (!tabella || !modo || ![1, 3, 6].includes(mesi)) {
      return res.status(400).json({ error: 'Scelta non valida' });
    }
    const eliminate = await conOracle(async (conn) => {
      const r = await conn.execute(
        `BEGIN ${SCHEMA_AUDIT}.elimina_log(:tabella, :modo, :mesi, :user_id, :email, :ip, :eliminate); END;`,
        {
          tabella, modo, mesi,
          user_id: String(req.user.user_id || ''),
          email: String(req.user.email || ''),
          ip: req.ip || '',
          eliminate: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
        },
        { autoCommit: true }
      );
      return r.outBinds.eliminate;
    });
    console.log(`[AUDIT-LOG] ${req.user.email} ha eliminato ${eliminate} log ${b.tabella} (${b.modo} ${mesi} mesi)`);
    res.json({ eliminate });
  } catch (e) {
    if (/PLS-00201|ORA-06550/.test(e.message)) {
      e.message = 'Procedura ELIMINA_LOG non presente su Oracle: eseguire la sezione 4b di Supporto/CreaDB/oracle_audit.sql';
      e.status = 503;
    }
    inviaErrore(res, e);
  }
});

export default router;
