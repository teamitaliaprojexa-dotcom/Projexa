// ============================================================================
// JOB CHE LANCIANO GLI SCRIPT DELLA VM (backup e copia su staging)
// ----------------------------------------------------------------------------
// Dal 2026-10-01 il backup notturno (backup-db.sh) e la copia VM -> staging Neon
// (sync-staging.sh) non partono più dai timer systemd ma dallo schedulatore
// (tabella job_schedules), così esito, durata e log si vedono nella pagina
// Schedulazioni. Gli script restano quelli installati in /opt/projexa da
// deploy/oracle/setup-backup.sh e setup-sync-staging.sh: girano con l'utente del
// backend (opc), lo stesso dei vecchi servizi systemd.
// ============================================================================
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const APP_DIR = process.env.PROJEXA_APP_DIR || '/opt/projexa';
const RIGHE_LOG = 60; // righe di output conservate nel report

function eseguiScript(script, args, timeoutMs) {
  const percorso = `${APP_DIR}/${script}`;
  if (!fs.existsSync(percorso)) {
    return Promise.reject(new Error(`Script non trovato: ${percorso} (i job di sistema girano solo sulla VM)`));
  }
  return new Promise((resolve, reject) => {
    execFile(percorso, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const righe = `${stdout || ''}\n${stderr || ''}`.split('\n').map((r) => r.trimEnd()).filter(Boolean);
      const log = righe.slice(-RIGHE_LOG);
      if (err) {
        const motivo = err.killed ? `interrotto dopo ${Math.round(timeoutMs / 60000)} min` : `uscita con codice ${err.code}`;
        const e = new Error(`${script} ${motivo}:\n${righe.slice(-8).join('\n')}`);
        e.report = { ok: false, script, log };
        return reject(e);
      }
      resolve({ ok: true, script, log });
    });
  });
}

// Backup dei 4 database della VM nell'Object Storage (bucket projexa-backup).
export const eseguiBackupDb = () => eseguiScript('backup-db.sh', [], 30 * 60 * 1000);

// Copia dei 4 database della VM sullo staging Neon (la vecchia produzione Neon).
// Lo script rifiuta qualsiasi destinazione che non sia *.neon.tech.
export const eseguiCopiaStaging = () => eseguiScript('sync-staging.sh', [], 60 * 60 * 1000);

// ----------------------------------------------------------------------------
// PULIZIA DELLA VM (job "pulizia_vm", 2026-10-07)
// ----------------------------------------------------------------------------
// Toglie solo ciò che NON si pulisce da solo e che si può rigenerare senza danni:
//   - cache dei pacchetti di sistema (sudo dnf clean all);
//   - log di systemd oltre 500 MB / 30 giorni (Whisper, Caddy, Ollama...);
//   - cache di pip e di npm (si riscaricano se servono);
//   - log di PM2 del backend oltre PM2_LOG_MAX_MB: svuotati (si tengono i nuovi).
// NON tocca: modelli di Whisper/Ollama (~/.cache/huggingface ecc.), backup (si puliscono da
// backup-db.sh), database, file del progetto. Scritto in Node (non come script .sh) così
// arriva sulla VM con il normale deploy. Ogni passo è indipendente: se uno fallisce si
// annota nel report e si va avanti; il job fallisce solo se falliscono tutti.
const PM2_LOG_MAX_MB = 100;

function comando(cmd, args, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`.split('\n').map((r) => r.trimEnd()).filter(Boolean);
      resolve({ ok: !err, out, errore: err ? (err.code === 'ENOENT' ? 'comando non trovato' : err.message.split('\n')[0]) : null });
    });
  });
}

async function spazioDisco() {
  const r = await comando('df', ['-h', '--output=used,avail,pcent', '/']);
  return r.ok && r.out[1] ? r.out[1].trim().replace(/\s+/g, ' ') : '?';
}

export async function eseguiPuliziaVm() {
  if (process.platform !== 'linux' || !fs.existsSync(APP_DIR)) {
    throw new Error(`Pulizia non eseguibile qui (${APP_DIR} assente): i job di sistema girano solo sulla VM`);
  }
  const log = [`Disco prima (usato, libero, %): ${await spazioDisco()}`];
  let riusciti = 0, falliti = 0;
  const passo = async (nome, cmd, args) => {
    const r = await comando(cmd, args);
    if (r.ok) riusciti += 1; else falliti += 1;
    log.push(`${r.ok ? 'OK' : 'ERRORE'} ${nome}${r.errore ? `: ${r.errore}` : ''}`);
    r.out.slice(-3).forEach((l) => log.push(`   ${l}`));
  };

  await passo('cache pacchetti (dnf clean all)', 'sudo', ['-n', 'dnf', 'clean', 'all']);
  await passo('log di systemd (max 500 MB / 30 giorni)', 'sudo', ['-n', 'journalctl', '--vacuum-size=500M', '--vacuum-time=30d']);
  // pip: la cache è dell'utente (~/.cache/pip), basta un solo ambiente Python.
  const pip = [`${APP_DIR}/whisper-venv/bin/pip`, `${APP_DIR}/oci-venv/bin/pip`].find((p) => fs.existsSync(p));
  if (pip) await passo('cache di pip', pip, ['cache', 'purge']);
  else log.push('SALTATO cache di pip: nessun ambiente Python trovato');
  await passo('cache di npm', 'npm', ['cache', 'clean', '--force']);

  // Log di PM2: oltre la soglia si svuota il file (PM2 continua a scriverci in coda).
  const dirPm2 = path.join(os.homedir(), '.pm2', 'logs');
  try {
    const files = fs.existsSync(dirPm2) ? fs.readdirSync(dirPm2).filter((f) => f.endsWith('.log')) : [];
    let svuotati = 0;
    for (const f of files) {
      const p = path.join(dirPm2, f);
      const mb = fs.statSync(p).size / (1024 * 1024);
      if (mb > PM2_LOG_MAX_MB) { fs.truncateSync(p, 0); svuotati += 1; log.push(`   ${f}: ${mb.toFixed(0)} MB svuotato`); }
    }
    riusciti += 1;
    log.push(`OK log di PM2: ${svuotati ? `${svuotati} file oltre ${PM2_LOG_MAX_MB} MB svuotati` : `tutti sotto ${PM2_LOG_MAX_MB} MB, nessuna modifica`}`);
  } catch (e) {
    falliti += 1;
    log.push(`ERRORE log di PM2: ${e.message}`);
  }

  log.push(`Disco dopo (usato, libero, %): ${await spazioDisco()}`);
  if (!riusciti) {
    const e = new Error(`pulizia_vm: tutti i passi falliti\n${log.slice(-8).join('\n')}`);
    e.report = { ok: false, script: 'pulizia_vm', log };
    throw e;
  }
  return { ok: falliti === 0, script: 'pulizia_vm', log };
}
