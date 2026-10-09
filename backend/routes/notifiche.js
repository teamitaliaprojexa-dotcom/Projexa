// Campanella della dashboard: notifiche dell'utente del login (tenant + utente presi dal
// token, mai dalla richiesta). Tabella notifiche su projexa_notif
// (Supporto/CreaDB/notifiche.sql); le crea backend/jobs/notifiche.js.
import express from 'express';
import notifDb from '../config/notifDatabase.js';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

const MAX_ELENCO = 200;

function errore(res, e) {
  if (e.code === '42P01') return res.status(503).json({ error: 'Notifiche non attive: eseguire Supporto/CreaDB/notifiche.sql su projexa_notif' });
  console.error('[NOTIFICHE]', e.message);
  res.status(e.status || 500).json({ error: e.message });
}

// Id scelti dall'utente (numeri) oppure tutte le sue: { ids: [...] } | { tutte: true }.
function selezione(body) {
  const b = body || {};
  if (b.tutte === true) return { tutte: true, ids: [] };
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x)).filter((x) => /^\d{1,18}$/.test(x)))];
  if (!ids.length) throw Object.assign(new Error('Nessuna notifica selezionata'), { status: 400 });
  return { tutte: false, ids };
}

// Numero da leggere (il pallino rosso): chiamato spesso, una sola query sull'indice.
router.get('/conteggio', async (req, res) => {
  try {
    const r = await notifDb.query(
      'SELECT count(*)::int AS n FROM notifiche WHERE tenant_id = $1 AND user_id = $2 AND NOT letta',
      [req.user.tenant_id, req.user.user_id]
    );
    res.json({ nonLette: r.rows[0].n });
  } catch (e) {
    errore(res, e);
  }
});

// «Vai» delle notifiche Jira (task, quotazioni) e MySupport: dalla riga (sempre dell'utente del
// login) si ricava cliente e progetto; con il progetto si apre la scheda del progetto, altrimenti
// quella del cliente. Nella scheda si cerca la griglia (tipo 11/13) di quella tabella e i Nodi
// Padre da attraversare per arrivarci (path). Nessun progetto/griglia: si apre solo la scheda.
const VAI_TABELLE = new Set(['task_app', 'cl_quotazioni', 'mysupport']);
async function destinazioniVai(notifiche, user) {
  const perTabella = new Map();
  for (const n of notifiche) {
    if (!VAI_TABELLE.has(n.tabella) || !/^[0-9a-f-]{36}$/i.test(String(n.riga_id || ''))) continue;
    if (!perTabella.has(n.tabella)) perTabella.set(n.tabella, new Set());
    perTabella.get(n.tabella).add(String(n.riga_id));
  }
  const righe = new Map(); // "tabella|id" -> { client_id, project_id }
  for (const [tabella, ids] of perTabella) {
    const r = await db.query(
      `SELECT id::text AS id, client_id::text AS client_id,
              ${tabella === 'mysupport' ? 'NULL' : 'project_id::text'} AS project_id
         FROM "${tabella}" WHERE id::text = ANY($1) AND tenant_id = $2 AND user_id = $3`,
      [[...ids], user.tenant_id, user.user_id]
    );
    for (const x of r.rows) righe.set(`${tabella}|${x.id}`, x);
  }
  const cache = new Map(); // destinazione già calcolata per "tabella|cliente|progetto"
  const nomi = new Map();
  const nome = async (source, id) => {
    const k = `${source}|${id}`;
    if (!nomi.has(k)) {
      const r = await db.query(`SELECT valore2 FROM "${source}" WHERE id::text = $1 LIMIT 1`, [id]);
      nomi.set(k, r.rows[0]?.valore2 || '');
    }
    return nomi.get(k);
  };
  for (const n of notifiche) {
    const riga = righe.get(`${n.tabella}|${n.riga_id}`);
    if (!riga || !riga.client_id) continue;
    const k = `${n.tabella}|${riga.client_id}|${riga.project_id || ''}`;
    if (!cache.has(k)) {
      const source = riga.project_id ? 'projects' : 'clients';
      const root = riga.project_id || riga.client_id;
      // Griglia della tabella nella scheda (righe della scheda: master_id = id del cliente/progetto).
      const g = await db.query(
        `SELECT id::text AS id, argument FROM "${source}"
          WHERE master_id::text = $1 AND tenant_id = $2 AND user_id = $3 AND tabella = $4
            AND tipo_valore::text IN ('11', '13') AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
          ORDER BY ordinamento NULLS LAST LIMIT 1`,
        [root, user.tenant_id, user.user_id, n.tabella]
      );
      const path = [];
      let fieldId = null;
      if (g.rows[0]) {
        fieldId = g.rows[0].id;
        let arg = String(g.rows[0].argument || '');
        for (let i = 0; i < 6 && arg && arg !== root && /^[0-9a-f-]{36}$/i.test(arg); i++) {
          const p = await db.query(`SELECT id::text AS id, argument, campo FROM "${source}" WHERE id::text = $1 LIMIT 1`, [arg]);
          if (!p.rows[0]) break;
          path.unshift({ id: p.rows[0].id, campo: String(p.rows[0].campo || '') });
          arg = String(p.rows[0].argument || '');
        }
      }
      cache.set(k, {
        clientId: riga.client_id,
        clientName: await nome('clients', riga.client_id),
        projectId: riga.project_id || null,
        projectName: riga.project_id ? await nome('projects', riga.project_id) : null,
        fieldId,
        path
      });
    }
    n.vai = cache.get(k);
  }
}

