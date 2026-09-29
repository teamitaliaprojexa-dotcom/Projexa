// === INTEGRAZIONE AI (ChatGPT, Claude, Gemini, Mistral) ===
//
// Stesso schema delle integrazioni Calendar/Jira: i dati di autenticazione stanno sul
// database "Projexa-Auth", tabella integr_tok_auth (vedi config/integrations.js),
// con tipo_integrazione = 'AI' e provider_integrazione = 'ChatGPT' | 'Claude' | 'Gemini' | 'Mistral'.
//
// I fornitori non offrono un login OAuth per usare l'abbonamento personale (ChatGPT Plus,
// Claude Pro, Gemini Advanced) da app esterne: il collegamento avviene con la chiave API
// dell'utente (fatturata a consumo sul suo conto API), salvata cifrata come elemento
// <prefix>_api_key e verificata prima del salvataggio. Copilot non ha un'API pubblica
// per domanda/risposta, quindi non è gestito.
//
// Il backend fa da proxy: la chiave non torna mai al browser.
import express from 'express';
import http from 'http';
import https from 'https';
import Anthropic from '@anthropic-ai/sdk';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegration, saveIntegration, deleteIntegration } from '../config/integrations.js';
import { prepareAttachments, attachmentsText, pdfToText, EXPORT_FORMATS } from '../config/aiAttachments.js';

const router = express.Router();

const TIPO_INTEGRAZIONE = 'AI';
const MAX_PROMPT_CHARS = 20000;

// Modelli: per ChatGPT e Gemini sovrascrivibili da variabile d'ambiente, così un modello
// ritirato dal fornitore si cambia nel .env del server senza toccare il codice.
export const PROVIDERS = {
  chatgpt: { provider: 'ChatGPT', label: 'ChatGPT', prefix: 'chatgpt', model: process.env.OPENAI_MODEL || 'gpt-5' },
  claude: { provider: 'Claude', label: 'Claude', prefix: 'claude', model: 'claude-opus-5' },
  // Gemini: "Flash Lite" di default perché nel piano gratuito ha limiti molto più ampi
  // (es. 15 richieste/minuto e 500/giorno, contro 5 e 20 dei modelli Flash).
  gemini: { provider: 'Gemini', label: 'Gemini', prefix: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest' },
  // Mistral AI (Francia): alias "-latest" aggiornato dal fornitore, sovrascrivibile da MISTRAL_MODEL.
  // "small" è incluso anche nel piano gratuito "Experiment" (il "large" no: errore tier_not_allowed).
  mistral: { provider: 'Mistral', label: 'Mistral', prefix: 'mistral', model: process.env.MISTRAL_MODEL || 'mistral-small-latest' }
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
export async function callApi(url, options, label) {
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
export async function readJson(response, label) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    // OpenAI/Gemini: { error: { message } }; Mistral: { message, type } al primo livello.
    const detail = (data.error && (data.error.message || data.error.status)) || data.message || text.slice(0, 300);
    // Modello non incluso nel piano dell'account (es. Mistral gratuito con modello "large").
    if (data.type === 'tier_not_allowed' || (data.error && data.error.type === 'tier_not_allowed')) {
      throw httpError(403, `${label}: il modello richiesto non è incluso nel tuo piano (${detail}). Usa un modello più piccolo o passa a un piano a pagamento.`);
    }
    // Gemini segnala la chiave errata con 400 "API key not valid" invece di 401.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && /api key/i.test(detail))) {
      throw httpError(400, `Chiave API ${label} non valida o senza permessi${detail ? ` (${String(detail).slice(0, 200)})` : ''}`);
    }
    if (response.status === 429) throw httpError(429, `${label}: limite di utilizzo o credito esaurito (${detail})`);
    const err = httpError(502, `${label} ${response.status}: ${detail}`);
    err.upstreamStatus = response.status; // es. 503 = fornitore sovraccarico (temporaneo)
    throw err;
  }
  return data;
}

