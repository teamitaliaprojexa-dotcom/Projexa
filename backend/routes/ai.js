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
//
// ANONYMIZATION LAYER (2026-10-22, config/pii.js): prima di ogni invio a queste AI esterne
// (finestra AI, askAiProvider, Batch) i dati personali diventano segnaposto ([PERSONA_1]...) e
// nella risposta tornano i valori veri.
//
// 2026-10-29: tolta l'AI interna («Projexa», Ollama sulla VM) e il suo addestramento: le
// funzioni AI usano solo queste AI esterne.
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegration, saveIntegration, deleteIntegration, updateIntegrationElements, deleteIntegrationElement } from '../config/integrations.js';
import { contestoAi } from '../config/aiContesto.js';
import { prepareAttachments, attachmentsText, pdfToText, EXPORT_FORMATS } from '../config/aiAttachments.js';
import { anonimizzaPrompt, salvaMappaBatch, ripristinaBatch, statoAnonimizzazione } from '../config/pii.js';

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

// Versione scelta dall'utente in Impostazioni › AI (elemento "<prefix>_model" della sua
// integrazione), altrimenti quella predefinita qui sopra.
const modelloUtente = (cfg, el) => el[`${cfg.prefix}_model`] || cfg.model;

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
async function askClaude(apiKey, prompt, atts = [], model = PROVIDERS.claude.model) {
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
      model,
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

// opzioni.json (es. Kick-off): risposta solo JSON e, dove il modello lo consente, temperatura
// bassa, così rilanciando la stessa richiesta il risultato cambia poco. Senza opzioni le
// chiamate restano identiche a prima.
const TEMPERATURA_JSON = 0.2;

async function askChatCompletions(key, apiKey, prompt, atts = [], opzioni = {}, model = PROVIDERS[key].model) {
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
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      // ChatGPT (gpt-5) accetta solo la temperatura predefinita: lì solo il formato JSON.
      ...(opzioni.json ? { response_format: { type: 'json_object' } } : {}),
      ...(opzioni.json && key === 'mistral' ? { temperature: TEMPERATURA_JSON } : {})
    })
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
async function geminiGenerate(apiKey, model, prompt, atts = [], opzioni = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const parts = [
    ...atts.filter((a) => a.kind === 'image' || a.kind === 'pdf').map((a) => ({ inline_data: { mime_type: a.mime, data: a.data } })),
    { text: promptWithText(prompt, atts) }
  ];
  return readJson(await callApi(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      ...(opzioni.json ? { generationConfig: { temperature: TEMPERATURA_JSON, responseMimeType: 'application/json' } } : {})
    })
  }, 'Gemini'), 'Gemini');
}

