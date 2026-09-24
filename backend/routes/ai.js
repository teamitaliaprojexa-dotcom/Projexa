// === INTEGRAZIONE AI (ChatGPT, Claude, Gemini) ===
//
// Stesso schema delle integrazioni Calendar/Jira: i dati di autenticazione stanno sul
// progetto Neon "Projexa-Auth", tabella integr_tok_auth (vedi config/integrations.js),
// con tipo_integrazione = 'AI' e provider_integrazione = 'ChatGPT' | 'Claude' | 'Gemini'.
//
// I fornitori non offrono un login OAuth per usare l'abbonamento personale (ChatGPT Plus,
// Claude Pro, Gemini Advanced) da app esterne: il collegamento avviene con la chiave API
// dell'utente (fatturata a consumo sul suo conto API), salvata cifrata come elemento
// <prefix>_api_key e verificata prima del salvataggio. Copilot non ha un'API pubblica
// per domanda/risposta, quindi non è gestito.
//
// Il backend fa da proxy: la chiave non torna mai al browser.
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegration, saveIntegration, deleteIntegration } from '../config/integrations.js';

const router = express.Router();

const TIPO_INTEGRAZIONE = 'AI';
const MAX_PROMPT_CHARS = 20000;

// Modelli: per ChatGPT e Gemini sovrascrivibili da variabile d'ambiente, così un modello
// ritirato dal fornitore si cambia su Render senza toccare il codice.
const PROVIDERS = {
  chatgpt: { provider: 'ChatGPT', label: 'ChatGPT', prefix: 'chatgpt', model: process.env.OPENAI_MODEL || 'gpt-5' },
  claude: { provider: 'Claude', label: 'Claude', prefix: 'claude', model: 'claude-opus-5' },
  gemini: { provider: 'Gemini', label: 'Gemini', prefix: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' }
};

function requireProvider(req, res, next) {
  const cfg = PROVIDERS[req.params.provider];
  if (!cfg) return res.status(404).json({ error: 'Provider AI non supportato' });
  req.aiProvider = cfg;
  next();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// fetch verso un fornitore AI. Gli errori di rete di Node ("fetch failed") nascondono il
// motivo in error.cause: lo si riporta (DNS, connessione, certificato, timeout) e si
// riprova una volta, perché spesso sono intoppi momentanei.
async function callApi(url, options, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 120000) });
    } catch (error) {
      const cause = error.cause ? (error.cause.code || error.cause.message) : '';
      const reason = error.name === 'TimeoutError' ? 'tempo di attesa scaduto' : (cause || error.message);
      console.error(`[AI] ${label} irraggiungibile (tentativo ${attempt}):`, error.message, cause);
      if (attempt >= 2 || error.name === 'TimeoutError') {
        throw httpError(502, `${label}: impossibile contattare il servizio dal server Projexa (${reason})`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

// Legge la risposta di un'API esterna e trasforma gli errori in messaggi comprensibili.
async function readJson(response, label) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const detail = (data.error && (data.error.message || data.error.status)) || text.slice(0, 300);
    // Gemini segnala la chiave errata con 400 "API key not valid" invece di 401.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && /api key/i.test(detail))) {
      throw httpError(400, `Chiave API ${label} non valida o senza permessi`);
    }
    if (response.status === 429) throw httpError(429, `${label}: limite di utilizzo o credito esaurito (${detail})`);
    throw httpError(502, `${label} ${response.status}: ${detail}`);
  }
  return data;
}

// ==========================================
// CHIAMATE AI FORNITORI
// ==========================================

// --- Claude (SDK ufficiale Anthropic) ---
// fallbacks "default": se la richiesta viene rifiutata dai filtri di sicurezza, l'API la
// ripete automaticamente su un modello alternativo (server-side, nessuna lista da gestire).
async function askClaude(apiKey, prompt) {
  const client = new Anthropic({ apiKey, timeout: 120000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: PROVIDERS.claude.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }]
    });
    if (response.stop_reason === 'refusal') {
      throw httpError(422, 'Claude ha rifiutato la richiesta' + (response.stop_details && response.stop_details.explanation ? `: ${response.stop_details.explanation}` : ''));
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, truncated: response.stop_reason === 'max_tokens' };
  } catch (error) {
    if (error.status && !(error instanceof Anthropic.APIError)) throw error;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw httpError(400, 'Chiave API Claude non valida o senza permessi');
    if (error instanceof Anthropic.RateLimitError) throw httpError(429, 'Claude: limite di utilizzo raggiunto, riprova tra poco');
    if (error instanceof Anthropic.APIError) throw httpError(502, `Claude ${error.status || ''}: ${error.message}`);
    throw error;
  }
}

async function verifyClaudeKey(apiKey) {
  const client = new Anthropic({ apiKey, timeout: 20000, maxRetries: 0 });
  try {
    await client.models.retrieve(PROVIDERS.claude.model);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw httpError(400, 'Chiave API Claude non valida');
    if (error instanceof Anthropic.APIError) throw httpError(502, `Verifica chiave Claude non riuscita: ${error.message}`);
    throw error;
  }
}

