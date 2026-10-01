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
