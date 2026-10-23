// Monitor della VM (pagina monitor.html, scheda Monitor VM): CPU, memoria, disco, rete, servizi, processi.
// Riservato all'admin (id_roles = 1) del tenant PROJEXA (sola lettura per MONITOR_LETTURA_EMAILS), verificato sul database come per
// l'editor dei prompt (routes/prompts.js).
//
// I dati si leggono direttamente dal sistema (/proc, statfs, systemctl): funziona solo sulla
// VM Linux; in locale su Windows l'endpoint risponde 501. Un campionatore interno legge i
// valori ogni 15 s e tiene in memoria le ultime 24 ore (si azzera a ogni riavvio del backend,
// quindi anche a ogni deploy). Costo trascurabile: qualche file di /proc ogni 15 s.
import express from 'express';
import fs from 'fs';
import os from 'os';
import { execFile, spawn } from 'child_process';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { whisperUrls, whisperCppUrls, whisperAssistentePorta, parakeetUrl } from './ai.js';
import { registraAccesso } from '../config/audit.js';
import { lavoriProjexaInCorso } from '../config/lavoriProjexa.js';

const router = express.Router();

const IS_LINUX = process.platform === 'linux';
const SAMPLE_MS = 15 * 1000;
const HISTORY_MAX = (24 * 60 * 60 * 1000) / SAMPLE_MS; // 24 ore
const CLK_TCK = 100;                                   // tick al secondo di /proc (getconf CLK_TCK)
const PAGE = 4096;

// ----------------------------------------------------------------------------
// ACCESSO: admin del tenant PROJEXA (completo) o utenti in sola lettura
// ----------------------------------------------------------------------------
async function isProjexaAdmin(req) {
  if (Number(req.user?.id_roles) !== 1) return false;
  const t = (await db.query('SELECT name FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
  return !!t && String(t.name || '').trim().toUpperCase() === 'PROJEXA';
}

// Utenti che vedono la pagina Monitor in SOLA LETTURA (solo richieste GET: nessuna modifica,
// nessuna azione), in qualunque tenant: email separate da virgola in MONITOR_LETTURA_EMAILS.
function emailSolaLettura(req) {
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return String(process.env.MONITOR_LETTURA_EMAILS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(email);
}

// Pagina Monitor (Monitor VM, Schedulazioni, Log): admin PROJEXA con tutti i permessi,
// utenti di MONITOR_LETTURA_EMAILS solo in lettura (le scritture restano 403).
// Esportato: lo usano anche routes/job-schedules.js e routes/audit-log.js.
export async function requireMonitorAccess(req, res, next) {
  try {
    if (await isProjexaAdmin(req)) { req.monitorSolaLettura = false; return next(); }
    if (emailSolaLettura(req)) {
      if (req.method === 'GET') { req.monitorSolaLettura = true; return next(); }
      return res.status(403).json({ error: 'Accesso in sola lettura: operazione non consentita' });
    }
    res.status(403).json({ error: 'Pagina riservata all\'amministratore di Projexa' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ----------------------------------------------------------------------------
// LETTURE DA /proc
// ----------------------------------------------------------------------------
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function cpuTimes() {
  const f = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, idle: idle + iowait, iowait, steal };
}

function memInfo() {
  const m = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(line);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  return {
    total: m.MemTotal || 0,
    available: m.MemAvailable || 0,
    cache: (m.Cached || 0) + (m.Buffers || 0),
    swapTotal: m.SwapTotal || 0,
    swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0)
  };
}

// Interfaccia di rete principale (esclusa lo): byte ricevuti/inviati dall'avvio.
function netBytes() {
  let rx = 0;
  let tx = 0;
  for (const line of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0];
    tx += f[8];
  }
  return { rx, tx };
}

function diskInfo() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, used: total - free, free };
  } catch {
    return null;
  }
}

// Nome leggibile del processo (mai la riga di comando completa: potrebbe contenere dati).
function processLabel(comm, cmdline) {
  if (comm === 'whisper-server') {
    const porta = whisperAssistentePorta();
    return porta && cmdline.includes(`--port ${porta}`) ? 'Whisper.cpp (Assistente PM)' : 'Whisper.cpp (Background-Veloce)';
  }
  if (/uvicorn/.test(cmdline) && /whisper/.test(cmdline)) return 'Whisper (Background)';
  if (comm === 'uvicorn') return 'Whisper (Background)';
  if (/parakeet-service/.test(cmdline)) return 'Parakeet (trascrizione)';
  if (comm.startsWith('ollama')) return 'Ollama (servizio)';
  // Processi di Ollama che tengono in RAM i modelli caricati (uno per modello).
  if (comm === 'llama-server' || /ollama.*runner/.test(cmdline)) return 'Ollama (modelli caricati)';
  if (comm === 'postgres' || comm === 'postmaster') return 'PostgreSQL';
  if (comm === 'caddy') return 'Caddy (HTTPS)';
  if (comm === 'node' || /node/.test(comm)) return /server\.js|projexa/.test(cmdline) ? 'Projexa (Node)' : 'Node';
  if (/^PM2/.test(comm)) return 'PM2';
  return comm;
}

// Processi raggruppati per nome: RAM residente e tempo CPU cumulato (tick).
function processTable() {
  const groups = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return groups; }
  for (const pid of dirs) {
    const stat = read(`/proc/${pid}/stat`);
    if (!stat) continue;
    const end = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, end);
    const f = stat.slice(end + 2).split(' ');
    const ticks = Number(f[11]) + Number(f[12]); // utime + stime
    const rss = Number(f[21]) * PAGE;
    if (!rss) continue; // thread del kernel
    const cmdline = read(`/proc/${pid}/cmdline`).replace(/\0/g, ' ');
    const label = processLabel(comm, cmdline);
    const g = groups.get(label) || { name: label, rss: 0, ticks: 0, count: 0 };
    g.rss += rss;
    g.ticks += ticks;
    g.count += 1;
    groups.set(label, g);
  }
  return groups;
}