// ==========================================
// CHIAMATE AI FORNITORI
// ==========================================
//
// atts (facoltativo): allegati preparati da prepareAttachments (config/aiAttachments.js).
// Immagini e PDF vanno al fornitore così come sono; Word/Excel/testo come testo prima
// della richiesta. Senza allegati le chiamate restano identiche a prima.

function promptWithText(prompt, atts) {
  const files = attachmentsText(atts || []);
  return files ? `${files}\n\n${prompt}` : prompt;
}

// --- Claude (SDK ufficiale Anthropic) ---
// fallbacks "default": se la richiesta viene rifiutata dai filtri di sicurezza, l'API la
// ripete automaticamente su un modello alternativo (server-side, nessuna lista da gestire).
async function askClaude(apiKey, prompt, atts = []) {
  const client = new Anthropic({ apiKey, timeout: 120000, maxRetries: 1 });
  const binary = atts.filter((a) => a.kind === 'image' || a.kind === 'pdf');
  const content = binary.length
    ? [
        ...binary.map((a) => (a.kind === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }
          : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name })),
        { type: 'text', text: promptWithText(prompt, atts) }
      ]
    : promptWithText(prompt, atts);
  try {
    const response = await client.beta.messages.create({
      model: PROVIDERS.claude.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }]
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

// --- ChatGPT (OpenAI) e Mistral: stesso formato "chat completions" ---
const CHAT_COMPLETIONS_BASE = { chatgpt: 'https://api.openai.com/v1', mistral: 'https://api.mistral.ai/v1' };

async function askChatCompletions(key, apiKey, prompt, atts = []) {
  const cfg = PROVIDERS[key];
  // Mistral non legge i PDF nella chat: se ne estrae il testo (i PDF scansionati, senza
  // testo, restano illeggibili). ChatGPT li riceve come file.
  let list = atts;
  if (key === 'mistral' && atts.some((a) => a.kind === 'pdf')) {
    list = [];
    for (const a of atts) {
      if (a.kind !== 'pdf') { list.push(a); continue; }
      const text = await pdfToText(a).catch(() => '');
      list.push({ kind: 'text', name: a.name, text: text || '[PDF senza testo leggibile (probabilmente una scansione)]' });
    }
  }
  const binary = list.filter((a) => a.kind === 'image' || a.kind === 'pdf');
  const text = promptWithText(prompt, list);
  const content = binary.length
    ? [
        { type: 'text', text },
        ...binary.map((a) => {
          const dataUrl = `data:${a.mime};base64,${a.data}`;
          if (a.kind === 'pdf') return { type: 'file', file: { filename: a.name, file_data: dataUrl } };
          return key === 'mistral' ? { type: 'image_url', image_url: dataUrl } : { type: 'image_url', image_url: { url: dataUrl } };
        })
      ]
    : text;
  const send = async () => readJson(await callApi(`${CHAT_COMPLETIONS_BASE[key]}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content }] })
  }, cfg.label), cfg.label);
  let data;
  try {
    data = await send();
  } catch (error) {
    // 429 "rate limit": i piani gratuiti (es. Mistral) ammettono pochissime richieste al
    // secondo; dopo una breve pausa si riprova una volta. Se è finito il credito/quota
    // mensile anche il secondo tentativo fallisce e l'errore arriva all'utente.
    if (error.status !== 429) throw error;
    await new Promise((r) => setTimeout(r, 2000));
    data = await send();
  }
  const choice = (data.choices || [])[0] || {};
  return { text: String((choice.message && choice.message.content) || '').trim(), truncated: choice.finish_reason === 'length' };
}

async function verifyChatCompletionsKey(key, apiKey) {
  await readJson(await callApi(`${CHAT_COMPLETIONS_BASE[key]}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 20000
  }, PROVIDERS[key].label), PROVIDERS[key].label);
}

// --- Gemini (Google AI Studio, Generative Language API) ---
async function geminiGenerate(apiKey, model, prompt, atts = []) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const parts = [
    ...atts.filter((a) => a.kind === 'image' || a.kind === 'pdf').map((a) => ({ inline_data: { mime_type: a.mime, data: a.data } })),
    { text: promptWithText(prompt, atts) }
  ];
  return readJson(await callApi(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }] })
  }, 'Gemini'), 'Gemini');
}