// --- ChatGPT (OpenAI Chat Completions) ---
async function askChatGpt(apiKey, prompt) {
  const data = await readJson(await callApi('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: PROVIDERS.chatgpt.model, messages: [{ role: 'user', content: prompt }] })
  }, 'ChatGPT'), 'ChatGPT');
  const choice = (data.choices || [])[0] || {};
  return { text: String((choice.message && choice.message.content) || '').trim(), truncated: choice.finish_reason === 'length' };
}

async function verifyChatGptKey(apiKey) {
  await readJson(await callApi('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 20000
  }, 'ChatGPT'), 'ChatGPT');
}

// --- Gemini (Google AI Studio, Generative Language API) ---
async function askGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(PROVIDERS.gemini.model)}:generateContent`;
  const data = await readJson(await callApi(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
  }, 'Gemini'), 'Gemini');
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('').trim();
  if (!text && data.promptFeedback && data.promptFeedback.blockReason) {
    throw httpError(422, `Gemini ha bloccato la richiesta (${data.promptFeedback.blockReason})`);
  }
  return { text, truncated: cand.finishReason === 'MAX_TOKENS' };
}

async function verifyGeminiKey(apiKey) {
  await readJson(await callApi('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: 20000
  }, 'Gemini'), 'Gemini');
}

const ASK = { chatgpt: askChatGpt, claude: askClaude, gemini: askGemini };
const VERIFY = { chatgpt: verifyChatGptKey, claude: verifyClaudeKey, gemini: verifyGeminiKey };

// ==========================================
// ENDPOINT
// ==========================================

// Stato per l'utente: collegato (chiave salvata) e abilitato (toggle in settings,
// campo = nome del provider, valore1 = true). La barra laterale mostra le AI con entrambi.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const flags = await db.query(
      `SELECT LOWER(BTRIM(campo)) AS campo, valore1 FROM settings
        WHERE tenant_id = $1 AND user_id = $2
          AND LOWER(BTRIM(campo)) IN ('chatgpt', 'claude', 'gemini', '(*) chatgpt', '(*) claude', '(*) gemini')`,
      [req.user.tenant_id, req.user.user_id]
    );
    const enabled = {};
    for (const r of flags.rows) {
      const key = r.campo.replace('(*) ', '');
      if (r.valore1 === true || r.valore1 === 't' || r.valore1 === 'true') enabled[key] = true;
    }
    const out = {};
    for (const key of Object.keys(PROVIDERS)) {
      const cfg = PROVIDERS[key];
      const el = await getIntegration(req.user.user_id, cfg.provider);
      out[key] = { label: cfg.label, connected: !!el[`${cfg.prefix}_api_key`], enabled: !!enabled[key], model: cfg.model };
    }
    res.json({ providers: out });
  } catch (error) {
    console.error('❌ AI_STATUS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Salva la chiave API dopo averla verificata presso il fornitore.
router.post('/:provider/key', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  try {
    const apiKey = String((req.body && req.body.api_key) || '').trim();
    if (apiKey.length < 20 || /\s/.test(apiKey)) return res.status(400).json({ error: 'Chiave API non valida' });
    await VERIFY[req.params.provider](apiKey);
    await saveIntegration(req.user.user_id, cfg.provider, TIPO_INTEGRAZIONE, { [`${cfg.prefix}_api_key`]: apiKey });
    console.log(`[AI:${req.params.provider}] ✓ Chiave collegata per l'utente ${req.user.user_id}`);
    res.json({ success: true });
  } catch (error) {
    console.error(`❌ AI_KEY (${req.params.provider}):`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/:provider/disconnect', requireAuth, requireProvider, async (req, res) => {
  try {
    const removed = await deleteIntegration(req.user.user_id, req.aiProvider.provider);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('❌ AI_DISCONNECT:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Invia una richiesta (una domanda, una risposta) al fornitore con la chiave dell'utente.
router.post('/:provider/chat', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  try {
    const prompt = String((req.body && req.body.prompt) || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Scrivi una richiesta' });
    if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: `Richiesta troppo lunga (max ${MAX_PROMPT_CHARS} caratteri)` });

    const el = await getIntegration(req.user.user_id, cfg.provider);
    const apiKey = el[`${cfg.prefix}_api_key`];
    if (!apiKey) return res.status(428).json({ error: `${cfg.label} non collegato: attivalo da Impostazioni › AI`, code: 'AI_NOT_CONNECTED' });

    const result = await ASK[req.params.provider](apiKey, prompt);
    res.json({ provider: req.params.provider, model: cfg.model, text: result.text, truncated: !!result.truncated });
  } catch (error) {
    console.error(`❌ AI_CHAT (${req.params.provider}):`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
