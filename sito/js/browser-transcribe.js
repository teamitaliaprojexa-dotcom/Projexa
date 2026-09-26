// Trascrizione NEL BROWSER con Whisper (Transformers.js).
// Usata quando in Impostazioni "modalità Trascrizione" = Browser: l'audio non lascia
// il PC dell'utente, al server arriva solo il testo.
//
// Libreria e modello si scaricano dal loro sito originale (CDN), NON da Projexa:
// il repo GitHub ha un limite di spazio e i modelli pesano troppo per starci dentro.
// Il browser scarica una volta e tiene in cache; se il download è bloccato (proxy
// aziendale) chi chiama ricade sul server (modalità Background).
//
// NB: per la piena velocità (multi-thread WASM) servono gli header COOP/COEP sul server;
// senza, funziona lo stesso ma più lento. Con una GPU (WebGPU) usa la GPU automaticamente.

// Sorgenti configurabili (sovrascrivibili con window.PX_TRANSCRIBE_CFG prima dell'import).
// remote:true (default) = libreria e modello dal CDN. remote:false = serviti da Projexa
// (opzione tenuta per un eventuale hosting locale futuro).
const CFG = Object.assign({
  remote: true,
  libUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3', // libreria dal CDN
  modelBase: '/models/',   // usato solo se remote:false (hosting su Projexa)
  language: 'italian'
}, (typeof window !== 'undefined' && window.PX_TRANSCRIBE_CFG) || {});

// Mappa la scelta del campo "modalità Trascrizione" (settings) al modello Whisper.
//   Browser-leggero -> small  (tempo reale su CPU, per PC normali)
//   Browser-pesante -> turbo  (qualità alta, richiede GPU/WebGPU e molta RAM)
// Background non compare qui: quello resta la trascrizione sul server.
// device fissato per modalità: leggero sempre su CPU (affidabile, già in tempo reale);
// pesante su GPU (turbo richiede WebGPU). Il WebGPU non è affidabile su tutti i PC, per
// questo la modalità comune (leggero) non lo usa.
export const MODES = {
  'Browser-leggero': { model: 'Xenova/whisper-small', device: 'wasm', download: '~250 MB', needsGpu: false },
  'Browser-pesante': { model: 'onnx-community/whisper-large-v3-turbo', device: 'webgpu', download: '~800 MB', needsGpu: true }
};

// Il tipo di dati dipende dal motore: la quantizzazione q8 su WebGPU dà risultati errati,
// quindi su GPU si usa fp16; su CPU (WASM) la q8 è corretta ed è molto più leggera.
function dtypeFor(device) {
  return device === 'webgpu' ? 'fp16' : 'q8';
}

export function isBrowserMode(v) { return Object.prototype.hasOwnProperty.call(MODES, v); }

let _mod = null;      // libreria importata
let _pipe = null;     // pipeline caricata
let _pipeModel = null;// modello attualmente caricato (per non ricaricarlo)
let _device = null;   // 'webgpu' | 'wasm'
let _loading = null;  // Promise di caricamento in corso

// Risolve una scelta ('Browser-leggero'/'Browser-pesante') nella sua configurazione.
function resolveMode(mode) {
  const m = MODES[mode];
  if (!m) throw new Error(`Modalità di trascrizione non valida: ${mode}`);
  return m;
}

async function lib() {
  if (_mod) return _mod;
  _mod = await import(/* @vite-ignore */ CFG.libUrl);
  const { env } = _mod;
  if (CFG.remote) {
    // Modalità test/ripiego: libreria e modello dal CDN (Hugging Face).
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
  } else {
    // Tutto da Projexa: niente chiamate a Hugging Face.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = CFG.modelBase;
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
  }
  return _mod;
}

// Motore da usare. CFG.device ('webgpu'|'wasm') lo forza (utile se il WebGPU di un PC
// desse risultati errati); altrimenti si rileva: WebGPU se disponibile, se no CPU (WASM).
export async function detectDevice(prefer) {
  if (prefer === 'wasm') return 'wasm';
  if (prefer === 'webgpu' || CFG.device === 'webgpu' || CFG.device === 'wasm') {
    if (prefer === 'webgpu' || CFG.device === 'webgpu') {
      try { if ('gpu' in navigator && await navigator.gpu.requestAdapter()) return 'webgpu'; } catch {}
      return 'wasm'; // GPU richiesta ma non disponibile: ripiego su CPU
    }
    return CFG.device;
  }
  let webgpu = false;
  try { webgpu = 'gpu' in navigator && !!(await navigator.gpu.requestAdapter()); } catch { webgpu = false; }
  return webgpu ? 'webgpu' : 'wasm';
}

export function isMultiThread() {
  return typeof self !== 'undefined' && self.crossOriginIsolated === true;
}

// Scarica (una volta) e carica il modello della modalità scelta.
// mode = 'Browser-leggero' | 'Browser-pesante'. onProgress riceve {status, file, progress}.
// Restituisce { device, multiThread, model }. Chiamabile a vuoto per "installare" il modello
// al salvataggio del flyout Impostazioni.
export async function preloadModel(mode, onProgress) {
  const cfg = resolveMode(mode);
  if (_pipe && _pipeModel === cfg.model) return { device: _device, multiThread: isMultiThread(), model: cfg.model };
  if (_loading) return _loading;
  _loading = (async () => {
    const { pipeline } = await lib();
    const device = await detectDevice(cfg.device);
    _device = device;
    if (cfg.needsGpu && device !== 'webgpu') {
      // "pesante" richiede la GPU ma non c'è: chi chiama dovrebbe proporre "leggero" o
      // "server". Segnaliamo con un errore chiaro invece di trascrivere lentissimo/male.
      throw Object.assign(new Error('La modalità "pesante" richiede una GPU (WebGPU) non disponibile su questo PC. Usa "leggero" o "server".'), { code: 'NO_WEBGPU' });
    }
    _pipe = await pipeline('automatic-speech-recognition', cfg.model, {
      device,
      dtype: dtypeFor(device),
      progress_callback: (p) => { try { onProgress && onProgress(p); } catch {} }
    });
    _pipeModel = cfg.model;
    return { device, multiThread: isMultiThread(), model: cfg.model };
  })();
  try { return await _loading; } finally { _loading = null; }
}

export function isModelReady(mode) { return !!_pipe && (!mode || _pipeModel === MODES[mode]?.model); }

// Trascrive un buffer audio Float32 mono a 16 kHz con la modalità scelta.
// Restituisce { text, chunks }. chunks (se richiesti) contiene i segmenti con orari.
export async function transcribe(float32_16k, opts = {}) {
  if (!_pipe) await preloadModel(opts.mode || 'Browser-leggero', opts.onProgress);
  const res = await _pipe(float32_16k, {
    language: opts.language || CFG.language,
    task: 'transcribe',
    chunk_length_s: opts.chunkLengthSec || 30,
    stride_length_s: opts.strideSec || 5,
    return_timestamps: opts.timestamps || false
  });
  return { text: (res.text || '').trim(), chunks: res.chunks || null };
}

export const config = CFG;