// model: di norma quello configurato; per il ripiego su un modello più leggero
// (Gemini sovraccarico, vedi askAiProvider) se ne passa un altro.
async function askGemini(apiKey, prompt, model = null, atts = []) {
  let data;
  try {
    data = await geminiGenerate(apiKey, model || PROVIDERS.gemini.model, prompt, atts);
  } catch (error) {
    if (model) throw error;
    // Modello ritirato: Google risponde 404 indicando il sostituto ("use models/<nuovo>").
    // Si passa a quello per le richieste successive (va aggiornato GEMINI_MODEL / il default).
    const m = /no longer available[\s\S]*?use models\/([\w.-]+)/i.exec(error.message || '');
    if (!m) throw error;
    console.warn(`[AI] Modello Gemini ${PROVIDERS.gemini.model} ritirato: uso ${m[1]} (aggiornare GEMINI_MODEL)`);
    PROVIDERS.gemini.model = m[1];
    data = await geminiGenerate(apiKey, PROVIDERS.gemini.model, prompt, atts);
  }
  const cand = (data.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  // Immagini generate (modelli Gemini che producono immagini): restituite come file da scaricare.
  const files = parts.map((p) => p.inlineData || p.inline_data).filter((d) => d && d.data)
    .map((d, i) => {
      const mime = d.mimeType || d.mime_type || 'application/octet-stream';
      const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
      return { name: `immagine-${i + 1}.${ext}`, mime, data: d.data };
    });
  if (!text && !files.length && data.promptFeedback && data.promptFeedback.blockReason) {
    throw httpError(422, `Gemini ha bloccato la richiesta (${data.promptFeedback.blockReason})`);
  }
  return { text, files, truncated: cand.finishReason === 'MAX_TOKENS' };
}

async function verifyGeminiKey(apiKey) {
  await readJson(await callApi('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: 20000
  }, 'Gemini'), 'Gemini');
}