// Elenco: prima le non lette, poi le più recenti.
router.get('/', async (req, res) => {
  try {
    const r = await notifDb.query(
      `SELECT id::text AS id, fonte, titolo, messaggio, tabella, riga_id, conteggio, letta, creata_il, aggiornata_il
         FROM notifiche WHERE tenant_id = $1 AND user_id = $2
        ORDER BY letta, aggiornata_il DESC, id DESC
        LIMIT ${MAX_ELENCO}`,
      [req.user.tenant_id, req.user.user_id]
    );
    const n = await notifDb.query(
      'SELECT count(*)::int AS tot, count(*) FILTER (WHERE NOT letta)::int AS non_lette FROM notifiche WHERE tenant_id = $1 AND user_id = $2',
      [req.user.tenant_id, req.user.user_id]
    );
    try { await destinazioniVai(r.rows, req.user); } catch (e) { console.warn('[NOTIFICHE] «Vai» non calcolato:', e.message); }
    res.json({ notifiche: r.rows, totale: n.rows[0].tot, nonLette: n.rows[0].non_lette, limite: MAX_ELENCO });
  } catch (e) {
    errore(res, e);
  }
});

// Segna come lette.
router.post('/lette', express.json(), async (req, res) => {
  try {
    const s = selezione(req.body);
    const r = await notifDb.query(
      `UPDATE notifiche SET letta = true, letta_il = now()
        WHERE tenant_id = $1 AND user_id = $2 AND NOT letta ${s.tutte ? '' : 'AND id = ANY($3::bigint[])'}`,
      s.tutte ? [req.user.tenant_id, req.user.user_id] : [req.user.tenant_id, req.user.user_id, s.ids]
    );
    res.json({ aggiornate: r.rowCount });
  } catch (e) {
    errore(res, e);
  }
});

// Elimina (selezionate o tutte).
router.post('/elimina', express.json(), async (req, res) => {
  try {
    const s = selezione(req.body);
    const r = await notifDb.query(
      `DELETE FROM notifiche WHERE tenant_id = $1 AND user_id = $2 ${s.tutte ? '' : 'AND id = ANY($3::bigint[])'}`,
      s.tutte ? [req.user.tenant_id, req.user.user_id] : [req.user.tenant_id, req.user.user_id, s.ids]
    );
    res.json({ eliminate: r.rowCount });
  } catch (e) {
    errore(res, e);
  }
});

export default router;
