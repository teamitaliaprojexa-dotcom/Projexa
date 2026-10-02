// Campanella della dashboard: notifiche dell'utente del login (tenant + utente presi dal
// token, mai dalla richiesta). Tabella notifiche su projexa_notif
// (Supporto/CreaDB/notifiche.sql); le crea backend/jobs/notifiche.js.
import express from 'express';
import notifDb from '../config/notifDatabase.js';
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