const ASK = {
  chatgpt: (k, p, a) => askChatCompletions('chatgpt', k, p, a || []),
  mistral: (k, p, a) => askChatCompletions('mistral', k, p, a || []),
  claude: (k, p, a) => askClaude(k, p, a || []),
  gemini: (k, p, a) => askGemini(k, p, null, a || [])
};
const VERIFY = {
  chatgpt: (k) => verifyChatCompletionsKey('chatgpt', k),
  mistral: (k) => verifyChatCompletionsKey('mistral', k),
  claude: verifyClaudeKey,
  gemini: verifyGeminiKey
};

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
          AND LOWER(BTRIM(campo)) IN ('chatgpt', 'claude', 'gemini', 'mistral', '(*) chatgpt', '(*) claude', '(*) gemini', '(*) mistral')`,
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

// Pulsante "Scarica" della finestra AI: genera al volo il file (Word, PDF, Excel, testo)
// dal testo della risposta e lo restituisce al browser. Nulla viene salvato sul server.
router.post('/export', requireAuth, async (req, res) => {
  try {
    const format = String((req.body && req.body.format) || '').toLowerCase();
    const fmt = Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, format) ? EXPORT_FORMATS[format] : null;
    if (!fmt) return res.status(400).json({ error: 'Formato non supportato' });
    const text = String((req.body && req.body.text) || '');
    if (!text.trim()) return res.status(400).json({ error: 'Nessun testo da scaricare' });
    if (text.length > 2000000) return res.status(413).json({ error: 'Testo troppo lungo' });
    const title = String((req.body && req.body.title) || 'Risposta AI').replace(/[\r\n]/g, ' ').slice(0, 150);
    const buffer = await fmt.build(text, title);
    const fileName = `${title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Risposta AI'}.${format}`;
    res.setHeader('Content-Type', fmt.mime);
    res.setHeader('Content-Disposition', `attachment; filename="export.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    console.error('❌ AI_EXPORT:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Invia una richiesta (una domanda, una risposta) al fornitore con la chiave dell'utente.
router.post('/:provider/chat', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  try {
    // Allegati: solo in memoria per la durata della richiesta, mai salvati.
    const atts = await prepareAttachments(req.body && req.body.files);
    let prompt = String((req.body && req.body.prompt) || '').trim();
    if (!prompt && atts.length) prompt = atts.length > 1 ? 'Analizza i file allegati.' : 'Analizza il file allegato.';
    if (!prompt) return res.status(400).json({ error: 'Scrivi una richiesta' });
    if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: `Richiesta troppo lunga (max ${MAX_PROMPT_CHARS} caratteri)` });

    const el = await getIntegration(req.user.user_id, cfg.provider);
    const apiKey = el[`${cfg.prefix}_api_key`];
    if (!apiKey) return res.status(428).json({ error: `${cfg.label} non collegato: attivalo da Impostazioni › AI`, code: 'AI_NOT_CONNECTED' });

    const key = req.params.provider;
    const { result, model } = await withAiRetry(
      (m) => (m === cfg.model ? ASK[key](apiKey, prompt, atts) : askGemini(apiKey, prompt, m, atts)),
      { label: cfg.label, model: cfg.model, fallbacks: key === 'gemini' ? geminiFallbackModels() : [], profile: 'interactive' }
    );
    res.json({ provider: key, model, text: result.text, files: result.files || [], truncated: !!result.truncated });
  } catch (error) {
    console.error(`❌ AI_CHAT (${req.params.provider}):`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ==========================================
// TESTO GENERATO DA UN'AI SCELTA (es. recap delle riunioni, vedi routes/calendar.js)
// ==========================================
//
// providerName: valore scritto in settings (es. "Gemini", "ChatGPT", "Claude", "Mistral").
// Usa la chiave API collegata dall'utente in Impostazioni › AI. Restituisce { text, label, model }.
export async function askAiProvider(userId, providerName, prompt) {
  const key = String(providerName || '').trim().toLowerCase();
  if (key === 'copilot') throw httpError(400, 'Copilot non è disponibile per il recap: scegli un\'altra AI');
  const cfg = PROVIDERS[key];
  if (!cfg) throw httpError(400, `AI "${providerName}" non riconosciuta per il recap`);
  const el = await getIntegration(userId, cfg.provider);
  const apiKey = el[`${cfg.prefix}_api_key`];
  if (!apiKey) throw httpError(428, `${cfg.label} non collegato: attivalo da Impostazioni › AI`);
  const { result, model } = await withAiRetry(
    (m) => (m === cfg.model ? ASK[key](apiKey, prompt) : askGemini(apiKey, prompt, m)),
    { label: cfg.label, model: cfg.model, fallbacks: key === 'gemini' ? geminiFallbackModels() : [], profile: 'background' }
  );
  return { text: result.text, label: cfg.label, model };
}

// ==========================================
// RECAP PROJEXA: MODELLI LOCALI, GRATUITI (nessuna chiave API)
// ==========================================
//
// Voci del campo "AI generazione e-mail recap" (lookup_values, vedi
// Supporto/CreaDB/recap_projexa_locale.sql):
//   "Recap Projexa (lento)"          -> Ollama sulla VM (OLLAMA_URL, OLLAMA_RECAP_MODEL): gira
//                                       in background, anche a pagina chiusa, ma è lento
//                                       (2 core condivisi con Whisper);
//   "Recap Projexa (Browser-Medio)"  -> modello nel browser dell'utente (WebLLM + WebGPU,
//   "Recap Projexa (Browser-Alto)"      sito/js/browser-recap.js): la trascrizione non esce dal PC.
// Il recap "Browser" non si può fare sul server: lo genera la dashboard.
const LOCAL_RECAP_MODES = {
  'recap projexa (lento)': 'server',
  'recap projexa (browser-medio)': 'browser',
  'recap projexa (browser-alto)': 'browser'
};

// 'server' | 'browser' | null (AI con chiave API)
export function localRecapMode(providerName) {
  return LOCAL_RECAP_MODES[String(providerName || '').trim().toLowerCase()] || null;
}

// Istruzioni per riassumere un pezzo di trascrizione troppo lunga (usate anche dal browser).
export const RECAP_CHUNK_PROMPT = `Questo è un pezzo ({{N}} di {{TOT}}) della trascrizione di una riunione.
Scrivi appunti sintetici in italiano, in testo semplice: argomenti trattati, decisioni prese, azioni (chi, cosa, entro quando), numeri e date citati.
Usa solo informazioni presenti nel testo, senza introduzioni né commenti.

Trascrizione:
{{TESTO}}`;

// Stima prudente: con 3 caratteri/token il contesto risultava troppo piccolo e Ollama, invece
// di dare errore, TAGLIAVA L'INIZIO del prompt (istruzioni + prima parte della riunione):
// il recap parlava solo della fine della call e ignorava il formato richiesto.
const OLLAMA_CHARS_PER_TOKEN = 2.5;
const OLLAMA_MAX_CTX = 32768;          // oltre si riassume a pezzi
const OLLAMA_OUTPUT_TOKENS = 1500;
const OLLAMA_CHUNK_CHARS = 24000;      // ~8.000 token per pezzo

// POST JSON verso Ollama con il modulo http di Node, NON con fetch: fetch (undici) chiude la
// richiesta se le intestazioni della risposta non arrivano entro 5 minuti
// (UND_ERR_HEADERS_TIMEOUT), e Ollama con stream:false risponde solo a recap finito, che su
// CPU richiede decine di minuti. Ogni tentativo moriva a 5 minuti e il recap non finiva mai.
// Qui l'unico limite è timeoutMs, per l'intera richiesta.
function ollamaPost(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        let data = {};
        try { data = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { /* risposta non JSON */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    }, timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload);
  });
}

async function ollamaGenerate(prompt, numCtx, numPredict) {
  const base = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_RECAP_MODEL || 'qwen2.5:7b';
  let response;
  try {
    response = await ollamaPost(`${base}/api/generate`,
      { model, prompt, stream: false, options: { num_ctx: numCtx, num_predict: numPredict, temperature: 0.3 } },
      // Su CPU una riunione lunga può richiedere decine di minuti.
      Number(process.env.OLLAMA_TIMEOUT_MS) || 2 * 60 * 60 * 1000);
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'tempo di attesa scaduto' : (error.code || error.message);
    throw httpError(503, `Recap Projexa: modello locale non raggiungibile (${reason})`);
  }
  const data = response.data || {};
  if (!response.ok) throw httpError(502, `Recap Projexa: ${data.error || `errore ${response.status}`}`);
  const secs = (Number(data.total_duration) || 0) / 1e9;
  const promptTokens = Number(data.prompt_eval_count) || 0;
  console.log(`[RECAP] Ollama ${model}: ${promptTokens || '?'} token letti (contesto ${numCtx}), ${data.eval_count || '?'} scritti in ${Math.round(secs)}s`);
  // Ollama non dà errore se il prompt supera num_ctx: lo accorcia all'intero contesto
  // scartandone l'INIZIO. Prompt che lascia meno di 512 token liberi = troncato (o comunque
  // senza spazio per la risposta).
  const truncated = promptTokens > 0 && promptTokens >= numCtx - Math.min(numPredict, 512);
  if (truncated) console.warn(`⚠️ [RECAP] Ollama: prompt probabilmente troncato (${promptTokens} token su contesto ${numCtx})`);
  return { text: String(data.response || '').trim(), model, truncated };
}

const ctxFor = (chars, outTokens) =>
  Math.min(OLLAMA_MAX_CTX, Math.max(4096, Math.ceil((chars / OLLAMA_CHARS_PER_TOKEN + outTokens + 512) / 1024) * 1024));

// Recap con Ollama. buildPrompt(testo) restituisce il prompt completo (prompt RECAP_EMAIL
// con il testo al posto di {{TRASCRIZIONE}}). Se la trascrizione non sta nel contesto, prima
// si riassume a pezzi e il recap si scrive dagli appunti.
export async function askOllamaRecap(buildPrompt, transcript) {
  // Gli orari "[hh:mm:ss]" a inizio riga non servono al recap e costano molti token
  // (le cifre si spezzano): si tolgono, lasciando nome di chi parla e testo.
  const plain = String(transcript || '').replace(/^\[\d{1,3}:\d{2}(?::\d{2})?\]\s*/gm, '');
  const overhead = (await buildPrompt('')).length;

  // Riassunto a pezzi: appunti per ogni pezzo, poi il recap si scrive dagli appunti.
  const fromNotes = async (pieceChars) => {
    const pieces = splitText(plain, pieceChars);
    const notes = [];
    for (let i = 0; i < pieces.length; i++) {
      const p = RECAP_CHUNK_PROMPT.replace('{{N}}', i + 1).replace('{{TOT}}', pieces.length).replace('{{TESTO}}', pieces[i]);
      notes.push((await ollamaGenerate(p, ctxFor(p.length, 1000), 1000)).text);
    }
    return `(Appunti ricavati dalla trascrizione, riassunta a pezzi)\n\n${notes.join('\n\n')}`;
  };

  const fits = (overhead + plain.length) / OLLAMA_CHARS_PER_TOKEN + OLLAMA_OUTPUT_TOKENS <= OLLAMA_MAX_CTX;
  let prompt = await buildPrompt(fits ? plain : await fromNotes(OLLAMA_CHUNK_CHARS));
  let result = await ollamaGenerate(prompt, ctxFor(prompt.length, OLLAMA_OUTPUT_TOKENS), OLLAMA_OUTPUT_TOKENS);
  // Prompt troncato da Ollama (stima dei token sbagliata): il recap sarebbe fatto solo sulla
  // fine della riunione e senza istruzioni. Si rifà a pezzi più piccoli.
  if (result.truncated) {
    console.warn('⚠️ [RECAP] Ollama: nuovo tentativo riassumendo la trascrizione a pezzi più piccoli');
    prompt = await buildPrompt(await fromNotes(Math.floor(OLLAMA_CHUNK_CHARS / 2)));
    result = await ollamaGenerate(prompt, ctxFor(prompt.length, OLLAMA_OUTPUT_TOKENS), OLLAMA_OUTPUT_TOKENS);
    if (result.truncated) throw httpError(502, 'Recap Projexa: la riunione è troppo lunga per il modello locale');
  }
  return { text: result.text, label: 'Recap Projexa', model: result.model };
}

// Divide il testo in pezzi di circa maxChars, tagliando a fine riga.
export function splitText(text, maxChars) {
  const pieces = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) { pieces.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
    while (cur.length > maxChars) { pieces.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur.trim()) pieces.push(cur);
  return pieces;
}

// ==========================================
// NUOVI TENTATIVI SU ERRORI TEMPORANEI DEL FORNITORE
// ==========================================
//
// Usato da recap (askAiProvider), finestra AI (/:provider/chat) e chatbot (routes/chatbot.js).
// Sovraccarico (500/502/503/529, "high demand"): si riprova lo stesso modello con attese
// crescenti. Se resta sovraccarico, o in caso di limite di richieste (429, es. quota del
// piano gratuito: inutile riprovare lo stesso modello), si passa ai modelli alternativi
// (per Gemini GEMINI_FALLBACK_MODEL, separati da virgola), ognuno con qualche tentativo.
// Profili: 'background' (recap: fino a ~2 minuti sul modello principale, nessuno aspetta a
// schermo) e 'interactive' (chat e chatbot: l'utente aspetta, attese brevi).
const RETRY_PROFILES = {
  background: { waits: [5000, 10000, 20000, 30000, 45000], fallbackAttempts: 3, fallbackWait: 8000 },
  interactive: { waits: [3000, 6000], fallbackAttempts: 2, fallbackWait: 4000 }
};

export const isQuotaError = (e) => e.status === 429 || e.upstreamStatus === 429;
export const isOverloadError = (e) => [500, 502, 503, 529].includes(e.upstreamStatus) || /overloaded|high demand|sovraccaric/i.test(e.message || '');

export function geminiFallbackModels() {
  return String(process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-latest,gemini-3.6-flash,gemini-flash-lite-latest')
    .split(',').map((m) => m.trim()).filter(Boolean);
}

// run(model): esegue la richiesta con il modello indicato. Restituisce { result, model }.
export async function withAiRetry(run, { label, model, fallbacks = [], profile = 'background' }) {
  const p = RETRY_PROFILES[profile] || RETRY_PROFILES.background;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastError;
  for (let attempt = 0; attempt <= p.waits.length; attempt++) {
    try {
      return { result: await run(model), model };
    } catch (error) {
      lastError = error;
      if (!isOverloadError(error) || attempt === p.waits.length) break;
      console.warn(`[AI] ${label} temporaneamente non disponibile (${error.upstreamStatus || error.status}), nuovo tentativo tra ${p.waits[attempt] / 1000}s`);
      await sleep(p.waits[attempt]);
    }
  }
  if (isQuotaError(lastError) || isOverloadError(lastError)) {
    for (const fallback of fallbacks.filter((m) => m !== model)) {
      for (let attempt = 0; attempt < p.fallbackAttempts; attempt++) {
        console.warn(`[AI] ${label} ${model} non disponibile: ripiego su ${fallback} (tentativo ${attempt + 1}/${p.fallbackAttempts})`);
        try {
          return { result: await run(fallback), model: fallback };
        } catch (e) {
          lastError = e;
          if (!isOverloadError(e)) break; // quota esaurita o altro errore: modello successivo
          await sleep(p.fallbackWait);
        }
      }
    }
  }
  throw lastError;
}

// ==========================================
// TRASCRIZIONE AUDIO (riunioni gestite con Projexa, vedi routes/calendar.js)
// ==========================================
//
// La trascrizione NON usa le AI a pagamento/cloud dell'utente: la fa il servizio
// "Projexa Whisper" (cartella whisper-service, Python + faster-whisper, gratuito),
// in esecuzione sulla VM come servizio separato (systemd projexa-whisper@800N) oppure, per
// chi ha scelto "Background-Veloce", whisper.cpp (WHISPER_CPP_URL). Qui si inoltra il blocco WAV e si ricevono
// le frasi con l'orario di inizio. Configurazione: WHISPER_URL e WHISPER_API_KEY.
// Restituisce { segments: [{ start, text }], provider }.
// Indirizzi dei servizi Whisper: WHISPER_URLS (più servizi, separati da virgola, usati in
// parallelo dalla coda di trascrizione) oppure WHISPER_URL (uno solo).
export function whisperUrls() {
  const list = String(process.env.WHISPER_URLS || process.env.WHISPER_URL || '')
    .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
  return [...new Set(list)];
}

// Modalità "Background-Veloce": whisper.cpp sulla VM (systemd projexa-whisper-cpp,
// deploy/oracle/setup-whisper-cpp.sh), stesso modello large-v3-turbo ma motore ottimizzato
// per CPU ARM. Indirizzi: WHISPER_CPP_URLS (più servizi, separati da virgola) oppure
// WHISPER_CPP_URL. Solo su 127.0.0.1: il servizio non ha chiave.
export function whisperCppUrls() {
  const list = String(process.env.WHISPER_CPP_URLS || process.env.WHISPER_CPP_URL || '')
    .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
  return [...new Set(list)];
}

// Blocco WAV su whisper.cpp (endpoint /inference, risposta verbose_json con i segmenti).
async function transcribeAudioCpp(base, audioBuffer, mime) {
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mime || 'audio/wav' }), 'blocco.wav');
      form.append('response_format', 'verbose_json');
      const data = await readJson(await callApi(`${base}/inference`, {
        method: 'POST',
        body: form,
        timeoutMs: 600000
      }, 'Whisper.cpp'), 'Whisper.cpp');
      if (data.error) {
        const err = httpError(502, `Whisper.cpp: ${String(data.error).slice(0, 200)}`);
        err.upstreamStatus = 500;
        throw err;
      }
      // whisper.cpp a volte spezza una parola tra due segmenti ("cedol" + "ini"): il pezzo
      // che continua la parola NON inizia con uno spazio. cont = true segnala il caso, così
      // formatLines lo incolla alla parola precedente invece di andare a capo.
      // Se nessun segmento inizia con uno spazio, il server li ha già "ripuliti": in quel caso
      // non si può distinguere la continuazione di una parola e non si incolla nulla.
      const list = Array.isArray(data.segments) ? data.segments : [];
      const hasSpaces = list.some((x) => /^\s/.test(String(x.text || '')));
      let prevRaw = '';
      const segments = [];
      for (const x of list) {
        const raw = String(x.text || '');
        const text = raw.trim();
        if (!text) continue;
        const cont = hasSpaces && segments.length > 0 && !/^\s/.test(raw) && !/\s$/.test(prevRaw) && /^[\p{L}\p{N}]/u.test(text);
        segments.push({ start: Number(x.start) || 0, end: Number(x.end) || Number(x.start) || 0, text, cont });
        prevRaw = raw;
      }
      return { segments, provider: 'Whisper.cpp large-v3-turbo' };
    } catch (error) {
      const temporary = [429, 500, 502, 503, 504].includes(error.upstreamStatus) || (error.status === 502 && !error.upstreamStatus);
      if (!temporary || attempt >= 3) throw error;
      console.warn(`[AI] Trascrizione Whisper.cpp (${base}): errore temporaneo (${error.upstreamStatus || error.message}), nuovo tentativo ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, attempt === 1 ? 5000 : 15000));
    }
  }
}

