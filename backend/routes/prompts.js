// Editor dei prompt AI (pagina prompt-editor.html), tabella app_prompts.
// Aperto a tutti gli utenti autenticati, con due livelli:
//   - admin (id_roles = 1) del tenant PROJEXA: prompt standard (valido per tutti) e
//     personalizzati di qualsiasi tenant + utente;
//   - tutti gli altri: vedono lo standard in sola lettura e gestiscono solo il proprio
//     personalizzato (tenant + utente del contesto, presi dal token, non dalla richiesta).
// Il tenant PROJEXA si verifica sul database (non solo sul nome nel token).
//
// Ambito nelle richieste: tenant_id + user_id (query string o body). Entrambi assenti =
// riga standard.
import express from 'express';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import {
  PROMPT_FUNCTIONS, readPromptFile, getPromptRow, savePrompt, deleteUserPrompt, listUserPrompts
} from '../config/prompts.js';

const router = express.Router();
const MAX_PROMPT_CHARS = 50000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// req.isProjexaAdmin: admin del tenant PROJEXA (gestisce standard e personalizzati di tutti)
async function loadPromptRole(req, res, next) {
  try {
    req.isProjexaAdmin = false;
    if (Number(req.user?.id_roles) === 1) {
      const t = (await db.query('SELECT name FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
      req.isProjexaAdmin = !!t && String(t.name || '').trim().toUpperCase() === 'PROJEXA';
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function requireKnownFunction(req, res, next) {
  const funzione = String(req.params.funzione || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(PROMPT_FUNCTIONS, funzione)) {
    return res.status(404).json({ error: 'Funzione non trovata' });
  }
  req.funzione = funzione;
  next();
}

// Ambito dalla richiesta: { tenantId, userId } oppure entrambi null (standard).
// Per un utente verifica che appartenga davvero a quel tenant.
// Gli utenti non admin possono indicare solo il proprio tenant + utente.
async function readScope(src, req) {
  const tenantId = src.tenant_id ? String(src.tenant_id).trim() : '';
  const userId = src.user_id ? String(src.user_id).trim() : '';
  if (!tenantId && !userId) return { tenantId: null, userId: null };
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(userId)) {
    throw httpError(400, 'Per un prompt personalizzato servono sia tenant_id sia user_id');
  }
  if (!req.isProjexaAdmin &&
      (tenantId.toLowerCase() !== String(req.user.tenant_id).toLowerCase() ||
       userId.toLowerCase() !== String(req.user.user_id).toLowerCase())) {
    throw httpError(403, 'Puoi gestire solo il tuo prompt personalizzato');
  }
  const ok = await db.query(
    'SELECT 1 FROM user_tenants WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, userId]
  );
  if (!ok.rows.length) throw httpError(400, 'L\'utente non appartiene a quel tenant');
  return { tenantId, userId };
}

function sendError(res, e) {
  res.status(e.status || 500).json({ error: e.message });
}

router.use(requireAuth, loadPromptRole);

// Contesto dell'utente per l'editor: permessi e nomi di tenant e utente del login
router.get('/contesto', async (req, res) => {
  try {
    const r = (await db.query(
      `SELECT t.name AS tenant_name, u.name, u.cognome
         FROM tenants t LEFT JOIN users u ON u.id = $2 WHERE t.id = $1`,
      [req.user.tenant_id, req.user.user_id]
    )).rows[0] || {};
    res.json({
      isProjexaAdmin: req.isProjexaAdmin,
      tenant_id: req.user.tenant_id,
      user_id: req.user.user_id,
      tenant_name: r.tenant_name || null,
      user_name: [r.name, r.cognome].filter(Boolean).join(' ') || req.user.email || null
    });
  } catch (e) {
    sendError(res, e);
  }
});

// Elenco delle funzioni con prompt modificabile
router.get('/', (req, res) => {
  res.json(Object.entries(PROMPT_FUNCTIONS).map(([funzione, v]) => ({ funzione, ...v })));
});

// Personalizzazioni esistenti di una funzione, con nomi di tenant e utente
router.get('/:funzione/personalizzazioni', requireKnownFunction, async (req, res) => {
  try {
    let rows = await listUserPrompts(req.funzione);
    if (!req.isProjexaAdmin) {
      rows = rows.filter((r) => String(r.tenant_id) === String(req.user.tenant_id) && String(r.user_id) === String(req.user.user_id));
    }
    if (!rows.length) return res.json([]);
    const names = await db.query(
      `SELECT x.tenant_id, x.user_id, t.name AS tenant_name, u.name, u.cognome
         FROM UNNEST($1::uuid[], $2::uuid[]) AS x(tenant_id, user_id)
         LEFT JOIN tenants t ON t.id = x.tenant_id
         LEFT JOIN users u ON u.id = x.user_id`,
      [rows.map((r) => r.tenant_id), rows.map((r) => r.user_id)]
    );
    const byKey = new Map(names.rows.map((n) => [`${n.tenant_id}|${n.user_id}`, n]));
    res.json(rows.map((r) => {
      const n = byKey.get(`${r.tenant_id}|${r.user_id}`) || {};
      return {
        ...r,
        tenant_name: n.tenant_name || null,
        user_name: [n.name, n.cognome].filter(Boolean).join(' ') || null
      };
    }));
  } catch (e) {
    sendError(res, e);
  }
});

// Prompt di un ambito. Se l'utente non ha una personalizzazione, restituisce il testo
// standard come punto di partenza (esiste: false).
router.get('/:funzione', requireKnownFunction, async (req, res) => {
  try {
    const { tenantId, userId } = await readScope(req.query, req);
    const row = await getPromptRow(req.funzione, tenantId, userId);
    const base = { funzione: req.funzione, ...PROMPT_FUNCTIONS[req.funzione], ambito: tenantId ? 'utente' : 'standard' };
    if (row) return res.json({ ...base, esiste: true, ...row });
    const standard = tenantId ? await getPromptRow(req.funzione, null, null) : null;
    res.json({ ...base, esiste: false, testo: standard ? standard.testo : readPromptFile(req.funzione) });
  } catch (e) {
    sendError(res, e);
  }
});

router.put('/:funzione', requireKnownFunction, async (req, res) => {
  try {
    const { tenantId, userId } = await readScope(req.body || {}, req);
    if (!tenantId && !req.isProjexaAdmin) throw httpError(403, 'Il prompt standard lo modifica solo l\'amministratore di Projexa');
    const testo = typeof req.body?.testo === 'string' ? req.body.testo.replace(/\r\n/g, '\n') : '';
    if (!testo.trim()) throw httpError(400, 'Il testo del prompt non può essere vuoto');
    if (testo.length > MAX_PROMPT_CHARS) throw httpError(400, `Il prompt supera ${MAX_PROMPT_CHARS} caratteri`);
    const autore = req.user.email || req.user.user_id;
    const saved = await savePrompt(req.funzione, tenantId, userId, testo, autore);
    console.log(`[PROMPT] ${req.funzione} (${tenantId ? `tenant ${tenantId} / utente ${userId}` : 'standard'}) aggiornato da ${autore}`);
    res.json({ success: true, esiste: true, ...saved });
  } catch (e) {
    sendError(res, e);
  }
});

// Personalizzato: elimina la riga (l'utente torna al prompt standard).
// Standard: ripristina il testo del file.
router.delete('/:funzione', requireKnownFunction, async (req, res) => {
  try {
    const { tenantId, userId } = await readScope(req.query, req);
    if (!tenantId && !req.isProjexaAdmin) throw httpError(403, 'Il prompt standard lo ripristina solo l\'amministratore di Projexa');
    const autore = req.user.email || req.user.user_id;
    if (tenantId) {
      await deleteUserPrompt(req.funzione, tenantId, userId);
      console.log(`[PROMPT] ${req.funzione} personalizzato (tenant ${tenantId} / utente ${userId}) eliminato da ${autore}`);
    } else {
      const testo = readPromptFile(req.funzione);
      if (!testo.trim()) throw httpError(409, `Il file ${req.funzione.toLowerCase()}.txt è vuoto: ripristino annullato, il prompt standard resta invariato`);
      await savePrompt(req.funzione, null, null, testo, `file (ripristino di ${autore})`);
      console.log(`[PROMPT] ${req.funzione} standard ripristinato dal file da ${autore}`);
    }
    res.json({ success: true });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
