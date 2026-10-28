// ============================================================================
// BASI DEI MODELLI F16 + Q4_K_M CON IMATRIX (job «quantizza_modelli», 2026-10-28)
// ----------------------------------------------------------------------------
// Un passo per giro, in background, così lo schedulatore (che esegue i job uno dopo l'altro) non
// resta fermo un'ora e mezza su questo job:
//   1. la prima base non ancora rifatta (OLLAMA_RECAP_MODEL, OLLAMA_PM_FILTRO_4B_BASE,
//      OLLAMA_PM_FILTRO_MODEL, OLLAMA_FUNZIONI_14B_MODEL; parametri.basi per sceglierle) con
//      deploy/oracle/setup-modelli-imatrix.sh: F16 originale, matrice di importanza, Q4_K_M nuovo
//      al posto della base con lo stesso nome;
//   2. finite le basi, un modello addestrato alla volta riapplicato sulla base nuova (stesso
//      adattatore dell'ultima installazione, routes/analisiPm.js riapplicaAdattatore);
//   3. poi niente: il giro risponde «tutto aggiornato» (il job si può disattivare).
// Precedenze (config/ollamaPrecedenza.js): parte solo a VM libera (niente Assistente PM,
// registrazioni, trascrizioni, lavori di «Projexa»), altrimenti rimanda al giro dopo. Mentre
// lavora recap e funzioni con «Projexa» aspettano e il riavvio della domenica
// (aggiornamenti_vm) viene rimandato. Se parte l'Assistente PM lo script si ferma (la sua RAM
// serve alla call): la base resta quella di prima e si riprova al giro dopo.
// parametri.f16 = { "<base>": "<versione fp16 su Ollama>" } per basi fuori dal catalogo dello script.
// L'esito di un passo si legge nel report del giro successivo (precedente).
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { segnaModelli, suPrecedenza, vmOccupata, modelliInAggiornamento } from '../config/ollamaPrecedenza.js';
import { iniziaLavoro, lavoriProjexaInCorso } from '../config/lavoriProjexa.js';
import { famiglieDaRiapplicare, riapplicaAdattatore, leggiBasi } from '../routes/analisiPm.js';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(QUI, '..', '..', 'deploy', 'oracle', 'setup-modelli-imatrix.sh');
const CARTELLA_MODELLI = process.env.OLLAMA_MODELLI_DIR || path.join(os.homedir(), 'projexa-modelli');
const ESITO = path.join(CARTELLA_MODELLI, 'basi', 'ultimo-giro.json');
const MAX_MS = 165 * 60000; // sotto le 3 ore dopo cui lo schedulatore considera libero un blocco
const RIGHE_LOG = 40;

let inCorso = null; // { cosa, dal }

// Basi in uso, prima la più usata e per ultima la più lunga da rifare (14B).
function basiInUso() {
  const filtro = process.env.OLLAMA_PM_FILTRO_MODEL || 'qwen2.5:3b';
  return [...new Set([
    process.env.OLLAMA_RECAP_MODEL || 'qwen3:8b',
    process.env.OLLAMA_PM_FILTRO_4B_BASE || 'qwen3:4b-instruct',
    filtro === 'nessuno' ? '' : filtro,
    process.env.OLLAMA_FUNZIONI_14B_MODEL || 'qwen3:14b'
  ].filter(Boolean))];
}

function salvaEsito(esito) {
  try {
    fs.mkdirSync(path.dirname(ESITO), { recursive: true });
    fs.writeFileSync(ESITO, JSON.stringify({ ...esito, finito: new Date().toISOString() }, null, 1));
  } catch (e) { console.warn('[QUANTIZZA] esito non salvato:', e.message); }
}
const leggiEsito = () => { try { return JSON.parse(fs.readFileSync(ESITO, 'utf8')); } catch { return null; } };

