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
//
// Per non appesantire il PC: il modello lavora in un processo separato (js/recap-worker.js),
// così la pagina resta utilizzabile, e a recap finito viene scaricato e il processo chiuso,
// così la RAM (diversi GB sulle schede video integrate) torna libera. gpuProfile() dice se la
// scheda video è integrata: la dashboard sconsiglia allora Browser-Alto.

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const WORKER_URL = new URL('./recap-worker.js', import.meta.url);

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
// Stima iniziale caratteri per token. Le trascrizioni ne hanno meno del testo normale:
// gli orari "[00:12:34]" su ogni riga pesano molto (Gemma conta ogni cifra come un token).
// Se il modello rifiuta un testo troppo lungo, la stima si ricalibra sul conteggio vero.
const CHARS_PER_TOKEN = 2.5;
const OUT_FINAL = 900;         // token massimi del recap
const OUT_CHUNK = 450;         // token massimi degli appunti di un pezzo
const MARGIN = 150;

const est = (s, cpt = CHARS_PER_TOKEN) => Math.ceil(String(s || '').length / cpt);
// Avanzamento per l'utente: i token generati, in parole approssimate (~0,75 parole per token).
const words = (tokens) => `circa ${Math.round(tokens * 0.75)} parole`;

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
let _worker = null;
let _loading = null;

// Nome della scheda video dichiarato dal browser (WebGL), es. "ANGLE (AMD, AMD Radeon 780M
// Graphics ...)". '' se il browser lo nasconde.
function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '');
  } catch { return ''; }
}

// Scheda video vista dal browser: null se WebGPU non c'è. integrated = scheda integrata
// (memoria condivisa con il PC). Dal nome: le dedicate hanno sigle come RX, GeForce/RTX,
// Arc, Radeon Pro; le integrate "Radeon 780M / Radeon Graphics / Vega", Intel UHD/Iris,
// Adreno, Mali. Senza nome: dal produttore (Intel non-Arc, Qualcomm, ARM = integrate).
export async function gpuProfile() {
  try {
    if (!('gpu' in navigator)) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const info = adapter.info || {};
    const vendor = String(info.vendor || '').toLowerCase();
    const arch = String(info.architecture || '').toLowerCase();
    const name = gpuName();
    let integrated;
    // Intel "Arc Graphics" senza sigla è l'integrata dei Core Ultra; A770/B580 sono dedicate.
    if (/\b(RX|RTX|GTX)\b|GeForce|Quadro|Radeon Pro|Arc(\(TM\))?\s+[AB]\d{3}/i.test(name)) integrated = false;
    else if (/Radeon.*(\d{3}M\b|Graphics|Vega)|Intel|Iris|UHD|Adreno|Mali|Qualcomm/i.test(name)) integrated = true;
    else integrated = (vendor === 'intel' && !/xe-hpg|xe-hpc|alchemist|battlemage/.test(arch))
      || vendor === 'qualcomm' || vendor === 'arm';
    return { f16: adapter.features.has('shader-f16'), vendor, architecture: arch, name, integrated };
  } catch { return null; }
}

// Scarica (la prima volta) e carica il modello nel processo separato.
// onProgress riceve { progress 0..1, text }.
export async function preloadModel(mode, onProgress) {
  const cfg = resolveMode(mode);
  const gpu = await gpuProfile();
  if (!gpu) {
    throw Object.assign(new Error('Il recap nel browser richiede una scheda video con WebGPU, non disponibile su questo PC/browser. Scegli un\'altra AI in Impostazioni › AI.'), { code: 'NO_WEBGPU' });
  }
  const model = gpu.f16 ? cfg.model : cfg.f32;
  if (_engine && _engineModel === model) return { model };
  if (_loading) return _loading;
  _loading = (async () => {
    _lib = _lib || await import(/* @vite-ignore */ LIB_URL);
    await unloadModel();
    _worker = new Worker(WORKER_URL, { type: 'module' });
    _engine = await _lib.CreateWebWorkerMLCEngine(_worker, model, {
      initProgressCallback: (r) => { try { onProgress && onProgress({ progress: r.progress, text: r.text }); } catch {} }
    }, { context_window_size: CTX_TOKENS });
    _engineModel = model;
    return { model };
  })();
  try { return await _loading; } catch (e) { await unloadModel(); throw e; } finally { _loading = null; }
}

// Scarica il modello e chiude il processo separato: libera RAM e memoria video.
export async function unloadModel() {
  const engine = _engine;
  const worker = _worker;
  _engine = null;
  _engineModel = null;
  _worker = null;
  if (engine) { try { await engine.unload(); } catch {} }
  if (worker) worker.terminate();
}

