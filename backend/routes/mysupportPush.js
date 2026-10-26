// ============================================================================
// MYSUPPORT INVIATO DAL PC (interruttore «DataBricks», 2026-10-17)
// ----------------------------------------------------------------------------
// Il file «MySupport.xlsx» lo crea sul PC dell'utente uno script schedulato che legge
// Databricks (Documenti\Claude\Report\Programmi\MySupport-Report.ps1). Subito dopo, lo stesso
// script invia le righe a Projexa (POST /api/mysupport/push, in server.js) con un TOKEN
// dedicato: Projexa non deve più leggere la cartella del PC né restare aperta nel browser.
//
// Il token lo genera l'utente in Impostazioni › «DataBricks» (acceso = token generato e
// mostrato UNA volta sola, da incollare in config.json dello script; spento = token revocato).
// Nella tabella api_token (Supporto/CreaDB/mysupport_push.sql) c'è solo l'impronta SHA-256.
// Il token vale per l'utente che l'ha generato: l'import usa il suo tenant.
// ============================================================================
import express from 'express';
import crypto from 'crypto';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { notificaMySupportScript } from '../jobs/notifiche.js';

const router = express.Router();
const SCOPO = 'mysupport_push';
const PREFISSO = 'pxms_';

const impronta = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Utente del token (o null). Usato da POST /api/mysupport/push: header «Authorization: Bearer pxms_…».
export async function utenteDaTokenPush(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!m || !m[1].startsWith(PREFISSO)) return null;
  // L'utente deve appartenere ancora al tenant del token (uscito dall'azienda = token inutile).
  const r = await db.query(
    `SELECT t.id, t.tenant_id, t.user_id FROM api_token t
      WHERE t.token_hash = $1 AND t.scopo = $2
        AND EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = t.user_id AND ut.tenant_id = t.tenant_id)`,
    [impronta(m[1]), SCOPO]);
  return r.rows[0] || null;
}

// Limite di richieste per /api/mysupport/push (in memoria, finestra di 10 minuti): un invio
// normale sono pochi blocchi da 5000 righe, quindi 120 richieste per IP bastano e avanzano.
const PUSH_FINESTRA_MS = 10 * 60 * 1000;
const PUSH_MAX = 120;
const pushContatori = new Map();
export function pushLimitato(chiave) {
  const ora = Date.now();
  let c = pushContatori.get(chiave);
  if (!c || ora - c.inizio > PUSH_FINESTRA_MS) { c = { inizio: ora, n: 0 }; pushContatori.set(chiave, c); }
  c.n += 1;
  if (pushContatori.size > 5000) {
    for (const [k, v] of pushContatori) if (ora - v.inizio > PUSH_FINESTRA_MS) pushContatori.delete(k);
  }
  return c.n > PUSH_MAX;
}

// Esito di un blocco inviato: i totali di un invio (blocchi 1..n) si sommano in ultimo_report.
export async function registraInvioPush(tokenId, blocco, blocchi, esito) {
  const r = (await db.query('SELECT ultimo_report FROM api_token WHERE id = $1', [tokenId])).rows[0];
  const prec = blocco > 1 && r && r.ultimo_report ? r.ultimo_report : {};
  const somma = (k) => (Number(prec[k]) || 0) + (Number(esito[k]) || 0);
  const report = {
    blocchi, ricevuti: blocco,
    totale: somma('totale'), inserted: somma('inserted'), updated: somma('updated'),
    unchanged: somma('unchanged'), invalid: somma('invalid'),
    nonTrovati: somma('nonTrovati'), ambigui: somma('ambigui')
  };
  await db.query('UPDATE api_token SET ultimo_uso = now(), ultimo_report = $2 WHERE id = $1', [tokenId, JSON.stringify(report)]);
}

// Riga «DataBricks» del settings dell'utente (anche «(*) DataBricks»): valore1 = interruttore.
async function impostaInterruttore(user, acceso) {
  await db.query(
    `UPDATE settings SET valore1 = $3, valore2 = NULL
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(regexp_replace(campo, '^\\(\\*\\)\\s*', ''))) = 'databricks'`,
    [user.tenant_id, user.user_id, acceso]);
}