// Lo script con l'output per la pagina Monitor; si ferma se parte l'Assistente PM.
function lanciaScript(arg, lavoro) {
  return new Promise((resolve, reject) => {
    const p = spawn('bash', [SCRIPT, arg], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    let resto = '', motivo = '';
    const ferma = (m) => { motivo = m; try { process.kill(-p.pid, 'SIGTERM'); } catch { /* già finito */ } };
    const togli = suPrecedenza((k) => { if (String(k).startsWith('pm:')) ferma('è partito l\'Assistente PM'); });
    const t = setTimeout(() => ferma(`oltre ${Math.round(MAX_MS / 60000)} minuti`), MAX_MS);
    const leggi = (buf) => {
      resto += String(buf);
      const righe = resto.split(/\r|\n/);
      resto = righe.pop();
      for (const r of righe.map((x) => x.trimEnd()).filter(Boolean)) {
        log.push(r); if (log.length > RIGHE_LOG) log.shift();
        const m = /^\[(\d)\/(\d)\]\s*(.*)$/.exec(r);
        if (m) lavoro.fase(m[3], Number(m[1]) - 1, Number(m[2]));
      }
    };
    p.stdout.on('data', leggi);
    p.stderr.on('data', leggi);
    p.on('error', (e) => { clearTimeout(t); togli(); reject(Object.assign(e, { log })); });
    p.on('close', (codice) => {
      clearTimeout(t); togli();
      if (codice === 0) resolve(log);
      else reject(Object.assign(new Error(motivo ? `Interrotto: ${motivo}` : (log.slice(-3).join(' ') || `codice ${codice}`)), { log }));
    });
  });
}

function avviaBase(base, f16) {
  const lavoro = iniziaLavoro({ cosa: 'Aggiornamento modelli', titolo: `${base}: F16 + imatrix`, modello: base });
  inCorso = { cosa: `base ${base}`, dal: new Date().toISOString() };
  segnaModelli('quant', true);
  lanciaScript(f16 ? `${base}=${f16}` : base, lavoro)
    .then((log) => salvaEsito({ ok: true, cosa: `base ${base}`, log: log.slice(-12) }))
    .catch((e) => {
      console.error(`❌ [QUANTIZZA] ${base}:`, e.message);
      salvaEsito({ ok: false, cosa: `base ${base}`, errore: e.message, log: (e.log || []).slice(-12) });
    })
    .finally(() => { segnaModelli('quant', false); lavoro.fine(); inCorso = null; });
}

function avviaRiapplica(chiave) {
  const p = riapplicaAdattatore(chiave, 'job quantizza_modelli'); // errori sincroni: al chiamante
  inCorso = { cosa: `riapplica ${chiave}`, dal: new Date().toISOString() };
  p.then((r) => salvaEsito(r.esito === 'ok'
    ? { ok: true, cosa: `riapplicato ${r.nome}`, unione: r.unione, backup: r.backup }
    : { ok: false, cosa: `riapplica ${r.nome}`, errore: r.messaggio }))
    .finally(() => { inCorso = null; });
}

export async function eseguiQuantizzaModelli(riga = {}) {
  if (process.platform !== 'linux') throw new Error('Job solo per la VM (Ollama e llama.cpp)');
  if (!fs.existsSync(SCRIPT)) throw new Error(`Script non trovato: ${SCRIPT}`);
  const par = riga.parametri || {};
  const precedente = leggiEsito();
  const basi = leggiBasi();
  const scelte = Array.isArray(par.basi) && par.basi.length ? par.basi.map(String) : basiInUso();
  const stato = { basiFatte: scelte.filter((b) => basi[b]), basiDaFare: scelte.filter((b) => !basi[b]), daRiapplicare: famiglieDaRiapplicare() };
  const rapporto = (azione, extra = {}) => ({ ok: !(precedente && precedente.ok === false), azione, ...extra, ...stato, precedente });

  if (inCorso || modelliInAggiornamento()) return rapporto('già in corso', { lavoro: inCorso });
  const lavori = lavoriProjexaInCorso();
  if (vmOccupata() || lavori.length) {
    return rapporto('rimandato', { motivo: vmOccupata() ? 'Assistente PM, registrazione o trascrizione in corso' : `${lavori.length} lavori di Projexa in corso` });
  }
  if (stato.basiDaFare.length) {
    const base = stato.basiDaFare[0];
    avviaBase(base, par.f16 && par.f16[base]);
    return rapporto('avviato', { lavoro: `base ${base} (circa 1 ora, 1,5 per il 14B)` });
  }
  if (stato.daRiapplicare.length) {
    avviaRiapplica(stato.daRiapplicare[0]);
    return rapporto('avviato', { lavoro: `riapplica ${stato.daRiapplicare[0]} sulla base nuova` });
  }
  return rapporto('tutto aggiornato: il job si può disattivare');
}