// Testo rifiutato perché supera il contesto: errore con i caratteri inviati e i token contati
// dal modello, per ricalibrare la stima (vedi runRecap).
async function ask(prompt, maxTokens, onToken) {
  try {
    return await askOnce(prompt, maxTokens, onToken);
  } catch (e) {
    const err = toError(e);
    const m = /prompt tokens:\s*(\d+)/i.exec(err.message);
    if (/ContextWindowSizeExceeded/i.test(err.message) && m) {
      err.code = 'CONTEXT_EXCEEDED';
      err.promptChars = prompt.length;
      err.promptTokens = Number(m[1]);
    }
    throw err;
  }
}

async function askOnce(prompt, maxTokens, onToken) {
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
// Restituisce il recap (testo). A recap finito (o in errore) il modello viene sempre scaricato.
export async function generateRecap(input, opts = {}) {
  try {
    return await runRecap(input, opts);
  } catch (e) {
    throw toError(e);
  } finally {
    await unloadModel();
  }
}

// Dal Web Worker WebLLM gli errori arrivano spesso come testo semplice (non Error): senza
// questa conversione la dashboard mostrerebbe "undefined". L'originale resta in console.
function toError(e) {
  console.error('[RECAP BROWSER]', e);
  if (e instanceof Error) return e;
  const msg = typeof e === 'string' ? e : (e && (e.message || e.error)) || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
  const err = new Error(String(msg || 'errore sconosciuto').replace(/^Error:\s*/, ''));
  if (e && e.code) err.code = e.code;
  return err;
}

async function runRecap(input, { mode, onProgress, onStatus } = {}) {
  const status = (t) => { try { onStatus && onStatus(t); } catch {} };
  status('Caricamento del modello…');
  await preloadModel(mode, onProgress);

  // Se il modello rifiuta un testo troppo lungo (il controllo avviene prima che inizi a
  // scrivere, quindi si perde poco tempo), la stima caratteri/token si ricalibra sul
  // conteggio vero, con un 10% di margine, e si rifà la divisione in pezzi.
  let cpt = CHARS_PER_TOKEN;
  for (let attempt = 1; ; attempt++) {
    try {
      return await planAndRun(input, cpt, status);
    } catch (e) {
      if (e.code !== 'CONTEXT_EXCEEDED' || attempt >= 3) throw e;
      cpt = Math.min(cpt * 0.8, (e.promptChars / e.promptTokens) * 0.9);
      console.warn(`[RECAP BROWSER] testo troppo lungo (${e.promptTokens} token): nuova stima ${cpt.toFixed(2)} caratteri/token`);
      status('Testo più lungo del previsto: lo divido in pezzi più piccoli…');
    }
  }
}

async function planAndRun(input, cpt, status) {
  const template = String(input.template || '');
  const chunkPrompt = String(input.chunk_prompt || '');
  const templateTokens = est(template.replace('{{TRASCRIZIONE}}', ''), cpt);
  if (templateTokens + OUT_FINAL + MARGIN + 300 > CTX_TOKENS) {
    throw new Error('Il prompt del recap è troppo lungo per il modello nel browser');
  }
  const fits = (text) => templateTokens + est(text, cpt) + OUT_FINAL + MARGIN <= CTX_TOKENS;

  let text = String(input.transcript || '').trim();
  // Troppo lunga: appunti a pezzi, ripetuto finché gli appunti non stanno nel contesto.
  const chunkChars = Math.floor((CTX_TOKENS - est(chunkPrompt, cpt) - OUT_CHUNK - MARGIN) * cpt);
  for (let level = 0; !fits(text); level++) {
    if (level >= 3) throw new Error('Trascrizione troppo lunga per il modello nel browser');
    const pieces = splitText(text, chunkChars);
    const notes = [];
    for (let i = 0; i < pieces.length; i++) {
      const part = `Parte ${i + 1} di ${pieces.length}`;
      // Prima il modello legge il pezzo (nessun avanzamento visibile), poi scrive gli appunti.
      status(`${part}: lettura della trascrizione…`);
      const p = chunkPrompt.replace('{{N}}', i + 1).replace('{{TOT}}', pieces.length).replace('{{TESTO}}', pieces[i]);
      notes.push(await ask(p, OUT_CHUNK, (n) => { if (n % 10 === 0) status(`${part}: scrittura degli appunti… (${words(n)})`); }));
    }
    text = `(Appunti ricavati dalla trascrizione, riassunta a pezzi)\n\n${notes.join('\n\n')}`;
  }

  status('Recap: lettura degli appunti…');
  const recap = await ask(template.replace('{{TRASCRIZIONE}}', text), OUT_FINAL,
    (n) => { if (n % 10 === 0) status(`Recap: scrittura… (${words(n)})`); });
  if (!recap) throw new Error('Il modello non ha restituito alcun testo');
  return recap;
}
