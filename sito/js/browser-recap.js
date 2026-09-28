// Recap delle riunioni NEL BROWSER con un modello linguistico locale (WebLLM + WebGPU).
// Usato quando in Impostazioni › AI "AI generazione e-mail recap" = Recap Projexa
// (Browser-Medio / Browser-Alto): gratuito, nessuna chiave API, la trascrizione non esce
// dal PC. Il server passa trascrizione e prompt (GET /calendar/meetings/managed/recap-input),
// il recap torna con PUT /calendar/meetings/managed/text (field=recap).
//
// Libreria e modello si scaricano dai loro siti (jsdelivr, huggingface, raw.githubusercontent
// per il motore WebAssembly), NON da Projexa: pesano diversi GB. Il browser li scarica una
// volta e li tiene in cache. Serve WebGPU (scheda video): senza, errore NO_WEBGPU.
//
// Il modello ha un contesto di ~4.000 token (circa un quarto d'ora di riunione): le
// trascrizioni più lunghe si riassumono prima a pezzi (prompt chunk_prompt del server) e il
// recap si scrive dagli appunti.

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

// Voce del campo settings (in minuscolo) -> modello WebLLM. f32: variante per le GPU senza
// supporto "shader-f16" (più pesante). mistral-nemo non è distribuito per WebLLM: per "Alto"
// si usa gemma-2-9b, il modello più grande disponibile e buono in italiano.
export const MODES = {
  'recap projexa (browser-medio)': {
    label: 'Qwen2.5 7B', model: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-7B-Instruct-q4f32_1-MLC', download: '~4,5 GB'
  },
  'recap projexa (browser-alto)': {
    label: 'Gemma 2 9B', model: 'gemma-2-9b-it-q4f16_1-MLC', f32: 'gemma-2-9b-it-q4f32_1-MLC', download: '~5,5 GB'
  }
};

const CTX_TOKENS = 4096;       // contesto dei modelli WebLLM
const CHARS_PER_TOKEN = 3;     // stima prudente per l'italiano
const OUT_FINAL = 900;         // token massimi del recap
const OUT_CHUNK = 450;         // token massimi degli appunti di un pezzo
const MARGIN = 150;

const est = (s) => Math.ceil(String(s || '').length / CHARS_PER_TOKEN);

export function isBrowserRecapMode(v) {
  return Object.prototype.hasOwnProperty.call(MODES, String(v || '').trim().toLowerCase());
}

function resolveMode(mode) {
  const m = MODES[String(mode || '').trim().toLowerCase()];
  if (!m) throw new Error(`Modalità di recap non valida: ${mode}`);
  return m;
}

let _lib = null;
let _engine = null;
let _engineModel = null;
let _loading = null;

async function gpuInfo() {
  try {
    if (!('gpu' in navigator)) return null;
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { f16: adapter.features.has('shader-f16') } : null;
  } catch { return null; }
}

// Scarica (la prima volta) e carica il modello. onProgress riceve { progress 0..1, text }.
export async function preloadModel(mode, onProgress) {
  const cfg = resolveMode(mode);
  const gpu = await gpuInfo();
  if (!gpu) {
    throw Object.assign(new Error('Il recap nel browser richiede una scheda video con WebGPU, non disponibile su questo PC/browser. Scegli un\'altra AI in Impostazioni › AI.'), { code: 'NO_WEBGPU' });
  }
  const model = gpu.f16 ? cfg.model : cfg.f32;
  if (_engine && _engineModel === model) return { model };
  if (_loading) return _loading;
  _loading = (async () => {
    _lib = _lib || await import(/* @vite-ignore */ LIB_URL);
    if (_engine) { try { await _engine.unload(); } catch {} _engine = null; }
    _engine = await _lib.CreateMLCEngine(model, {
      initProgressCallback: (r) => { try { onProgress && onProgress({ progress: r.progress, text: r.text }); } catch {} }
    }, { context_window_size: CTX_TOKENS });
    _engineModel = model;
    return { model };
  })();
  try { return await _loading; } finally { _loading = null; }
}

async function ask(prompt, maxTokens, onToken) {
  const stream = await _engine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    frequency_penalty: 0.3, // i modelli piccoli tendono a ripetere interi paragrafi
    max_tokens: maxTokens,
    stream: true
  });
  let text = '';
  let n = 0;
  for await (const chunk of stream) {
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
    if (d) { text += d; n++; if (onToken) onToken(n); }
  }
  return text.trim();
}

// Divide il testo in pezzi di circa maxChars, tagliando a fine riga.
function splitText(text, maxChars) {
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

// input: { template, transcript, chunk_prompt } dal server. onStatus(testo) per la dashboard.
// Restituisce il recap (testo).
export async function generateRecap(input, { mode, onProgress, onStatus } = {}) {
  const status = (t) => { try { onStatus && onStatus(t); } catch {} };
  status('Caricamento del modello…');
  await preloadModel(mode, onProgress);

  const template = String(input.template || '');
  const chunkPrompt = String(input.chunk_prompt || '');
  const templateTokens = est(template.replace('{{TRASCRIZIONE}}', ''));
  if (templateTokens + OUT_FINAL + MARGIN + 300 > CTX_TOKENS) {
    throw new Error('Il prompt del recap è troppo lungo per il modello nel browser');
  }
  const fits = (text) => templateTokens + est(text) + OUT_FINAL + MARGIN <= CTX_TOKENS;

  let text = String(input.transcript || '').trim();
  // Troppo lunga: appunti a pezzi, ripetuto finché gli appunti non stanno nel contesto.
  const chunkChars = (CTX_TOKENS - est(chunkPrompt) - OUT_CHUNK - MARGIN) * CHARS_PER_TOKEN;
  for (let level = 0; !fits(text); level++) {
    if (level >= 3) throw new Error('Trascrizione troppo lunga per il modello nel browser');
    const pieces = splitText(text, chunkChars);
    const notes = [];
    for (let i = 0; i < pieces.length; i++) {
      status(`Lettura della trascrizione: parte ${i + 1} di ${pieces.length}…`);
      const p = chunkPrompt.replace('{{N}}', i + 1).replace('{{TOT}}', pieces.length).replace('{{TESTO}}', pieces[i]);
      notes.push(await ask(p, OUT_CHUNK));
    }
    text = `(Appunti ricavati dalla trascrizione, riassunta a pezzi)\n\n${notes.join('\n\n')}`;
  }

  status('Scrittura del recap…');
  const recap = await ask(template.replace('{{TRASCRIZIONE}}', text), OUT_FINAL,
    (n) => { if (n % 25 === 0) status(`Scrittura del recap… (${n} parole)`); });
  if (!recap) throw new Error('Il modello non ha restituito alcun testo');
  return recap;
}