function tabellaMancante(res, e) {
  if (e.code !== '42P01') return false;
  res.status(503).json({ error: 'Tabella api_token mancante: eseguire Supporto/CreaDB/mysupport_push.sql' });
  return true;
}

// Stato per Impostazioni: token presente, quando è stato creato, ultimo invio ricevuto.
router.get('/token', requireAuth, async (req, res) => {
  try {
    const r = (await db.query(
      'SELECT creato_il, ultimo_uso, ultimo_report FROM api_token WHERE tenant_id = $1 AND user_id = $2 AND scopo = $3',
      [req.user.tenant_id, req.user.user_id, SCOPO])).rows[0];
    res.json(r ? { attivo: true, creatoIl: r.creato_il, ultimoUso: r.ultimo_uso, ultimoReport: r.ultimo_report } : { attivo: false });
  } catch (e) {
    if (tabellaMancante(res, e)) return;
    console.error('[MYSUPPORT PUSH] stato:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Genera (o rigenera: il precedente smette di funzionare) il token e lo restituisce in chiaro,
// l'unica volta in cui si vede. Accende anche l'interruttore «DataBricks».
router.post('/token', requireAuth, async (req, res) => {
  try {
    const token = PREFISSO + crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO api_token (tenant_id, user_id, scopo, token_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id, scopo) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, creato_il = now(), ultimo_uso = NULL, ultimo_report = NULL`,
      [req.user.tenant_id, req.user.user_id, SCOPO, impronta(token)]);
    await impostaInterruttore(req.user, true);
    console.log(`[MYSUPPORT PUSH] ${req.user.email || req.user.user_id}: token generato`);
    res.json({ token });
  } catch (e) {
    if (tabellaMancante(res, e)) return;
    console.error('[MYSUPPORT PUSH] genera token:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Avviso dallo script del PC (2026-10-23): oggi solo «login Databricks scaduto», che prima si
// vedeva soltanto nel log del PC (e ci si accorgeva giorni dopo dal file vecchio). Stesso token
// del push. Body: { tipo: 'login_databricks', dettaglio? } -> notifica in campanella.
const AVVISI = {
  login_databricks: {
    titolo: 'MySupport: login Databricks scaduto',
    messaggio: 'Il report MySupport del PC non riesce più ad accedere a Databricks e i dati MySupport non si aggiornano. Rifai il login dal PC: comando «databricks auth login» nel file LEGGIMI.md dello script (Documenti\\Claude\\Report\\Programmi).'
  }
};
router.post('/avviso', async (req, res) => {
  try {
    if (pushLimitato('ip:' + (req.ip || ''))) return res.status(429).json({ error: 'Troppe richieste: riprova tra qualche minuto' });
    const tok = await utenteDaTokenPush(req);
    if (!tok) return res.status(401).json({ error: 'Token non valido o revocato: generane uno nuovo in Impostazioni › Databricks' });
    const tipo = String((req.body && req.body.tipo) || '');
    const a = AVVISI[tipo];
    if (!a) return res.status(400).json({ error: 'Avviso sconosciuto' });
    const dettaglio = String((req.body && req.body.dettaglio) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    await notificaMySupportScript({ tenantId: tok.tenant_id, userId: tok.user_id, tipo, titolo: a.titolo, messaggio: dettaglio ? `${a.messaggio} Errore: ${dettaglio}` : a.messaggio });
    console.warn(`[MYSUPPORT PUSH] utente ${tok.user_id}: avviso dallo script del PC (${tipo})`);
    res.json({ ok: true });
  } catch (e) {
    if (tabellaMancante(res, e)) return;
    console.error('[MYSUPPORT PUSH] avviso:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Interruttore spento: token revocato (lo script del PC riceverà 401).
router.delete('/token', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM api_token WHERE tenant_id = $1 AND user_id = $2 AND scopo = $3',
      [req.user.tenant_id, req.user.user_id, SCOPO]);
    await impostaInterruttore(req.user, false);
    console.log(`[MYSUPPORT PUSH] ${req.user.email || req.user.user_id}: token revocato`);
    res.json({ ok: true });
  } catch (e) {
    if (tabellaMancante(res, e)) return;
    console.error('[MYSUPPORT PUSH] revoca token:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