// ----------------------------------------------------------------------------
// CAMPIONATORE (storico in memoria)
// ----------------------------------------------------------------------------
const history = [];   // { t, cpu, mem, swap, rx, tx } - cpu/mem/swap in %, rete in byte/s
let prev = null;      // ultima lettura grezza, per le differenze
let lastProcs = [];   // processi con CPU % dell'ultimo intervallo
let timer = null;

function sample() {
  const now = Date.now();
  const cpu = cpuTimes();
  const mem = memInfo();
  const net = netBytes();
  const procs = processTable();
  if (prev) {
    const dt = cpu.total - prev.cpu.total;
    const sec = (now - prev.t) / 1000;
    const pct = dt > 0 ? 100 * (1 - (cpu.idle - prev.cpu.idle) / dt) : 0;
    history.push({
      t: now,
      cpu: Math.max(0, Math.min(100, pct)),
      mem: mem.total ? 100 * (mem.total - mem.available) / mem.total : 0,
      swap: mem.swapTotal ? 100 * mem.swapUsed / mem.swapTotal : 0,
      rx: Math.max(0, (net.rx - prev.net.rx) / sec),
      tx: Math.max(0, (net.tx - prev.net.tx) / sec)
    });
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    // CPU % per processo: tick consumati nell'intervallo rispetto a UN core (come top).
    lastProcs = [...procs.values()].map((g) => {
      const before = prev.procs.get(g.name);
      const dTicks = before ? Math.max(0, g.ticks - before.ticks) : 0;
      return { name: g.name, count: g.count, rss: g.rss, cpu: sec > 0 ? 100 * dTicks / CLK_TCK / sec : 0 };
    });
  }
  prev = { t: now, cpu, net, procs };
}

export function startVmSampler() {
  if (!IS_LINUX || timer) return;
  sample();
  timer = setInterval(() => { try { sample(); } catch (e) { /* lettura saltata */ } }, SAMPLE_MS);
  timer.unref();
}

// Carico attuale della VM (pagina Schedulazioni › Trascrizioni e recap): CPU dall'ultimo
// campione (null finché non ce ne sono due, cioè nei primi 15 s) e memoria letta adesso.
export function vmCarico() {
  if (!IS_LINUX) return null;
  startVmSampler();
  const last = history[history.length - 1] || null;
  const m = memInfo();
  return {
    cpu: last ? last.cpu : null, memUsed: m.total - m.available, memTotal: m.total, memAvailable: m.available,
    swapUsed: m.swapUsed, swapTotal: m.swapTotal, cores: os.cpus().length
  };
}

