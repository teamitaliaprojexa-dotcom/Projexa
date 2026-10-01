// Gestione delle schedulazioni dei job (pagina job-schedules.html, tabella job_schedules).
// Riservata all'admin (id_roles = 1) del tenant PROJEXA, verificato sul database come per
// il Monitor VM. La tabella NON è in table_structures: l'endpoint generico /api/data non
// la espone, si modifica solo da qui.
//
// Ogni modifica al calendario ricalcola subito prossima_esecuzione. «Esegui ora» non
// lancia il job da qui: mette prossima_esecuzione = adesso e lo esegue lo schedulatore del
// server entro un minuto (così gira sempre sulla VM, anche se la pagina è aperta in locale).
import express from 'express';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjexaAdmin } from './vm-monitor.js';
import { calcolaProssima, NOMI_JOB, INFO_JOB, schedulerAttivo } from '../jobs/scheduler.js';

const router = express.Router();
router.use(requireAuth, requireProjexaAdmin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORA = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function erroreValidazione(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Valida e normalizza i campi modificabili. Restituisce solo quelli presenti nel body.
async function leggiCampi(body, parziale) {
  const c = {};
  const ha = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (ha('tenant_id') || !parziale) {
    const t = String(body.tenant_id || '');
    if (!UUID.test(t)) throw erroreValidazione('Tenant non valido');
    const ok = await db.query('SELECT 1 FROM tenants WHERE id = $1', [t]);
    if (!ok.rows.length) throw erroreValidazione('Tenant inesistente');
    c.tenant_id = t;
  }
  if (ha('job') || !parziale) {
    const j = String(body.job || '');
    if (!NOMI_JOB.includes(j)) throw erroreValidazione(`Job non valido (ammessi: ${NOMI_JOB.join(', ')})`);
    c.job = j;
  }
  if (ha('utente_config')) {
    const u = body.utente_config ? String(body.utente_config) : null;
    if (u && !UUID.test(u)) throw erroreValidazione('Utente non valido');
    c.utente_config = u;
  }
  if (ha('descrizione')) c.descrizione = body.descrizione == null ? null : String(body.descrizione).slice(0, 255);
  if (ha('attivo')) c.attivo = !!body.attivo;
  if (ha('giorni_settimana')) {
    const g = [...new Set((Array.isArray(body.giorni_settimana) ? body.giorni_settimana : []).map(Number))].sort();
    if (!g.length || g.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) throw erroreValidazione('Scegli almeno un giorno');
    c.giorni_settimana = g;
  }
  for (const k of ['ora_inizio', 'ora_fine']) {
    if (ha(k)) {
      if (!ORA.test(String(body[k] || ''))) throw erroreValidazione(`Orario non valido: ${k}`);
      c[k] = String(body[k]);
    }
  }
  if (ha('intervallo_minuti')) {
    const n = Number(body.intervallo_minuti);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw erroreValidazione('Intervallo tra 5 e 1440 minuti');
    c.intervallo_minuti = n;
  }
  if (ha('fuso_orario')) {
    const tz = String(body.fuso_orario || '');
    try { new Intl.DateTimeFormat('it-IT', { timeZone: tz }); } catch { throw erroreValidazione('Fuso orario non valido'); }
    c.fuso_orario = tz;
  }
  if (ha('parametri')) {
    let p = body.parametri;
    if (typeof p === 'string') {
      if (!p.trim()) p = null;
      else { try { p = JSON.parse(p); } catch { throw erroreValidazione('Parametri: JSON non valido'); } }
    }
    if (p != null && (typeof p !== 'object' || Array.isArray(p))) throw erroreValidazione('Parametri: serve un oggetto JSON');
    c.parametri = p == null ? null : JSON.stringify(p);
  }
  return c;
}

// L'utente della configurazione Jira deve appartenere al tenant della schedulazione.
async function verificaUtenteConfig(id) {
  const r = (await db.query(
    `SELECT s.utente_config FROM job_schedules s
      WHERE s.id = $1 AND s.utente_config IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = s.utente_config AND ut.tenant_id = s.tenant_id)`,
    [id]
  )).rows[0];
  if (r) throw erroreValidazione('L\'utente scelto per la configurazione Jira non appartiene al tenant della schedulazione');
}

// Utenti di ogni tenant con lo stato Jira (mappatura presente, account collegato),
// per l'elenco "Configurazione Jira di" della pagina.
async function utentiDeiTenant() {
  const { rows } = await db.query(
    `SELECT ut.tenant_id, ut.user_id, u.name, u.cognome,
            EXISTS (SELECT 1 FROM jira_task j WHERE j.tenant_id = ut.tenant_id AND j.user_id = ut.user_id)
         OR EXISTS (SELECT 1 FROM jira_quotazioni j WHERE j.tenant_id = ut.tenant_id AND j.user_id = ut.user_id) AS mappatura
       FROM user_tenants ut
       LEFT JOIN users u ON u.id = ut.user_id`
  );
  // Account Jira collegato = ha il refresh token su Projexa-Auth (integr_tok_auth).
  let collegati = new Set();
  try {
    const t = await authDb.query(
      `SELECT DISTINCT user_id FROM integr_tok_auth
        WHERE lower(provider_integrazione) = 'jira' AND elemento = 'jira_refresh_token'`
    );
    collegati = new Set(t.rows.map((x) => String(x.user_id)));
  } catch (e) {
    console.warn('[JOB-SCHEDULES] Stato collegamento Jira non disponibile:', e.message);
  }
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    user_id: r.user_id,
    nome: [r.name, r.cognome].filter(Boolean).join(' ') || String(r.user_id),
    mappatura: !!r.mappatura,
    collegato: collegati.has(String(r.user_id))
  })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

// Ricalcola prossima_esecuzione dopo una modifica (null se disattivata).
async function ricalcolaProssima(id) {
  const r = (await db.query('SELECT * FROM job_schedules WHERE id = $1', [id])).rows[0];
  if (!r) return null;
  if (r.ora_fine < r.ora_inizio) throw erroreValidazione('L\'ora di fine deve essere successiva a quella di inizio');
  const prossima = r.attivo ? calcolaProssima(r) : null;
  await db.query('UPDATE job_schedules SET prossima_esecuzione = $2, updated_at = now() WHERE id = $1', [id, prossima]);
  return prossima;
}

async function elenco() {
  const { rows } = await db.query(
    `SELECT s.*, t.name AS tenant_name, uc.name AS config_name, uc.cognome AS config_cognome
       FROM job_schedules s
       LEFT JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN users uc ON uc.id = s.utente_config
      ORDER BY t.name NULLS LAST, s.job, s.created_at`
  );
  return rows;
}

router.get('/', async (req, res) => {
  try {
    const tenants = (await db.query('SELECT id, name FROM tenants ORDER BY name')).rows;
    res.json({
      schedulazioni: await elenco(),
      jobs: NOMI_JOB,
      infoJob: INFO_JOB,
      tenants,
      utenti: await utentiDeiTenant(),
      // Stato dello schedulatore NEL BACKEND CHE RISPONDE: in locale è di norma spento.
      schedulerAttivo: schedulerAttivo(),
      adesso: new Date().toISOString()
    });
  } catch (e) {
    res.status(e.code === '42P01' ? 503 : 500).json({
      error: e.code === '42P01' ? 'Tabella job_schedules assente: eseguire Supporto/CreaDB/job_schedules.sql' : e.message
    });
  }
});

router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    const c = await leggiCampi(req.body || {}, false);
    const cols = Object.keys(c);
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO job_schedules (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((k) => c[k])
    );
    await client.query('COMMIT');
    try {
      await verificaUtenteConfig(ins.rows[0].id);
    } catch (e) {
      await db.query('DELETE FROM job_schedules WHERE id = $1', [ins.rows[0].id]);
      throw e;
    }
    await ricalcolaProssima(ins.rows[0].id);
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(e.statusCode || (e.code === '23514' ? 400 : 500)).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    const c = await leggiCampi(req.body || {}, true);
    const cols = Object.keys(c);
    if (cols.length) {
      // Controllo preventivo dell'utente della configurazione rispetto al tenant
      // (quello nuovo, se cambia, altrimenti quello attuale della riga).
      if (c.utente_config || c.tenant_id) {
        const attuale = (await db.query('SELECT tenant_id, utente_config FROM job_schedules WHERE id = $1', [req.params.id])).rows[0];
        if (!attuale) return res.status(404).json({ error: 'Schedulazione non trovata' });
        const tenant = c.tenant_id || attuale.tenant_id;
        const utente = Object.prototype.hasOwnProperty.call(c, 'utente_config') ? c.utente_config : attuale.utente_config;
        if (utente) {
          const ok = await db.query('SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [utente, tenant]);
          if (!ok.rows.length) throw erroreValidazione('L\'utente scelto per la configurazione Jira non appartiene al tenant della schedulazione');
        }
      }
      const r = await db.query(
        `UPDATE job_schedules SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [req.params.id, ...cols.map((k) => c[k])]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Schedulazione non trovata' });
    }
    const prossima = await ricalcolaProssima(req.params.id);
    res.json({ ok: true, prossima_esecuzione: prossima });
  } catch (e) {
    res.status(e.statusCode || (e.code === '23514' ? 400 : 500)).json({ error: e.message });
  }
});

// «Esegui ora»: la esegue lo schedulatore del server al prossimo giro (entro un minuto).
router.post('/:id/esegui-ora', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    const r = await db.query(
      `UPDATE job_schedules SET prossima_esecuzione = now(), updated_at = now()
        WHERE id = $1 AND attivo RETURNING id`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(400).json({ error: 'Schedulazione inesistente o disattivata' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sblocca una riga rimasta "in esecuzione" (es. backend riavviato durante il job).
router.post('/:id/sblocca', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    await db.query('UPDATE job_schedules SET in_esecuzione_dal = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
    await ricalcolaProssima(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    const r = await db.query('DELETE FROM job_schedules WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Schedulazione non trovata' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