// baseUrl: servizio da usare (la coda assegna ogni blocco a un servizio); di default il primo.
// Se baseUrl è un servizio whisper.cpp (WHISPER_CPP_URLS) la richiesta segue il suo formato.
// Restituisce { segments: [{ start, end, text }], provider }.
export async function transcribeAudio(userId, audioBuffer, mime, baseUrl = null) {
  const base = String(baseUrl || whisperUrls()[0] || '').replace(/\/+$/, '');
  if (base && whisperCppUrls().includes(base)) return transcribeAudioCpp(base, audioBuffer, mime);
  if (!base || !process.env.WHISPER_API_KEY) {
    // 428: il browser ferma subito la registrazione invece di riprovare.
    throw httpError(428, 'Servizio di trascrizione non configurato sul server (WHISPER_URLS / WHISPER_URL / WHISPER_API_KEY)');
  }
  // Errori temporanei (servizio in avvio dopo l'inattività, sovraccarico): nuovi tentativi
  // dopo 5 e 15 secondi; se persiste, la coda riprova il blocco più tardi.
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await readJson(await callApi(`${base}/transcribe`, {
        method: 'POST',
        headers: { 'X-Whisper-Key': process.env.WHISPER_API_KEY, 'Content-Type': mime || 'audio/wav' },
        body: audioBuffer,
        timeoutMs: 600000 // su istanze lente un blocco può richiedere alcuni minuti
      }, 'Whisper'), 'Whisper');
      const segments = (Array.isArray(data.segments) ? data.segments : [])
        .map((x) => ({ start: Number(x.start) || 0, end: Number(x.end) || Number(x.start) || 0, text: String(x.text || '').trim() }))
        .filter((x) => x.text);
      return { segments, provider: `Whisper ${data.model || ''}`.trim() };
    } catch (error) {
      const temporary = [429, 500, 502, 503, 504].includes(error.upstreamStatus) || (error.status === 502 && !error.upstreamStatus);
      if (!temporary || attempt >= 3) {
        // Servizio locale non avviato: messaggio con l'istruzione per avviarlo.
        if (/ECONNREFUSED/.test(error.message || '') && /localhost|127\.0\.0\.1/.test(base)) {
          throw httpError(503, `Servizio Whisper non avviato su ${base}: avvia whisper-service/avvia_locale.bat (oppure imposta WHISPER_URL con l'indirizzo del servizio)`);
        }
        throw error;
      }
      console.warn(`[AI] Trascrizione Whisper (${base}): errore temporaneo (${error.upstreamStatus || error.message}), nuovo tentativo ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, attempt === 1 ? 5000 : 15000));
    }
  }
}

export default router;