// model: di norma quello configurato; per il ripiego su un modello più leggero
// (Gemini sovraccarico, vedi askAiProvider) se ne passa un altro.
async function askGemini(apiKey, prompt, model = null, atts = [], opzioni = {}) {
  let data;
  try {
    data = await geminiGenerate(apiKey, model || PROVIDERS.gemini.model, prompt, atts, opzioni);
  } catch (error) {
    if (model) throw error;
    // Modello ritirato: Google risponde 404 indicando il sostituto ("use models/<nuovo>").
    // Si passa a quello per le richieste successive (va aggiornato GEMINI_MODEL / il default).
    const m = /no longer available[\s\S]*?use models\/([\w.-]+)/i.exec(error.message || '');
    if (!m) throw error;
    console.warn(`[AI] Modello Gemini ${PROVIDERS.gemini.model} ritirato: uso ${m[1]} (aggiornare GEMINI_MODEL)`);
    PROVIDERS.gemini.model = m[1];
    data = await geminiGenerate(apiKey, PROVIDERS.gemini.model, prompt, atts, opzioni);
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

// m: modello da usare (scelto dall'utente o di ripiego); senza, quello predefinito.
const ASK = {
  chatgpt: (k, p, a, o, m) => askChatCompletions('chatgpt', k, p, a || [], o || {}, m),
  mistral: (k, p, a, o, m) => askChatCompletions('mistral', k, p, a || [], o || {}, m),
  claude: (k, p, a, o, m) => askClaude(k, p, a || [], m),
  // Col modello predefinito si passa null: askGemini gestisce così il modello ritirato.
  gemini: (k, p, a, o, m) => askGemini(k, p, m && m !== PROVIDERS.gemini.model ? m : null, a || [], o || {})
};

// --- Elenco dei modelli disponibili con la chiave dell'utente (menu "Versione") ---
// Si leggono dal fornitore, così l'elenco resta aggiornato senza toccare il codice; si
// escludono i modelli che non rispondono a una richiesta di testo (immagini, audio,
// embedding...) o che non funzionano con l'API usata da Projexa. Restituisce [{ id, nome }].
async function listChatCompletionsModels(key, apiKey) {
  const label = PROVIDERS[key].label;
  const data = await readJson(await callApi(`${CHAT_COMPLETIONS_BASE[key]}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 20000
  }, label), label);
  const rows = data.data || [];
  if (key === 'chatgpt') {
    // Esclusi anche le versioni datate (gpt-5-2025-08-07: uguali all'alias) e i modelli
    // "-pro" / "deep-research" / "codex", disponibili solo con un'altra API di OpenAI.
    return rows.map((r) => r.id)
      .filter((id) => /^(gpt-|o\d|chatgpt-)/i.test(id))
      .filter((id) => !/(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|codex|computer-use|deep-research|-pro\b|-\d{4}-\d{2}-\d{2}$)/i.test(id))
      .map((id) => ({ id, nome: id }));
  }
  return rows
    .filter((r) => !r.capabilities || r.capabilities.completion_chat)
    .filter((r) => !r.deprecation && !/(embed|moderation|ocr)/i.test(r.id))
    .map((r) => ({ id: r.id, nome: r.id }));
}

async function listClaudeModels(apiKey) {
  const client = new Anthropic({ apiKey, timeout: 20000, maxRetries: 0 });
  const out = [];
  try {
    for await (const m of client.models.list({ limit: 100 })) {
      // I Claude 3 non accettano i 16.000 token di risposta chiesti da askClaude.
      if (!/^claude-3/i.test(m.id)) out.push({ id: m.id, nome: m.display_name || m.id });
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw httpError(400, 'Chiave API Claude non valida');
    if (error instanceof Anthropic.APIError) throw httpError(502, `Elenco modelli Claude non disponibile: ${error.message}`);
    throw error;
  }
  return out;
}

async function listGeminiModels(apiKey) {
  const data = await readJson(await callApi('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: 20000
  }, 'Gemini'), 'Gemini');
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), nome: m.displayName || '' }))
    .filter((m) => /^gemini/i.test(m.id) && !/(embedding|tts|live|native-audio)/i.test(m.id))
    .map((m) => ({ id: m.id, nome: m.nome && m.nome !== m.id ? `${m.nome} (${m.id})` : m.id }));
}

const LIST_MODELS = {
  chatgpt: (k) => listChatCompletionsModels('chatgpt', k),
  mistral: (k) => listChatCompletionsModels('mistral', k),
  claude: listClaudeModels,
  gemini: listGeminiModels
};

// --- Modalità BATCH (recap con «Esecuzione Recap» = Batch, vedi jobs/recapBatch.js) ---
// Una richiesta sola per batch: il fornitore la elabora entro 24 ore (di solito pochi
// minuti) a metà prezzo. invia -> id del batch; stato -> { stato: 'in_corso' | 'pronto' |
// 'fallito', text, errore }.
const BATCH_ID_RICHIESTA = 'recap';

// Prima riga JSONL di un file di risultati (OpenAI / Mistral).
async function primaRigaJsonl(base, fileId, apiKey, label) {
  const res = await callApi(`${base}/files/${encodeURIComponent(fileId)}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 60000
  }, label);
  if (!res.ok) await readJson(res, label); // trasforma l'errore
  const riga = (await res.text()).split('\n').find((l) => l.trim());
  try { return riga ? JSON.parse(riga) : null; } catch { return null; }
}

async function caricaJsonl(base, apiKey, label, riga) {
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([`${JSON.stringify(riga)}\n`], { type: 'application/jsonl' }), 'recap.jsonl');
  return readJson(await callApi(`${base}/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, timeoutMs: 60000
  }, label), label);
}

// Testo / errore da una riga di risultato "chat completions" (OpenAI e Mistral).
function esitoRigaChat(riga, label) {
  const body = riga && riga.response && riga.response.body;
  const testo = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  if (testo) return { stato: 'pronto', text: String(testo).trim() };
  const err = (riga && riga.error && (riga.error.message || JSON.stringify(riga.error))) || (body && body.error && body.error.message);
  return { stato: 'fallito', errore: `${label}: ${err || 'nessun testo nel risultato del batch'}` };
}

const BATCH = {
  chatgpt: {
    async invia(apiKey, model, prompt, opzioni = {}) {
      const base = CHAT_COMPLETIONS_BASE.chatgpt;
      const file = await caricaJsonl(base, apiKey, 'ChatGPT', {
        custom_id: BATCH_ID_RICHIESTA, method: 'POST', url: '/v1/chat/completions',
        body: { model, messages: [{ role: 'user', content: prompt }], ...(opzioni.json ? { response_format: { type: 'json_object' } } : {}) }
      });
      const b = await readJson(await callApi(`${base}/batches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h' })
      }, 'ChatGPT'), 'ChatGPT');
      return b.id;
    },
    async stato(apiKey, batchId) {
      const base = CHAT_COMPLETIONS_BASE.chatgpt;
      const b = await readJson(await callApi(`${base}/batches/${encodeURIComponent(batchId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 30000
      }, 'ChatGPT'), 'ChatGPT');
      if (['validating', 'in_progress', 'finalizing', 'cancelling'].includes(b.status)) return { stato: 'in_corso' };
      if (b.status === 'completed') {
        const fileId = b.output_file_id || b.error_file_id;
        if (fileId) return esitoRigaChat(await primaRigaJsonl(base, fileId, apiKey, 'ChatGPT'), 'ChatGPT');
      }
      const dett = b.errors && b.errors.data && b.errors.data[0] && b.errors.data[0].message;
      return { stato: 'fallito', errore: `ChatGPT: batch ${b.status}${dett ? ` (${dett})` : ''}` };
    }
  },
  mistral: {
    async invia(apiKey, model, prompt, opzioni = {}) {
      const base = CHAT_COMPLETIONS_BASE.mistral;
      const file = await caricaJsonl(base, apiKey, 'Mistral', {
        custom_id: BATCH_ID_RICHIESTA,
        body: { messages: [{ role: 'user', content: prompt }], ...(opzioni.json ? { response_format: { type: 'json_object' }, temperature: TEMPERATURA_JSON } : {}) }
      });
      const b = await readJson(await callApi(`${base}/batch/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input_files: [file.id], model, endpoint: '/v1/chat/completions' })
      }, 'Mistral'), 'Mistral');
      return b.id;
    },
    async stato(apiKey, batchId) {
      const base = CHAT_COMPLETIONS_BASE.mistral;
      const b = await readJson(await callApi(`${base}/batch/jobs/${encodeURIComponent(batchId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 30000
      }, 'Mistral'), 'Mistral');
      if (['QUEUED', 'RUNNING', 'CANCELLATION_REQUESTED'].includes(b.status)) return { stato: 'in_corso' };
      if (b.status === 'SUCCESS') {
        const fileId = b.output_file || b.error_file;
        if (fileId) return esitoRigaChat(await primaRigaJsonl(base, fileId, apiKey, 'Mistral'), 'Mistral');
      }
      const dett = Array.isArray(b.errors) && b.errors[0] && b.errors[0].message;
      return { stato: 'fallito', errore: `Mistral: batch ${b.status}${dett ? ` (${dett})` : ''}` };
    }
  },
  claude: {
    async invia(apiKey, model, prompt) {
      // Claude non ha un "formato JSON": il prompt chiede già di rispondere solo in JSON.
      const client = new Anthropic({ apiKey, timeout: 60000, maxRetries: 1 });
      try {
        const b = await client.messages.batches.create({
          requests: [{ custom_id: BATCH_ID_RICHIESTA, params: { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] } }]
        });
        return b.id;
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw httpError(400, 'Chiave API Claude non valida o senza permessi');
        if (error instanceof Anthropic.APIError) throw httpError(502, `Claude ${error.status || ''}: ${error.message}`);
        throw error;
      }
    },
    async stato(apiKey, batchId) {
      const client = new Anthropic({ apiKey, timeout: 60000, maxRetries: 1 });
      const b = await client.messages.batches.retrieve(batchId);
      if (b.processing_status !== 'ended') return { stato: 'in_corso' };
      for await (const r of await client.messages.batches.results(batchId)) {
        const res = r.result || {};
        if (res.type === 'succeeded') {
          const text = (res.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
          return text ? { stato: 'pronto', text } : { stato: 'fallito', errore: 'Claude non ha restituito testo' };
        }
        const dett = res.error && res.error.error && res.error.error.message;
        return { stato: 'fallito', errore: `Claude: richiesta ${res.type || 'non riuscita'}${dett ? ` (${dett})` : ''}` };
      }
      return { stato: 'fallito', errore: 'Claude: batch concluso senza risultati' };
    }
  },
  gemini: {
    async invia(apiKey, model, prompt, opzioni = {}) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchGenerateContent`;
      const generationConfig = opzioni.json ? { generationConfig: { temperature: TEMPERATURA_JSON, responseMimeType: 'application/json' } } : {};
      const op = await readJson(await callApi(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch: {
            display_name: 'projexa-recap',
            input_config: { requests: { requests: [{ request: { contents: [{ role: 'user', parts: [{ text: prompt }] }], ...generationConfig }, metadata: { key: BATCH_ID_RICHIESTA } }] } }
          }
        })
      }, 'Gemini'), 'Gemini');
      return op.name; // "batches/..."
    },
    async stato(apiKey, batchId) {
      const nome = String(batchId).replace(/^\/+/, '');
      const b = await readJson(await callApi(`https://generativelanguage.googleapis.com/v1beta/${nome}`, {
        headers: { 'x-goog-api-key': apiKey }, timeoutMs: 30000
      }, 'Gemini'), 'Gemini');
      const stato = String((b.metadata && b.metadata.state) || b.state || '');
      if (!b.done && !/SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(stato)) return { stato: 'in_corso' };
      // Le risposte possono stare in response o in metadata.output (a seconda della versione).
      const contenitore = (b.response && b.response.inlinedResponses) || (b.metadata && b.metadata.output && b.metadata.output.inlinedResponses) || {};
      const risposte = Array.isArray(contenitore) ? contenitore : (contenitore.inlinedResponses || []);
      const r = risposte[0];
      if (r && r.response) {
        const parts = ((r.response.candidates || [])[0] || {}).content;
        const text = ((parts && parts.parts) || []).map((p) => p.text || '').join('').trim();
        if (text) return { stato: 'pronto', text };
      }
      const dett = (r && r.error && r.error.message) || (b.error && b.error.message);
      return { stato: 'fallito', errore: `Gemini: batch ${stato || 'concluso'} senza testo${dett ? ` (${dett})` : ''}` };
    }
  }
};