// Riduce lo storico a max n punti (media per gruppo), per grafici leggeri.
function downsample(points, n) {
  if (points.length <= n) return points;
  const size = Math.ceil(points.length / n);
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    const g = points.slice(i, i + size);
    const avg = (k) => g.reduce((s, p) => s + p[k], 0) / g.length;
    out.push({ t: g[g.length - 1].t, cpu: avg('cpu'), mem: avg('mem'), swap: avg('swap'), rx: avg('rx'), tx: avg('tx') });
  }
  return out;
}

// ----------------------------------------------------------------------------
// SERVIZI E DATABASE
// ----------------------------------------------------------------------------
export function serviceUnits() {
  const units = [
    { unit: 'caddy', label: 'Caddy (HTTPS)' },
    { unit: 'postgresql-18', label: 'PostgreSQL' },
    { unit: 'pm2-opc', label: 'PM2 (avvio Projexa)' }
  ];
  for (const u of whisperUrls()) {
    const port = /:(\d+)$/.exec(u);
    if (port && /127\.0\.0\.1|localhost/.test(u)) units.push({ unit: `projexa-whisper@${port[1]}`, label: `Whisper Background (${port[1]})` });
  }
  if (whisperCppUrls().length) units.push({ unit: 'projexa-whisper-cpp', label: 'Whisper.cpp (Background-Veloce)' });
  const assistente = whisperAssistentePorta();
  if (assistente) units.push({ unit: 'projexa-whisper-assistente', label: `Whisper.cpp (Assistente PM, ${assistente})` });
  if (parakeetUrl()) units.push({ unit: 'projexa-parakeet', label: 'Parakeet TDT 0.6B v3 (trascrizione)' });
  if (process.env.PII_URL) units.push({ unit: 'projexa-pii', label: 'Anonymization Layer (Presidio + spaCy)' });
  units.push({ unit: 'ollama', label: 'Ollama (Projexa: recap, Assistente PM, funzioni AI, associazioni)' });
  // Backup notturno: dal 2026-10-01 è un job dello schedulatore (pagina Schedulazioni), non più un timer.
  units.push({ unit: 'projexa-monitor.timer', label: 'Controlli di salute' });
  return units;
}

export function serviceStates(units) {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', ...units.map((u) => u.unit)], { timeout: 5000 }, (err, stdout) => {
      const lines = String(stdout || '').trim().split('\n');
      resolve(units.map((u, i) => ({ ...u, state: (lines[i] || 'unknown').trim() })));
    });
  });
}

async function databaseSizes() {
  try {
    const r = await db.query(
      `SELECT datname AS name, pg_database_size(datname)::bigint AS bytes
         FROM pg_database WHERE datname LIKE 'projexa%' ORDER BY datname`
    );
    return r.rows.map((x) => ({ name: x.name, bytes: Number(x.bytes) }));
  } catch {
    return [];
  }
}

async function transcriptionQueue() {
  try {
    const r = await db.query(
      `SELECT COUNT(*) FILTER (WHERE kind = 'audio' AND state = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE kind = 'audio' AND state = 'transcribing')::int AS transcribing,
              COUNT(*) FILTER (WHERE kind = 'finalize')::int AS recap
         FROM rec_meeting_chunks`
    );
    return r.rows[0];
  } catch {
    return null;
  }
}

