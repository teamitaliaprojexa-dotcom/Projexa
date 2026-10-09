// ============================================================================
// API /api/ai-lavori - finestra «Risultati AI» e scelta "Chiedi sempre" (2026-10-09)
// ----------------------------------------------------------------------------
//   GET    /opzioni?operazione=...  cosa chiedere prima di una funzione AI (config/aiFunzioni.js)
//   GET    /                        lavori in Batch dell'utente (ultimi 7 giorni)
//   GET    /:id                     dettaglio e risultato (dati)
//   GET    /:id/file                scarica il file e lo CANCELLA dal server
//   DELETE /:id                     elimina il lavoro (e il file)
// Solo i lavori dell'utente stesso (tenant + utente della sessione).
// ============================================================================
import express from 'express';
import fs from 'fs/promises';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { opzioniAi, OPERAZIONI } from '../config/aiFunzioni.js';

const router = express.Router();
router.use(requireAuth);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invia = (res, e, tag) => {
  if (e.code === '42P01') return res.status(503).json({ error: 'Modalità Batch non ancora attiva: va eseguito lo script Supporto/CreaDB/ai_lavori.sql' });
  if (!e.status) console.error(`❌ AI_LAVORI ${tag}:`, e.message);
  res.status(e.status || 500).json({ error: e.message, code: e.code });
};

router.get('/opzioni', async (req, res) => {
  try {
    res.json(await opzioniAi(req.user, String(req.query.operazione || '')));
  } catch (e) { invia(res, e, 'OPZIONI'); }
});

async function lavoro(req) {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) throw Object.assign(new Error('Risultato non valido'), { status: 400 });
  const l = (await db.query(
    `SELECT id::text AS id, operazione, titolo, provider, parametri, stato, risultato, file_path, file_nome, file_mime, errore,
            server, creato_il, concluso_il
       FROM ai_lavori WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [id, req.user.tenant_id, req.user.user_id]
  )).rows[0];
  if (!l) throw Object.assign(new Error('Risultato non trovato (forse già eliminato)'), { status: 404 });
  return l;
}

const riga = (l) => ({
  id: l.id, operazione: l.operazione, etichetta: (OPERAZIONI[l.operazione] || {}).etichetta || l.operazione,
  titolo: l.titolo || '', provider: l.provider || '', stato: l.stato, errore: l.errore || '',
  file: !!l.file_path || (OPERAZIONI[l.operazione] || {}).file === true, fileNome: l.file_nome || '',
  creato: l.creato_il, concluso: l.concluso_il
});

router.get('/', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id::text AS id, operazione, titolo, provider, stato, file_path, file_nome, errore, creato_il, concluso_il
         FROM ai_lavori WHERE tenant_id = $1 AND user_id = $2 ORDER BY creato_il DESC LIMIT 200`,
      [req.user.tenant_id, req.user.user_id]
    );
    res.json({ lavori: r.rows.map(riga) });
  } catch (e) { invia(res, e, 'ELENCO'); }
});

router.get('/:id', async (req, res) => {
  try {
    const l = await lavoro(req);
    let p = {};
    try { p = JSON.parse(l.parametri || '{}'); } catch { p = {}; }
    let risultato = null;
    try { risultato = l.risultato ? JSON.parse(l.risultato) : null; } catch { risultato = null; }
    // Della richiesta solo ciò che serve alla finestra (niente dati dell'utente o del file).
    res.json({ ...riga(l), richiesta: { query: p.query || {}, body: p.body || null, extra: p.extra || null }, risultato });
  } catch (e) { invia(res, e, 'DETTAGLIO'); }
});

router.get('/:id/file', async (req, res) => {
  try {
    const l = await lavoro(req);
    if (l.stato === 'scaricato') return res.status(410).json({ error: 'File già scaricato: per sicurezza viene cancellato dal server dopo il download' });
    if (l.stato !== 'pronto' || !l.file_path) return res.status(409).json({ error: 'Il file non è ancora pronto' });
    let dati;
    try { dati = await fs.readFile(l.file_path); } catch {
      return res.status(410).json({ error: 'File non più disponibile su questo server' });
    }
    const nome = l.file_nome || 'risultato';
    res.setHeader('Content-Type', l.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="risultato"; filename*=UTF-8''${encodeURIComponent(nome)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(dati);
    // Scaricato: il file si cancella dal server.
    await fs.rm(l.file_path, { force: true }).catch(() => {});
    await db.query(`UPDATE ai_lavori SET stato = 'scaricato', file_path = NULL WHERE id = $1`, [l.id]);
  } catch (e) { invia(res, e, 'FILE'); }
});

router.delete('/:id', async (req, res) => {
  try {
    const l = await lavoro(req);
    if (l.file_path) await fs.rm(l.file_path, { force: true }).catch(() => {});
    await db.query('DELETE FROM ai_lavori WHERE id = $1', [l.id]);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'ELIMINA'); }
});

export default router;
