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
      return { accessi: r.rows[0].ACCESSI, variazioni: r.rows[0].VARIAZIONI };
    });
  } catch (e) {
    out.errore = e.message;
  }
  res.json(out);
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

export default router;