// Invia il prompt in modalità batch con la chiave (e la versione del modello) dell'utente.
// Restituisce { batchId, model, label }.
export async function inviaBatchAi(userId, providerName, prompt, opzioni = {}) {
  const key = String(providerName || '').trim().toLowerCase();
  const cfg = PROVIDERS[key];
  if (!cfg) throw httpError(400, `L'AI «${providerName}» non supporta la modalità Batch`);
  const el = await getIntegration(userId, cfg.provider);
  const apiKey = el[`${cfg.prefix}_api_key`];
  if (!apiKey) throw httpError(428, `${cfg.label} non collegato: attivalo da Impostazioni › AI`);
  const model = modelloUtente(cfg, el);
  // Anonimizzazione: la tabella dei segnaposto si salva (cifrata) fino alla risposta del batch.
  const { prompt: daInviare, anon } = await anonimizzaPrompt(userId, prompt, { etichetta: `${cfg.label} Batch` });
  try {
    const batchId = await BATCH[key].invia(apiKey, model, daInviare, opzioni);
    await salvaMappaBatch(key, batchId, userId, anon);
    return { batchId, model, label: cfg.label };
  } catch (e) {
    // Piano che non permette il Batch: Gemini gratuito (400 "Precondition check failed" =
    // fatturazione non attiva, oppure 429 sulla richiesta batch), modello non incluso nel piano
    // (Mistral "tier_not_allowed"). Chi chiama ripiega sull'esecuzione Immediata.
    const msg = String(e.message || '');
    const nonDisponibile = (e.upstreamStatus === 400 && /precondition/i.test(msg))
      || /tier_not_allowed|non è incluso nel tuo piano|billing|free tier/i.test(msg)
      || (key === 'gemini' && (e.status === 429 || e.upstreamStatus === 429));
    if (nonDisponibile) {
      throw Object.assign(new Error(`${cfg.label}: il tuo piano non permette la modalità Batch (serve un piano a pagamento), eseguito in modalità Immediata`),
        { status: 409, code: 'BATCH_NON_DISPONIBILE', dettaglio: msg });
    }
    // 2026-10-22 (richiesta utente): qualsiasi altro rifiuto della richiesta Batch (es. Gemini
    // gratuito con un messaggio nuovo, modello non abilitato al Batch) fa ripiegare
    // sull'Immediato. Restano errori veri solo la chiave mancante o non valida, con cui anche
    // l'Immediato fallirebbe.
    if (e.status !== 428 && !/chiave api .*non valida/i.test(msg)) {
      throw Object.assign(new Error(`${cfg.label}: Batch non accettato (${msg.slice(0, 200)}), eseguito in modalità Immediata`),
        { status: 409, code: 'BATCH_NON_DISPONIBILE', dettaglio: msg });
    }
    throw e;
  }
}
export const isBatchNonDisponibile = (e) => !!(e && e.code === 'BATCH_NON_DISPONIBILE');