// Modelli di Ollama (2026-10-20): non sono servizi a parte ma file che l'unico servizio Ollama
// carica in RAM quando servono. Installati (/api/tags) + quelli in RAM adesso (/api/ps).
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const USO_MODELLO = [
  [/^recap-projexa-14b-bk-/, 'backup del recap 14B'],
  [/^recap-projexa-14b/, 'Recap con «Projexa 14B»'],
  [/^recap-projexa-bk-/, 'backup del recap'],
  [/^recap-projexa/, 'Recap con «Projexa» (8B)'],
  [/^pm-projexa-filtro-bk-/, 'backup del filtro 4B dell\'Assistente PM'],
  [/^pm-projexa-filtro/, 'filtro 4B addestrato dell\'Assistente PM («Projexa 4B + 8B»)'],
  [/^pm-projexa-bk-/, 'backup dell\'Assistente PM'],
  [/^pm-projexa/, 'Assistente PM (Pm projexa, 8B)'],
  [/^qwen2\.5:3b/, 'filtro veloce dell\'Assistente PM («Projexa 3B + 8B»)'],
  [/^qwen3:4b-instruct/, 'filtro veloce dell\'Assistente PM («Projexa 4B + 8B»)'],
  [/^qwen3:14b/, 'base del 14B: «Projexa 14B» di Dossier, funzioni PM, email; associazioni'],
  [/^qwen3:8b/, 'base dell\'8B: recap, Assistente PM; «Projexa» di Dossier, funzioni PM, email'],
  [/^qwen2\.5:7b/, 'vecchia base 7B: la usano i backup *-bk-20261020-2300 (eliminarla solo dopo averli tolti)']
];
async function ollamaModelli() {
  try {
    const get = async (p) => (await fetch(`${OLLAMA_URL}${p}`, { signal: AbortSignal.timeout(3000) })).json();
    const [tags, ps] = await Promise.all([get('/api/tags'), get('/api/ps')]);
    const pulito = (n) => String(n || '').replace(/:latest$/, '');
    const inRam = new Map((ps.models || []).map((m) => [pulito(m.name || m.model), m]));
    return (tags.models || []).map((m) => {
      const nome = pulito(m.name);
      const r = inRam.get(nome);
      return { nome, uso: (USO_MODELLO.find(([re]) => re.test(nome)) || [null, ''])[1], disco: m.size, ram: r ? Number(r.size) || null : null, scade: r ? r.expires_at : null };
    }).sort((a, b) => (b.ram || 0) - (a.ram || 0) || a.nome.localeCompare(b.nome));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// ENDPOINT
// ----------------------------------------------------------------------------
const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

// Tipo di accesso alla pagina Monitor: la dashboard lo usa per mostrare la voce di menu,
// la pagina per nascondere i comandi di modifica. Risponde 200 anche a chi non ha accesso.
router.get('/accesso', requireAuth, async (req, res) => {
  try {
    const accesso = (await isProjexaAdmin(req)) ? 'completo' : emailSolaLettura(req) ? 'lettura' : null;
    res.json({ accesso });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', requireAuth, requireMonitorAccess, async (req, res) => {
  try {
    if (!IS_LINUX) return res.status(501).json({ error: 'Monitor disponibile solo sulla VM Linux (in locale non ci sono dati di sistema).' });
    startVmSampler();
    const range = RANGES[req.query.range] ? req.query.range : '1h';
    const since = Date.now() - RANGES[range];
    const points = history.filter((p) => p.t >= since);
    const last = history[history.length - 1] || null;
    const mem = memInfo();
    const [services, databases, queue, ollama] = await Promise.all([serviceStates(serviceUnits()), databaseSizes(), transcriptionQueue(), ollamaModelli()]);
    res.json({
      host: os.hostname(),
      cpus: os.cpus().length,
      uptime: os.uptime(),
      load: os.loadavg(),
      now: last,
      memory: mem,
      disk: diskInfo(),
      range,
      sampleSeconds: SAMPLE_MS / 1000,
      historyFrom: history.length ? history[0].t : null,
      // Recap e lavori AI con il modello locale che stanno girando adesso (config/lavoriProjexa.js).
      projexa: lavoriProjexaInCorso(),
      series: downsample(points, 240),
      // I 10 più grandi per RAM, più Ollama sempre (a riposo occupa poco e restava fuori elenco).
      processes: (() => {
        const ordinati = lastProcs.slice().sort((a, b) => b.rss - a.rss);
        const primi = ordinati.slice(0, 10);
        return [...primi, ...ordinati.slice(10).filter((p) => p.name.startsWith('Ollama'))];
      })(),
      services,
      ollama,
      databases,
      queue
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------------
// OBJECT STORAGE (scheda Storage): bucket dei backup notturni
// ----------------------------------------------------------------------------
// Legge l'elenco degli oggetti con la CLI di Oracle della VM, autenticata come
// "instance principal" (la stessa del backup, deploy/oracle/backup-db.sh): nessuna chiave
// nel backend. Il criterio projexa-backup-policy dà accesso SOLO a questo bucket, quindi
// "utilizzato" è lo spazio di questo bucket; i 20 GB Always Free valgono per tutti i bucket
// dell'account (oggi c'è solo questo). La CLI è lenta ad avviarsi (Python): risposta in
// memoria per 60 s, «Aggiorna» la rilegge.
const OCI_CLI = process.env.OCI_CLI || '/opt/projexa/oci-venv/bin/oci';
const STORAGE_BUCKET = process.env.BACKUP_BUCKET || 'projexa-backup';
const STORAGE_NS = process.env.OCI_NAMESPACE || 'axzmowo31clc';
const STORAGE_CAPIENZA = Number(process.env.OCI_STORAGE_CAPIENZA_GB || 20) * 1024 ** 3;
const STORAGE_CACHE_MS = 60 * 1000;
let storageCache = null; // { t, dati }

function ociJson(args) {
  return new Promise((resolve, reject) => {
    execFile(OCI_CLI, ['--auth', 'instance_principal', ...args, '--output', 'json'],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || '').trim().split('\n').filter(Boolean).pop() || err.message;
          return reject(new Error(err.code === 'ENOENT' ? `CLI di Oracle non trovata (${OCI_CLI})` : msg.slice(0, 300)));
        }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch (e) { reject(new Error('Risposta della CLI non leggibile')); }
      });
  });
}

async function leggiOggetti() {
  const r = await ociJson(['os', 'object', 'list', '--namespace', STORAGE_NS, '--bucket-name', STORAGE_BUCKET,
    '--all', '--fields', 'name,size,timeCreated,storageTier']);
  return (r.data || []).map((o) => ({
    nome: o.name,
    byte: Number(o.size) || 0,
    creato: o['time-created'] || o.timeCreated || null,
    livello: o['storage-tier'] || o.storageTier || null
  }));
}

// Eliminazione manuale (solo admin): sempre una cartella intera di backup, mai i più recenti.
const CARTELLA_BACKUP = /^(daily\/\d{4}-\d{2}-\d{2}|monthly\/\d{4}-\d{2})$/;
const PROTETTI_GIORNALIERI = 14; // ultimi 14 backup giornalieri
const PROTETTI_MENSILI = 1;      // ultimo backup mensile

const cartellaDi = (nome) => nome.split('/').slice(0, 2).join('/');

// Cartelle che non si possono eliminare: gli ultimi PROTETTI_GIORNALIERI giornalieri e gli
// ultimi PROTETTI_MENSILI mensili (per nome = per data, più recenti per primi).
function cartelleProtette(oggetti) {
  const cartelle = [...new Set(oggetti.map((o) => cartellaDi(o.nome)).filter((c) => CARTELLA_BACKUP.test(c)))]
    .sort().reverse();
  return [
    ...cartelle.filter((c) => c.startsWith('daily/')).slice(0, PROTETTI_GIORNALIERI),
    ...cartelle.filter((c) => c.startsWith('monthly/')).slice(0, PROTETTI_MENSILI)
  ];
}

router.get('/storage', requireAuth, requireMonitorAccess, async (req, res) => {
  try {
    if (!IS_LINUX) return res.status(501).json({ error: 'Storage leggibile solo dalla VM (in locale manca la CLI di Oracle).' });
    if (storageCache && req.query.aggiorna !== '1' && Date.now() - storageCache.t < STORAGE_CACHE_MS) {
      return res.json(storageCache.dati);
    }
    const oggetti = await leggiOggetti();
    const usato = oggetti.reduce((s, o) => s + o.byte, 0);
    const dati = {
      bucket: STORAGE_BUCKET,
      capienza: STORAGE_CAPIENZA,
      usato,
      disponibile: Math.max(0, STORAGE_CAPIENZA - usato),
      oggetti,
      // Regole di conservazione di deploy/oracle/backup-db.sh
      conservazione: { giornalieri: 30, mensili: 12 },
      protette: cartelleProtette(oggetti),
      protezione: { giornalieri: PROTETTI_GIORNALIERI, mensili: PROTETTI_MENSILI },
      letto: new Date().toISOString()
    };
    storageCache = { t: Date.now(), dati };
    res.json(dati);
  } catch (error) {
    res.status(502).json({ error: `Object Storage non leggibile: ${error.message}` });
  }
});

// Elimina una cartella di backup (tutti i suoi file). POST: requireMonitorAccess lo
// consente solo all'admin PROJEXA, la sola lettura riceve 403. Le cartelle protette si
// ricontrollano qui su un elenco appena riletto (non sulla cache). L'operazione resta nel
// log degli accessi (evento eliminazione_backup), riuscita o no.
router.post('/storage/elimina', requireAuth, requireMonitorAccess, express.json(), async (req, res) => {
  const cartella = String((req.body && req.body.cartella) || '').trim();
  const traccia = (esito, dettaglio) => registraAccesso(req, {
    evento: 'eliminazione_backup', esito, userId: req.user.user_id, email: req.user.email,
    tenantId: req.user.tenant_id, dettaglio
  });
  try {
    if (!IS_LINUX) return res.status(501).json({ error: 'Storage gestibile solo dalla VM.' });
    if (!CARTELLA_BACKUP.test(cartella)) return res.status(400).json({ error: 'Cartella non valida' });
    const oggetti = await leggiOggetti();
    if (cartelleProtette(oggetti).includes(cartella)) {
      return res.status(400).json({ error: `«${cartella}» è fra i backup protetti (ultimi ${PROTETTI_GIORNALIERI} giornalieri e ultimo mensile): non si può eliminare.` });
    }
    const file = oggetti.filter((o) => cartellaDi(o.nome) === cartella);
    if (!file.length) return res.status(404).json({ error: 'Cartella non trovata (già eliminata?)' });
    let eliminati = 0;
    let byte = 0;
    try {
      for (const o of file) {
        await ociJson(['os', 'object', 'delete', '--namespace', STORAGE_NS, '--bucket-name', STORAGE_BUCKET,
          '--object-name', o.nome, '--force']);
        eliminati += 1;
        byte += o.byte;
      }
    } finally {
      storageCache = null;
      if (eliminati) console.log(`[STORAGE] ${req.user.email}: eliminati ${eliminati}/${file.length} file di ${cartella}`);
    }
    traccia('ok', `${cartella}: ${eliminati} file, ${Math.round(byte / 1024 / 1024)} MB`);
    res.json({ cartella, eliminati, byte });
  } catch (error) {
    traccia('ko', `${cartella}: ${error.message}`.slice(0, 1000));
    res.status(502).json({ error: `Eliminazione non riuscita: ${error.message}` });
  }
});

// ----------------------------------------------------------------------------
// SCHEDA AGGIORNAMENTI: aggiornamenti di sicurezza di Oracle Linux (dnf)
// ----------------------------------------------------------------------------
// «Verifica» = sudo dnf check-update --security (anche in sola lettura: non modifica nulla).
// «Applica» = sudo dnf upgrade --security -y, solo admin. L'installazione gira staccata dal
// backend (detached, output su file) così un riavvio di PM2 o un deploy non la interrompono;
// lo stato si ricava dal file (riga finale __ESITO__ <codice>) e dal pid ancora vivo.
// Il riavvio della VM (kernel) non si fa da qui: resta da SSH.
const AGG_LOG = '/var/tmp/projexa-aggiornamenti.log';
const AGG_STATO = '/var/tmp/projexa-aggiornamenti.json'; // { pid, avviato, email }
let ultimaVerifica = null; // { letto, pacchetti, riavvio, errore }

export function sudoDnf(args, timeout) {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', 'dnf', ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ codice: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Righe di check-update: «nome.arch  versione  repository» (le altre righe sono intestazioni).
function pacchettiDa(stdout) {
  const out = [];
  for (const riga of stdout.split('\n')) {
    const m = riga.trim().match(/^(\S+)\.(\S+)\s+(\S+)\s+(\S+)$/);
    if (m && !/^Obsoleting/i.test(riga)) out.push({ nome: m[1], arch: m[2], versione: m[3], repo: m[4] });
  }
  return out;
}

// dnf needs-restarting -r: codice 1 = serve il riavvio della VM, 0 = no.
export async function riavvioNecessario() {
  const r = await sudoDnf(['needs-restarting', '-r'], 60000);
  if (r.codice === 0) return { necessario: false };
  if (r.codice === 1) return { necessario: true, motivo: r.stdout.trim().split('\n').slice(0, 8).join('\n') };
  return null; // plugin assente o errore: non si sa
}

// Tutti gli aggiornamenti disponibili, con «sicurezza: true» su quelli coperti da un avviso di
// sicurezza (ELSA). Codici di check-update: 0 = niente, 100 = aggiornamenti disponibili, altro = errore.
async function verificaAggiornamenti() {
  const tutti = await sudoDnf(['-q', 'check-update'], 180000);
  const sic = tutti.codice === 100 ? await sudoDnf(['-q', 'check-update', '--security'], 180000) : { codice: 0, stdout: '' };
  const ko = [tutti, sic].find((r) => r.codice !== 0 && r.codice !== 100);
  if (ko) {
    const msg = (ko.stderr.trim().split('\n').filter(Boolean).pop() || `dnf ha risposto con codice ${ko.codice}`).slice(0, 300);
    ultimaVerifica = { letto: new Date().toISOString(), pacchetti: [], riavvio: null, errore: msg };
    return ultimaVerifica;
  }
  const diSicurezza = new Set(pacchettiDa(sic.stdout).map((p) => `${p.nome}.${p.arch}`));
  const pacchetti = pacchettiDa(tutti.stdout).map((p) => ({ ...p, sicurezza: diSicurezza.has(`${p.nome}.${p.arch}`) }));
  ultimaVerifica = { letto: new Date().toISOString(), pacchetti, riavvio: await riavvioNecessario(), errore: null };
  return ultimaVerifica;
}

function pidVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function statoInstallazione() {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(AGG_STATO, 'utf8')); } catch { return null; }
  const testo = read(AGG_LOG);
  const m = testo.match(/__ESITO__ (\d+)\s*$/);
  const righe = testo.replace(/__ESITO__ \d+\s*$/, '').split('\n');
  return {
    avviato: info.avviato,
    email: info.email || null,
    inCorso: !m && pidVivo(info.pid),
    esito: m ? Number(m[1]) : null,
    finito: m ? (fs.statSync(AGG_LOG).mtime.toISOString()) : null,
    output: righe.slice(-200).join('\n').trim()
  };
}

router.get('/aggiornamenti', requireAuth, requireMonitorAccess, async (req, res) => {
  try {
    if (!IS_LINUX) return res.status(501).json({ error: 'Aggiornamenti verificabili solo sulla VM (Oracle Linux).' });
    const installazione = statoInstallazione();
    const verifica = req.query.verifica === '1' && !installazione?.inCorso
      ? await verificaAggiornamenti()
      : ultimaVerifica;
    res.json({ verifica, installazione });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Avvia l'installazione degli aggiornamenti di sicurezza (POST: solo admin PROJEXA).
router.post('/aggiornamenti/applica', requireAuth, requireMonitorAccess, async (req, res) => {
  const traccia = (esito, dettaglio) => registraAccesso(req, {
    evento: 'aggiornamento_sistema', esito, userId: req.user.user_id, email: req.user.email,
    tenantId: req.user.tenant_id, dettaglio
  });
  try {
    if (!IS_LINUX) return res.status(501).json({ error: 'Disponibile solo sulla VM.' });
    if (statoInstallazione()?.inCorso) return res.status(409).json({ error: 'Un\'installazione è già in corso.' });
    const fd = fs.openSync(AGG_LOG, 'w');
    const figlio = spawn('sh', ['-c', 'sudo -n dnf upgrade --security -y 2>&1; echo "__ESITO__ $?"'],
      { detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    figlio.unref();
    const avviato = new Date().toISOString();
    fs.writeFileSync(AGG_STATO, JSON.stringify({ pid: figlio.pid, avviato, email: req.user.email }));
    ultimaVerifica = null; // da rifare a fine installazione
    console.log(`[AGGIORNAMENTI] dnf upgrade --security avviato da ${req.user.email} (pid ${figlio.pid})`);
    traccia('ok', 'dnf upgrade --security avviato');
    res.json({ ok: true, avviato });
  } catch (error) {
    traccia('ko', String(error.message).slice(0, 1000));
    res.status(500).json({ error: `Avvio non riuscito: ${error.message}` });
  }
});

export default router;
