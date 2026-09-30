// Monitor della VM (pagina vm-monitor.html): CPU, memoria, disco, rete, servizi, processi.
// Riservato all'admin (id_roles = 1) del tenant PROJEXA, verificato sul database come per
// l'editor dei prompt (routes/prompts.js).
//
// I dati si leggono direttamente dal sistema (/proc, statfs, systemctl): funziona solo sulla
// VM Linux; in locale su Windows l'endpoint risponde 501. Un campionatore interno legge i
// valori ogni 15 s e tiene in memoria le ultime 24 ore (si azzera a ogni riavvio del backend,
// quindi anche a ogni deploy). Costo trascurabile: qualche file di /proc ogni 15 s.
import express from 'express';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { whisperUrls, whisperCppUrls } from './ai.js';

const router = express.Router();

const IS_LINUX = process.platform === 'linux';
const SAMPLE_MS = 15 * 1000;
const HISTORY_MAX = (24 * 60 * 60 * 1000) / SAMPLE_MS; // 24 ore
const CLK_TCK = 100;                                   // tick al secondo di /proc (getconf CLK_TCK)
const PAGE = 4096;

// Soglia Oracle Always Free: VM A1 recuperabili se per 7 giorni CPU (95° percentile), rete e
// memoria restano sotto il 20%.
const IDLE_THRESHOLD = 20;

// ----------------------------------------------------------------------------
// ACCESSO: solo admin del tenant PROJEXA
// ----------------------------------------------------------------------------
// Esportato: lo usa anche la pagina Schedulazioni job (routes/job-schedules.js).
export async function requireProjexaAdmin(req, res, next) {
  try {
    if (Number(req.user?.id_roles) === 1) {
      const t = (await db.query('SELECT name FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
      if (t && String(t.name || '').trim().toUpperCase() === 'PROJEXA') return next();
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
  if (comm === 'whisper-server') return 'Whisper.cpp (Background-Veloce)';
  if (/uvicorn/.test(cmdline) && /whisper/.test(cmdline)) return 'Whisper (Background)';
  if (comm === 'uvicorn') return 'Whisper (Background)';
  if (comm.startsWith('ollama')) return 'Ollama (Recap lento)';
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

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ----------------------------------------------------------------------------
// SERVIZI E DATABASE
// ----------------------------------------------------------------------------
function serviceUnits() {
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
  units.push({ unit: 'ollama', label: 'Ollama (Recap lento)' });
  units.push({ unit: 'projexa-backup.timer', label: 'Backup notturno' });
  units.push({ unit: 'projexa-monitor.timer', label: 'Controlli di salute' });
  return units;
}

function serviceStates(units) {
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

// ----------------------------------------------------------------------------
// ENDPOINT
// ----------------------------------------------------------------------------
const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

router.get('/status', requireAuth, requireProjexaAdmin, async (req, res) => {
  try {
    if (!IS_LINUX) return res.status(501).json({ error: 'Monitor disponibile solo sulla VM Linux (in locale non ci sono dati di sistema).' });
    startVmSampler();
    const range = RANGES[req.query.range] ? req.query.range : '1h';
    const since = Date.now() - RANGES[range];
    const points = history.filter((p) => p.t >= since);
    const last = history[history.length - 1] || null;
    const mem = memInfo();
    const [services, databases, queue] = await Promise.all([serviceStates(serviceUnits()), databaseSizes(), transcriptionQueue()]);
    const all = history.map((p) => p.cpu);
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
      series: downsample(points, 240),
      idle: {
        threshold: IDLE_THRESHOLD,
        cpuP95: percentile(all, 95),
        memNow: last ? last.mem : null,
        hours: history.length ? (Date.now() - history[0].t) / 3600e3 : 0
      },
      processes: lastProcs.slice().sort((a, b) => b.rss - a.rss).slice(0, 10),
      services,
      databases,
      queue
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