// Risposta JSON (Kick-off, RAID, associazioni...): i valori rimessi al posto dei segnaposto
// vanno con virgolette e barre protette.
const pareJson = (t) => /^\s*(```(json)?\s*)?[[{]/i.test(String(t || ''));

export async function statoBatchAi(userId, providerName, batchId) {
  const key = String(providerName || '').trim().toLowerCase();
  const cfg = PROVIDERS[key];
  if (!cfg) return { stato: 'fallito', errore: `AI «${providerName}» non riconosciuta` };
  const el = await getIntegration(userId, cfg.provider);
  const apiKey = el[`${cfg.prefix}_api_key`];
  if (!apiKey) return { stato: 'fallito', errore: `${cfg.label} scollegato: chiave API non più disponibile` };
  const esito = await BATCH[key].stato(apiKey, batchId);
  // Risposta con i segnaposto dell'anonimizzazione: si rimettono i valori veri.
  if (esito.stato === 'pronto' && esito.text) esito.text = await ripristinaBatch(key, batchId, userId, esito.text, { json: pareJson(esito.text) });
  return { ...esito, label: cfg.label };
}

// AI con chiave collegata dall'utente (per la scelta "Chiedi sempre" del recap): [{ nome, label }].
export async function aiCollegate(userId) {
  const out = [];
  for (const key of Object.keys(PROVIDERS)) {
    const cfg = PROVIDERS[key];
    const el = await getIntegration(userId, cfg.provider);
    if (el[`${cfg.prefix}_api_key`]) out.push({ nome: cfg.provider, label: cfg.label });
  }
  return out;
}

async function modelliDisponibili(key, apiKey) {
  const visti = new Set();
  return (await LIST_MODELS[key](apiKey))
    .filter((m) => m.id && !visti.has(m.id) && visti.add(m.id))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
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
      out[key] = {
        label: cfg.label, connected: !!el[`${cfg.prefix}_api_key`], enabled: !!enabled[key],
        model: modelloUtente(cfg, el), modelPredefinito: cfg.model, modelScelto: !!el[`${cfg.prefix}_model`]
      };
    }
    res.json({ providers: out, anonimizzazione: await statoAnonimizzazione() });
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
    // Cambiando la chiave si conserva la versione del modello già scelta.
    const prev = await getIntegration(req.user.user_id, cfg.provider);
    await saveIntegration(req.user.user_id, cfg.provider, TIPO_INTEGRAZIONE, {
      [`${cfg.prefix}_api_key`]: apiKey,
      [`${cfg.prefix}_model`]: prev[`${cfg.prefix}_model`] || undefined,
      // ...e il saldo stimato (chiave admin e credito caricato), se impostato.
      [`${cfg.prefix}_admin_key`]: prev[`${cfg.prefix}_admin_key`] || undefined,
      [`${cfg.prefix}_credito`]: prev[`${cfg.prefix}_credito`] || undefined,
      [`${cfg.prefix}_credito_dal`]: prev[`${cfg.prefix}_credito_dal`] || undefined,
      [`${cfg.prefix}_credito_base`]: prev[`${cfg.prefix}_credito_base`] || undefined
    });
    console.log(`[AI:${req.params.provider}] ✓ Chiave collegata per l'utente ${req.user.user_id}`);
    res.json({ success: true });
  } catch (error) {
    console.error(`❌ AI_KEY (${req.params.provider}):`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Menu "Versione" in Impostazioni › AI: modelli disponibili con la chiave dell'utente.
router.get('/:provider/models', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  try {
    const el = await getIntegration(req.user.user_id, cfg.provider);
    const apiKey = el[`${cfg.prefix}_api_key`];
    if (!apiKey) return res.status(428).json({ error: `${cfg.label} non collegato: collega prima la chiave API` });
    res.json({
      models: await modelliDisponibili(req.params.provider, apiKey),
      selected: el[`${cfg.prefix}_model`] || '',
      predefinito: cfg.model
    });
  } catch (error) {
    console.error(`❌ AI_MODELS (${req.params.provider}):`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Salva la versione scelta; model vuoto = torna a quella predefinita di Projexa.
router.post('/:provider/model', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  const elemento = `${cfg.prefix}_model`;
  try {
    const model = String((req.body && req.body.model) || '').trim();
    const el = await getIntegration(req.user.user_id, cfg.provider);
    const apiKey = el[`${cfg.prefix}_api_key`];
    if (!apiKey) return res.status(428).json({ error: `${cfg.label} non collegato: collega prima la chiave API` });
    if (!model) {
      await deleteIntegrationElement(req.user.user_id, cfg.provider, elemento);
      return res.json({ success: true, model: cfg.model });
    }
    const disponibili = await modelliDisponibili(req.params.provider, apiKey);
    if (!disponibili.some((m) => m.id === model)) {
      return res.status(400).json({ error: `Il modello «${model.slice(0, 100)}» non è disponibile con la tua chiave ${cfg.label}` });
    }
    await updateIntegrationElements(req.user.user_id, cfg.provider, TIPO_INTEGRAZIONE, { [elemento]: model });
    console.log(`[AI:${req.params.provider}] Versione ${model} scelta dall'utente ${req.user.user_id}`);
    res.json({ success: true, model });
  } catch (error) {
    console.error(`❌ AI_MODEL (${req.params.provider}):`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ------------------------------------------
// SALDO STIMATO DEL CREDITO (Impostazioni › AI, 2026-10-23)
// ------------------------------------------
// Nessun fornitore dà il saldo del credito via API. OpenAI e Anthropic danno però la SPESA,
// con una chiave «admin» separata (OpenAI sk-admin-…, Anthropic sk-ant-admin…) che legge solo i
// costi: l'utente indica con «Aggiorna importo» quanto credito ha caricato e da quale giorno, e
// Projexa mostra credito - spesa da quel giorno. Stima: ricariche automatiche, crediti omaggio o
// altre chiavi della stessa organizzazione possono farla scostare. Importi in dollari (la
// valuta delle API), con il cambio in euro della BCE quando disponibile.
// Elementi in integr_tok_auth: <prefix>_admin_key (segreta), <prefix>_credito, <prefix>_credito_dal.
const SALDO_CACHE_MS = 15 * 60000;
const saldoCache = new Map(); // "utente|provider|dal|credito" -> { at, speso }
let cambioEur = { at: 0, usdPerEur: null };

// Spesa in dollari dal giorno indicato (YYYY-MM-DD, UTC) a oggi.
const SPESA = {
  async chatgpt(adminKey, dal) {
    let totale = 0;
    let page = null;
    const start = Math.floor(new Date(`${dal}T00:00:00Z`).getTime() / 1000);
    for (let giri = 0; giri < 20; giri++) {
      const q = new URLSearchParams({ start_time: String(start), bucket_width: '1d', limit: '180' });
      if (page) q.set('page', page);
      const r = await callApi(`https://api.openai.com/v1/organization/costs?${q}`, { headers: { Authorization: `Bearer ${adminKey}` }, timeoutMs: 30000 }, 'OpenAI (costi)');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw httpError(r.status === 401 || r.status === 403 ? 400 : 502, `OpenAI: ${(d.error && d.error.message) || `errore ${r.status}`} (serve una chiave admin sk-admin-…)`);
      for (const b of d.data || []) for (const x of b.results || []) totale += Number(x.amount && x.amount.value) || 0;
      if (!d.has_more || !d.next_page) break;
      page = d.next_page;
    }
    return totale;
  },
  async claude(adminKey, dal) {
    let centesimi = 0;
    let page = null;
    for (let giri = 0; giri < 40; giri++) {
      const q = new URLSearchParams({ starting_at: `${dal}T00:00:00Z`, bucket_width: '1d', limit: '31' });
      if (page) q.set('page', page);
      const r = await callApi(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
        headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' }, timeoutMs: 30000
      }, 'Anthropic (costi)');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw httpError(r.status === 401 || r.status === 403 ? 400 : 502, `Anthropic: ${(d.error && d.error.message) || `errore ${r.status}`} (serve una chiave admin sk-ant-admin…)`);
      // amount = unità minime (centesimi) come stringa decimale: «123.45» = 1,23 $.
      for (const b of d.data || []) for (const x of b.results || []) centesimi += Number(x.amount) || 0;
      if (!d.has_more || !d.next_page) break;
      page = d.next_page;
    }
    return centesimi / 100;
  }
};

// Dollari per 1 euro dal cambio giornaliero della BCE (12 ore di cache); null se non disponibile.
async function dollariPerEuro() {
  if (cambioEur.usdPerEur && Date.now() - cambioEur.at < 12 * 3600000) return cambioEur.usdPerEur;
  try {
    const r = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: AbortSignal.timeout(8000) });
    const m = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(await r.text());
    if (m) cambioEur = { at: Date.now(), usdPerEur: Number(m[1]) };
  } catch { /* resta l'ultimo valore, o nessuno */ }
  return cambioEur.usdPerEur;
}

const OGGI = () => new Date().toISOString().slice(0, 10);

router.get('/:provider/saldo', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  const spesa = SPESA[req.params.provider];
  if (!spesa) return res.json({ supportato: false });
  try {
    const el = await getIntegration(req.user.user_id, cfg.provider);
    const credito = Number(el[`${cfg.prefix}_credito`]);
    const dal = el[`${cfg.prefix}_credito_dal`] || '';
    const adminKey = el[`${cfg.prefix}_admin_key`] || '';
    const base = { supportato: true, adminKey: !!adminKey, credito: Number.isFinite(credito) ? credito : null, dal, valuta: 'USD' };
    if (!adminKey || !Number.isFinite(credito) || !dal) return res.json({ ...base, configurato: false });
    const k = `${req.user.user_id}|${req.params.provider}|${dal}|${credito}`;
    let c = saldoCache.get(k);
    if (!c || Date.now() - c.at > SALDO_CACHE_MS || req.query.aggiorna === '1') {
      c = { at: Date.now(), speso: await spesa(adminKey, dal) };
      saldoCache.set(k, c);
    }
    // Spesa dopo il salvataggio: quella fino a quel momento è già dentro il credito indicato.
    const speso = Math.max(0, c.speso - (Number(el[`${cfg.prefix}_credito_base`]) || 0));
    const saldo = credito - speso;
    const cambio = await dollariPerEuro();
    res.json({ ...base, configurato: true, speso, saldo, saldoEur: cambio ? saldo / cambio : null, letto: new Date(c.at).toISOString() });
  } catch (error) {
    if (!error.status) console.error(`❌ AI_SALDO (${req.params.provider}):`, error.message);
    res.json({ supportato: true, configurato: true, errore: error.message });
  }
});

// «Aggiorna importo»: { credito (dollari), dal (YYYY-MM-DD, facoltativo: oggi), admin_key (facoltativa
// se già salvata) }. La chiave admin si verifica leggendo la spesa prima di salvarla.
router.post('/:provider/saldo', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  const spesa = SPESA[req.params.provider];
  if (!spesa) return res.status(400).json({ error: `${cfg.label} non permette di leggere la spesa via API` });
  try {
    const b = req.body || {};
    const credito = Number(String(b.credito ?? '').replace(',', '.'));
    if (!Number.isFinite(credito) || credito < 0 || credito > 100000) return res.status(400).json({ error: 'Importo non valido' });
    const dal = String(b.dal || OGGI()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dal) || dal > OGGI()) return res.status(400).json({ error: 'Data non valida (non può essere nel futuro)' });
    const el = await getIntegration(req.user.user_id, cfg.provider);
    const nuova = String(b.admin_key || '').trim();
    if (nuova && (nuova.length < 20 || /\s/.test(nuova))) return res.status(400).json({ error: 'Chiave admin non valida' });
    const adminKey = nuova || el[`${cfg.prefix}_admin_key`];
    if (!adminKey) return res.status(400).json({ error: `Serve la chiave admin di ${cfg.label} (sola lettura dei costi)` });
    const speso = await spesa(adminKey, dal); // verifica la chiave
    // Il credito letto nella pagina Billing comprende già la spesa fatta fino a questo momento:
    // si conserva come «base» e si sottrae solo quella successiva (le API danno la spesa a
    // giorni interi, non dall'ora del salvataggio). 2026-10-23
    await updateIntegrationElements(req.user.user_id, cfg.provider, TIPO_INTEGRAZIONE, {
      [`${cfg.prefix}_credito`]: String(credito), [`${cfg.prefix}_credito_dal`]: dal,
      [`${cfg.prefix}_credito_base`]: String(speso),
      ...(nuova ? { [`${cfg.prefix}_admin_key`]: nuova } : {})
    });
    for (const k of saldoCache.keys()) if (k.startsWith(`${req.user.user_id}|${req.params.provider}|`)) saldoCache.delete(k);
    console.log(`[AI:${req.params.provider}] Credito aggiornato dall'utente ${req.user.user_id}${nuova ? ' (nuova chiave admin)' : ''}`);
    res.json({ success: true, credito, dal, speso: 0, saldo: credito });
  } catch (error) {
    if (!error.status) console.error(`❌ AI_SALDO_SALVA (${req.params.provider}):`, error.message);
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

// ==========================================
// TRASCRIZIONI DEI MEETING NELLA FINESTRA AI (pulsante "Trascrizione")
// ==========================================
// L'utente sceglie un giorno, vede le sue riunioni con trascrizione (rec_meeting, anche
// quelle ricevute da un collega: la trascrizione condivisa è copiata sulla sua riga) e ne
// sceglie una. All'invio il server aggiunge il testo della trascrizione alla richiesta scritta
// dall'utente: è una richiesta libera, NON usa né modifica i prompt standard/custom del recap.
// Limite TOTALE del testo delle trascrizioni mandato all'AI in una richiesta (anche con più
// riunioni scelte "per periodo") e numero massimo di riunioni per richiesta.
const MAX_TRASCRIZIONE_CHARS = 400000;
const MAX_TRASCRIZIONI = 50;
const AI_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AI_DATA = /^\d{4}-\d{2}-\d{2}$/;

// Riunioni con trascrizione: { id, oggetto, data, orario, caratteri }.
//   ?data=AAAA-MM-GG                       un giorno;
//   ?da=…&a=…&clientId=…[&projectId=…]     "per periodo": cliente obbligatorio, progetto facoltativo.
router.get('/trascrizioni', requireAuth, async (req, res) => {
  try {
    const q = req.query || {};
    const params = [req.user.tenant_id, req.user.user_id];
    let filtro;
    if (q.data) {
      const data = String(q.data).trim();
      if (!AI_DATA.test(data)) return res.status(400).json({ error: 'Data non valida (AAAA-MM-GG)' });
      params.push(data);
      filtro = `data_calendar::date = $${params.length}::date`;
    } else {
      const da = String(q.da || '').trim();
      const a = String(q.a || '').trim();
      const clientId = String(q.clientId || '').trim();
      const projectId = String(q.projectId || '').trim();
      if (!AI_DATA.test(da) || !AI_DATA.test(a)) return res.status(400).json({ error: 'Indica le date Da e A' });
      if (da > a) return res.status(400).json({ error: 'La data Da è successiva alla data A' });
      if (!AI_UUID.test(clientId)) return res.status(400).json({ error: 'Scegli il cliente' });
      if (projectId && !AI_UUID.test(projectId)) return res.status(400).json({ error: 'Progetto non valido' });
      params.push(da, a, clientId);
      filtro = `data_calendar::date BETWEEN $3::date AND $4::date AND client_id = $5`;
      if (projectId) { params.push(projectId); filtro += ` AND project_id = $${params.length}`; }
    }
    const r = await db.query(
      `SELECT id_calendar, oggetto, data_calendar, orario_calendar, trascrizione FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND ${filtro}
        ORDER BY data_calendar, orario_calendar NULLS LAST
        LIMIT 500`,
      params
    );
    // trascrizione è cifrata: il pool la restituisce in chiaro, il filtro si fa qui.
    res.json(r.rows
      .filter((x) => x.trascrizione && String(x.trascrizione).trim())
      .map((x) => ({
        id: x.id_calendar,
        oggetto: x.oggetto || '(senza titolo)',
        data: x.data_calendar ? String(x.data_calendar).slice(0, 10) : '',
        orario: x.orario_calendar ? String(x.orario_calendar).slice(0, 5) : '',
        caratteri: String(x.trascrizione).trim().length
      })));
  } catch (error) {
    console.error('❌ AI_TRASCRIZIONI:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Clienti (e loro progetti) con almeno una riunione con trascrizione nel periodo Da–A:
// [{ clientId, projectIds: [...] }]. Servono ai menu Cliente/Progetto di "Per periodo".
router.get('/trascrizioni/clienti', requireAuth, async (req, res) => {
  try {
    const da = String((req.query && req.query.da) || '').trim();
    const a = String((req.query && req.query.a) || '').trim();
    if (!AI_DATA.test(da) || !AI_DATA.test(a)) return res.status(400).json({ error: 'Indica le date Da e A' });
    if (da > a) return res.json([]);
    const r = await db.query(
      `SELECT client_id::text AS client_id, project_id::text AS project_id, trascrizione FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND client_id IS NOT NULL
          AND data_calendar::date BETWEEN $3::date AND $4::date`,
      [req.user.tenant_id, req.user.user_id, da, a]
    );
    // trascrizione è cifrata: il pool la restituisce in chiaro, il filtro si fa qui.
    const perCliente = new Map();
    for (const x of r.rows) {
      if (!x.trascrizione || !String(x.trascrizione).trim()) continue;
      if (!perCliente.has(x.client_id)) perCliente.set(x.client_id, new Set());
      if (x.project_id) perCliente.get(x.client_id).add(x.project_id);
    }
    res.json([...perCliente].map(([clientId, progetti]) => ({ clientId, projectIds: [...progetti] })));
  } catch (error) {
    console.error('❌ AI_TRASCRIZIONI_CLIENTI:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Testo delle trascrizioni scelte (solo riunioni dell'utente), in ordine di data, con le
// correzioni automatiche dei termini (come per il recap) e un'intestazione per riunione.
// Oltre MAX_TRASCRIZIONE_CHARS in totale le riunioni successive non entrano (escluse).
// Restituisce { testo, incluse, escluse } oppure null se nessuna trascrizione è disponibile.
async function testoTrascrizioni(user, ids) {
  const rows = (await db.query(
    `SELECT id_calendar, trascrizione, oggetto, data_calendar, orario_calendar FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = ANY($3::text[])
      ORDER BY data_calendar, orario_calendar NULLS LAST`,
    [user.tenant_id, user.user_id, ids]
  )).rows.filter((row) => row.trascrizione && String(row.trascrizione).trim());
  if (!rows.length) return null;
  // Import dinamico: jobs/meetingTranscription.js importa a sua volta questo file.
  const { loadCorrections, applyCorrections } = await import('../jobs/meetingTranscription.js');
  const parti = [];
  let totale = 0;
  let escluse = 0;
  for (const row of rows) {
    let testo = applyCorrections(String(row.trascrizione).trim(), await loadCorrections(user, row.id_calendar)).text;
    const spazio = MAX_TRASCRIZIONE_CHARS - totale;
    if (spazio < 2000) { escluse += 1; continue; }
    let troncata = false;
    if (testo.length > spazio) { testo = testo.slice(0, spazio); troncata = true; }
    totale += testo.length;
    const data = row.data_calendar ? String(row.data_calendar).slice(0, 10).split('-').reverse().join('/') : '';
    const ora = row.orario_calendar ? String(row.orario_calendar).slice(0, 5) : '';
    const titolo = [row.oggetto || 'Riunione', [data, ora].filter(Boolean).join(' ')].filter(Boolean).join(' - ');
    parti.push(`=== TRASCRIZIONE DELLA RIUNIONE: ${titolo} ===\n${testo}${troncata ? '\n[... trascrizione troncata per lunghezza ...]' : ''}\n=== FINE TRASCRIZIONE ===`);
  }
  const nota = escluse ? `\n\n[Nota: altre ${escluse} trascrizioni non incluse per limite di lunghezza]` : '';
  return { testo: parti.join('\n\n') + nota, incluse: parti.length, escluse };
}

// Invia una richiesta (una domanda, una risposta) al fornitore con la chiave dell'utente.
// meetingIds / meetingId (facoltativi): id_calendar di riunioni dell'utente; le loro
// trascrizioni vengono aggiunte alla richiesta (pulsante "Trascrizione" della finestra AI).
router.post('/:provider/chat', requireAuth, requireProvider, async (req, res) => {
  const cfg = req.aiProvider;
  try {
    // Allegati: solo in memoria per la durata della richiesta, mai salvati.
    const atts = await prepareAttachments(req.body && req.body.files);
    let prompt = String((req.body && req.body.prompt) || '').trim();
    const b = req.body || {};
    const meetingIds = [...new Set([...(Array.isArray(b.meetingIds) ? b.meetingIds : []), b.meetingId]
      .map((x) => String(x || '').trim()).filter(Boolean))];
    if (meetingIds.length > MAX_TRASCRIZIONI) return res.status(400).json({ error: `Troppe trascrizioni (massimo ${MAX_TRASCRIZIONI})` });
    const tr = meetingIds.length ? await testoTrascrizioni(req.user, meetingIds) : null;
    if (meetingIds.length && !tr) return res.status(404).json({ error: 'Trascrizione non trovata' });
    const trascrizione = tr ? tr.testo : null;
    if (!prompt && trascrizione) prompt = tr.incluse > 1 ? 'Fai un riepilogo delle trascrizioni.' : 'Fai un riepilogo della trascrizione.';
    if (!prompt && atts.length) prompt = atts.length > 1 ? 'Analizza i file allegati.' : 'Analizza il file allegato.';
    if (!prompt) return res.status(400).json({ error: 'Scrivi una richiesta' });
    if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: `Richiesta troppo lunga (max ${MAX_PROMPT_CHARS} caratteri)` });
    // La trascrizione segue la richiesta dell'utente (il limite vale solo per quella scritta).
    if (trascrizione) prompt = `${prompt}\n\n${trascrizione}`;
    // Anonimizzazione: richiesta, trascrizioni e testo degli allegati (Word, Excel, testo e PDF
    // con testo, che si manda come testo). Le immagini e i PDF scansionati partono così come sono.
    const { prompt: daInviare, anon } = await anonimizzaPrompt(req.user.user_id, prompt, { etichetta: `Finestra AI ${cfg.label}` });
    prompt = daInviare;
    if (anon) {
      for (let i = 0; i < atts.length; i++) {
        const a = atts[i];
        if (a.kind === 'pdf') {
          const testo = await pdfToText(a).catch(() => '');
          if (testo && testo.trim().length > 50) atts[i] = { kind: 'text', name: a.name, text: await anon.maschera(testo) };
        } else if (a.kind === 'text') {
          atts[i] = { ...a, text: await anon.maschera(a.text) };
        }
      }
    }

    const el = await getIntegration(req.user.user_id, cfg.provider);
    const apiKey = el[`${cfg.prefix}_api_key`];
    if (!apiKey) return res.status(428).json({ error: `${cfg.label} non collegato: attivalo da Impostazioni › AI`, code: 'AI_NOT_CONNECTED' });

    const key = req.params.provider;
    const { result, model } = await withAiRetry(
      (m) => ASK[key](apiKey, prompt, atts, {}, m),
      { label: cfg.label, model: modelloUtente(cfg, el), fallbacks: key === 'gemini' ? geminiFallbackModels() : [], profile: 'interactive' }
    );
    res.json({
      provider: key, model, text: anon ? anon.ripristina(result.text) : result.text, files: result.files || [], truncated: !!result.truncated,
      // Dati personali sostituiti da segnaposto prima dell'invio (la dashboard lo segnala)
      anonimizzati: anon ? anon.totale : 0,
      // Trascrizioni rimaste fuori per il limite di lunghezza (la dashboard lo segnala)
      trascrizioniEscluse: tr ? tr.escluse : 0
    });
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
// opzioni: { json: true } per le risposte strutturate (vedi TEMPERATURA_JSON).
export async function askAiProvider(userId, providerName, prompt, opzioni = {}) {
  // Richiesta rigiocata da un "lavoro AI" in modalità Batch (jobs/aiLavori.js): la risposta
  // arriva dalla Batch API del fornitore (metà prezzo, entro 24 ore).
  const lavoro = contestoAi.getStore();
  // opzioni.immediato: ripiego quando il piano dell'AI non permette il Batch.
  if (lavoro && lavoro.attendiBatch && !opzioni.immediato) return lavoro.attendiBatch(providerName, prompt, opzioni);
  const key = String(providerName || '').trim().toLowerCase();
  if (key === 'copilot') throw httpError(400, 'Copilot non è disponibile per il recap: scegli un\'altra AI');
  const cfg = PROVIDERS[key];
  if (!cfg) throw httpError(400, `AI "${providerName}" non riconosciuta per il recap`);
  const el = await getIntegration(userId, cfg.provider);
  const apiKey = el[`${cfg.prefix}_api_key`];
  if (!apiKey) throw httpError(428, `${cfg.label} non collegato: attivalo da Impostazioni › AI`);
  const { prompt: daInviare, anon } = await anonimizzaPrompt(userId, prompt, { etichetta: cfg.label });
  const { result, model } = await withAiRetry(
    (m) => ASK[key](apiKey, daInviare, [], opzioni, m),
    { label: cfg.label, model: modelloUtente(cfg, el), fallbacks: key === 'gemini' ? geminiFallbackModels() : [], profile: 'background' }
  );
  const text = anon ? anon.ripristina(result.text, { json: !!opzioni.json || pareJson(result.text) }) : result.text;
  return { text, label: cfg.label, model };
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

// Modalità "Parakeet" (2026-10-21): NVIDIA Parakeet TDT 0.6B v3 via sherpa-onnx sulla VM
// (systemd projexa-parakeet, deploy/oracle/setup-parakeet.sh, parakeet-service/app.py).
// Indirizzo: PARAKEET_URL (sulla VM 127.0.0.1:8103, senza chiave). Vuoto = non configurato.
export function parakeetUrl() {
  return String(process.env.PARAKEET_URL || '').trim().replace(/\/+$/, '');
}

// Blocco WAV su Parakeet (POST /inference, corpo = WAV): risposta { segments: [{ start, end, text }] }
// con una frase per pezzo di parlato trovato dal VAD. Parakeet non accetta un prompt: al suo
// posto le hotwords (buildHotwords in jobs/meetingTranscription.js), nell'header X-Hotwords
// separate da '/' e codificate (gli header ammettono solo ASCII).
export async function transcribeAudioParakeet(base, audioBuffer, mime, hotwords = []) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await readJson(await callApi(`${base}/inference`, {
        method: 'POST',
        headers: { 'Content-Type': mime || 'audio/wav', ...(hotwords.length ? { 'X-Hotwords': encodeURIComponent(hotwords.join('/')) } : {}) },
        body: audioBuffer,
        timeoutMs: 600000
      }, 'Parakeet'), 'Parakeet');
      if (data.error) {
        const err = httpError(502, `Parakeet: ${String(data.error).slice(0, 200)}`);
        err.upstreamStatus = 500;
        throw err;
      }
      const segments = (Array.isArray(data.segments) ? data.segments : [])
        .map((x) => ({ start: Number(x.start) || 0, end: Number(x.end) || Number(x.start) || 0, text: String(x.text || '').trim() }))
        .filter((x) => x.text);
      return { segments, provider: 'Parakeet TDT 0.6B v3' };
    } catch (error) {
      const temporary = [429, 500, 502, 503, 504].includes(error.upstreamStatus) || (error.status === 502 && !error.upstreamStatus);
      if (!temporary || attempt >= 3) throw error;
      console.warn(`[AI] Trascrizione Parakeet (${base}): errore temporaneo (${error.upstreamStatus || error.message}), nuovo tentativo ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, attempt === 1 ? 5000 : 15000));
    }
  }
}

// Diarizzazione, fase 1 (2026-10-28): servizio delle impronte vocali (diarizzazione-service/app.py,
// systemd projexa-diarizzazione, deploy/oracle/setup-diarizzazione.sh). Indirizzo:
// DIARIZZAZIONE_URL (sulla VM 127.0.0.1:8105, senza chiave). Vuoto = diarizzazione spenta.
export function diarizzazioneUrl() {
  return String(process.env.DIARIZZAZIONE_URL || '').trim().replace(/\/+$/, '');
}

// Impronta vocale di ogni segmento [{ start, end }] del blocco WAV (POST /voci, segmenti
// nell'header X-Segmenti "inizio-fine,..."): array nello stesso ordine, null per i segmenti
// troppo corti. Nessun nuovo tentativo: se il servizio non risponde il blocco resta senza
// diarizzazione (righe «Partecipanti» come prima).
export async function impronteVocali(audioBuffer, segmenti) {
  const base = diarizzazioneUrl();
  if (!base || !segmenti.length) return segmenti.map(() => null);
  const data = await readJson(await callApi(`${base}/voci`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
      'X-Segmenti': segmenti.map((s) => `${(Number(s.start) || 0).toFixed(2)}-${(Number(s.end) || 0).toFixed(2)}`).join(',')
    },
    body: audioBuffer,
    timeoutMs: 120000
  }, 'Diarizzazione'), 'Diarizzazione');
  if (data.error || !Array.isArray(data.voci) || data.voci.length !== segmenti.length) {
    throw httpError(502, `Diarizzazione: ${String(data.error || 'risposta non valida').slice(0, 200)}`);
  }
  return data.voci.map((v) => (Array.isArray(v) && v.length ? v.map(Number) : null));
}

// Trascrizione di un blocco WAV con Gemini («modalità Trascrizione» = Gemini, chiave API
// dell'utente). Gemini restituisce le frasi con inizio/fine in secondi (JSON con schema), nello
// stesso formato dei segmenti di Whisper: { segments: [{ start, end, text }], provider }.
// Modello: GEMINI_TRANSCRIBE_MODEL (predefinito gemini-flash-lite-latest).
export async function transcribeAudioGemini(apiKey, audioBuffer, mime, contesto = '') {
  // Flash Lite: nel piano gratuito 500 richieste al giorno (Flash solo 20, finite in ~40 minuti di
  // riunione con un blocco ogni 2 minuti).
  const model = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-flash-lite-latest';
  const istruzioni = [
    'Trascrivi fedelmente, parola per parola, il parlato di questo audio di una riunione di lavoro in italiano.',
    'Restituisci le frasi in ordine, ognuna con inizio e fine in secondi dall\'inizio dell\'audio (start, end, con i decimali) e il testo.',
    'Non tradurre, non riassumere, non correggere il contenuto e non aggiungere nulla che non sia stato detto; usa la punteggiatura normale.',
    'Se una parola non si capisce scrivi la trascrizione più probabile. Se nell\'audio non c\'è parlato restituisci un elenco vuoto.',
    contesto ? `Contesto utile per riconoscere nomi e termini (NON trascriverlo): ${contesto}` : ''
  ].filter(Boolean).join('\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await readJson(await callApi(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { inline_data: { mime_type: mime || 'audio/wav', data: audioBuffer.toString('base64') } },
        { text: istruzioni }
      ] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, text: { type: 'STRING' } },
            required: ['start', 'end', 'text']
          }
        }
      }
    }),
    timeoutMs: 300000
  }, 'Gemini'), 'Gemini');
  const cand = (data.candidates || [])[0] || {};
  const testo = ((cand.content && cand.content.parts) || []).map((p) => (p.thought ? '' : p.text || '')).join('').trim();
  if (!testo && data.promptFeedback && data.promptFeedback.blockReason) {
    throw httpError(422, `Gemini ha bloccato la trascrizione (${data.promptFeedback.blockReason})`);
  }
  let lista;
  try { lista = JSON.parse(testo || '[]'); } catch {
    const err = httpError(502, 'Gemini: risposta della trascrizione non leggibile');
    err.upstreamStatus = 500;
    throw err;
  }
  const segments = (Array.isArray(lista) ? lista : [])
    .map((x) => ({ start: Math.max(0, Number(x && x.start) || 0), end: Number(x && x.end) || 0, text: String((x && x.text) || '').trim() }))
    .filter((x) => x.text)
    .map((x) => ({ ...x, end: Math.max(x.start, x.end) }));
  return { segments, provider: `Gemini ${model}` };
}

// Blocco WAV su whisper.cpp (endpoint /inference, risposta verbose_json con i segmenti).
export async function transcribeAudioCpp(base, audioBuffer, mime, prompt = '') {
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mime || 'audio/wav' }), 'blocco.wav');
      form.append('response_format', 'verbose_json');
      // Qualità: beam search a 5 (WHISPER_CPP_BEAM, 1 = più veloce) e contesto attivo tra le
      // finestre da 30 s del blocco (max_context -1 = tutto il testo precedente; il servizio
      // sulla VM è avviato con -mc 0, qui lo si sovrascrive per ogni richiesta).
      form.append('beam_size', String(Number(process.env.WHISPER_CPP_BEAM) || 5));
      form.append('max_context', '-1');
      // Prompt (glossario + stile, vedi buildWhisperPrompt in jobs/meetingTranscription.js).
      if (prompt) form.append('prompt', prompt);
      const data = await readJson(await callApi(`${base}/inference`, {
        method: 'POST',
        body: form,
        timeoutMs: 900000 // blocchi da ~2 minuti con beam 5: qualche minuto di calcolo
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
      // whisper.cpp con il VAD risponde 500 "basic_string::_M_construct null not valid" quando
      // nel blocco non trova parlato (solo rumore): non è un guasto, il blocco è senza testo.
      // Trattarlo come errore temporaneo lo farebbe riprovare per ore, bloccando la
      // trascrizione della riunione che lo aspetta in ordine.
      if (error.upstreamStatus === 500 && /_M_construct null/.test(error.message || '')) {
        return { segments: [], provider: 'Whisper.cpp large-v3-turbo' };
      }
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
// prompt: testo che Whisper usa come "detto prima" (glossario + stile); facoltativo.
export async function transcribeAudio(userId, audioBuffer, mime, baseUrl = null, prompt = '') {
  const base = String(baseUrl || whisperUrls()[0] || '').replace(/\/+$/, '');
  if (base && whisperCppUrls().includes(base)) return transcribeAudioCpp(base, audioBuffer, mime, prompt);
  if (base && base === parakeetUrl()) return transcribeAudioParakeet(base, audioBuffer, mime);
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
        headers: {
          'X-Whisper-Key': process.env.WHISPER_API_KEY,
          'Content-Type': mime || 'audio/wav',
          // Prompt in base64 (UTF-8): negli header HTTP le lettere accentate non sono ammesse.
          ...(prompt ? { 'X-Whisper-Prompt': Buffer.from(String(prompt), 'utf8').toString('base64') } : {})
        },
        body: audioBuffer,
        timeoutMs: 900000 // blocchi da ~2 minuti con beam 5: su CPU richiedono alcuni minuti
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
