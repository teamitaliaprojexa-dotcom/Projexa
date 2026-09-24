// ============================================================================
// PROGRAMMA: TRASCRIZIONE E RECAP DELLE RIUNIONI (coda sul server)
// ----------------------------------------------------------------------------
// La dashboard registra la riunione e invia blocchi audio WAV di ~60 s su due tracce
// (microfono dell'utente / audio di sistema). Ogni blocco viene SALVATO SUBITO nella
// tabella rec_meeting_chunks (audio cifrato) e il server lo elabora in background:
//   1. trascrizione con il servizio Whisper (routes/ai.js -> transcribeAudio);
//   2. frasi aggiunte, cifrate, a rec_meeting.trascrizione;
//   3. il blocco viene CANCELLATO dalla coda appena trascritto.
// Quando arriva il segnale di fine registrazione (riga "finalize") e i blocchi di quella
// riunione sono finiti, il server genera da solo il recap (rec_meeting.recap).
//
// Così la pagina si può chiudere dopo "Ferma": la coda sta nel database e riparte anche
// dopo un riavvio del server. Su Render Free il servizio si spegnerebbe dopo 15 minuti
// senza richieste: finché la coda non è vuota il server chiama il proprio /api/health
// (keep-alive), poi smette.
//
// Tabella: Supporto/CreaDB/rec_meeting_chunks.sql
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { encryptValue, isEncrypted, hasEncryptionKey } from '../config/crypto.js';
import { transcribeAudio, askAiProvider } from '../routes/ai.js';

export const NOME_PROGRAMMA = 'meetingTranscription';

const OTHERS_LABEL = 'Partecipanti';
const MAX_ATTEMPTS = 30;              // ~ alcune ore di tentativi con attese crescenti
const STALE_HOURS = 48;               // blocchi più vecchi: scartati (non si conserva audio)
const KEEPALIVE_MS = 5 * 60 * 1000;   // < 15 minuti di Render Free
const IDLE_POLL_MS = 15 * 1000;       // attesa quando ci sono solo blocchi "da riprovare"

// ----------------------------------------------------------------------------
// UTILITÀ
// ----------------------------------------------------------------------------

// Colonne di rec_meeting cifrate a riposo (AES-256-GCM, config/crypto.js): oggetto,
// mittente, trascrizione, recap. In lettura tornano in chiaro in automatico (cryptoPool).
// Usata anche per l'audio in coda.
export function encRec(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!hasEncryptionKey()) {
    console.warn('⚠️  ENCRYPTION_KEY non impostata: rec_meeting viene scritta in chiaro.');
    return value;
  }
  return isEncrypted(value) ? value : encryptValue(String(value));
}

export function hhmmss(totalSec) {
  const t = Math.max(0, Math.floor(Number(totalSec) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

// Chi parla al microfono: nome e cognome dell'utente (tabella users), altrimenti l'email.
export async function speakerName(user) {
  try {
    const r = await db.query('SELECT name, cognome FROM users WHERE id = $1 LIMIT 1', [user.user_id]);
    const u = r.rows[0] || {};
    const full = [u.name, u.cognome].filter(Boolean).join(' ').trim();
    if (full) return full;
  } catch (e) { /* si ripiega sull'email */ }
  return user.email || 'Io';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isTemporary = (e) =>
  [429, 500, 502, 503, 504, 529].includes(e.status) || [429, 500, 502, 503, 504, 529].includes(e.upstreamStatus);

// ----------------------------------------------------------------------------
// TRASCRIZIONE DI UN BLOCCO -> rec_meeting.trascrizione
// ----------------------------------------------------------------------------

// Le due tracce si trascrivono una dopo l'altra; le frasi si uniscono in ordine di tempo
// con il nome di chi parla e si AGGIUNGONO (cifrate) alla trascrizione della riunione.
export async function transcribeChunkInto(user, idCalendar, { mic, sys, mime, offset, startLabel }) {
  const lines = [];
  if (mic) {
    const me = await speakerName(user);
    const r = await transcribeAudio(user.user_id, mic, mime);
    r.segments.forEach((x) => lines.push({ start: x.start, who: me, text: x.text }));
  }
  if (sys) {
    const r = await transcribeAudio(user.user_id, sys, mime);
    const who = mic ? OTHERS_LABEL : '';
    r.segments.forEach((x) => lines.push({ start: x.start, who, text: x.text }));
  }
  lines.sort((a, b) => a.start - b.start);

  let add = '';
  if (startLabel) add += `\n--- ${String(startLabel).slice(0, 80)} ---\n`;
  for (const l of lines) add += `[${hhmmss((Number(offset) || 0) + l.start)}] ${l.who ? `${l.who}: ` : ''}${l.text.replace(/\s*\n\s*/g, ' ')}\n`;
  if (!add) return 0;

  // Il testo è cifrato: si legge in chiaro (decifratura automatica), si aggiunge il blocco e
  // si riscrive tutto cifrato (la coda elabora i blocchi di una riunione in ordine, uno alla volta).
  const cur = await db.query(
    `SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, idCalendar]
  );
  if (cur.rows.length === 0) return 0; // riunione cancellata nel frattempo
  const full = (cur.rows[0].trascrizione || '') + add;
  await db.query(
    `UPDATE rec_meeting SET trascrizione = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
    [encRec(full), user.tenant_id, user.user_id, idCalendar]
  );
  return lines.length;
}

// ----------------------------------------------------------------------------
// RECAP -> rec_meeting.recap
// ----------------------------------------------------------------------------
//
// L'AI si sceglie in Impostazioni › AI con il campo "AI generazione e-mail recap"
// (settings.valore2 per tenant/utente); il prompt è il file prompts/recap_email.txt,
// modificabile senza toccare il codice. Segnaposto: {{TRASCRIZIONE}}, {{OGGETTO}},
// {{DATA}}, {{UTENTE}}. Il recap sostituisce quello eventualmente già presente.
const RECAP_PROMPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'recap_email.txt');

function buildRecapPrompt(vars) {
  let tpl = fs.readFileSync(RECAP_PROMPT_FILE, 'utf8');
  // Se il file non prevede il segnaposto, la trascrizione si aggiunge in fondo.
  if (!tpl.includes('{{TRASCRIZIONE}}')) tpl += '\n\nTrascrizione:\n{{TRASCRIZIONE}}';
  return tpl.replace(/\{\{(TRASCRIZIONE|OGGETTO|DATA|UTENTE)\}\}/g, (m, k) => vars[k] || '');
}

// user: { tenant_id, user_id, email }. Restituisce { provider, model, length }.
export async function generateRecap(user, idCalendar) {
  const row = (await db.query(
    `SELECT trascrizione, oggetto, data_calendar, orario_calendar FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, idCalendar]
  )).rows[0];
  if (!row) throw httpError(404, 'Riunione non gestita con Projexa');
  if (!row.trascrizione || !row.trascrizione.trim()) throw httpError(400, 'Nessuna trascrizione da cui generare il recap');

  const setting = (await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND LOWER(BTRIM(campo)) IN ('ai generazione e-mail recap', '(*) ai generazione e-mail recap')
      LIMIT 1`,
    [user.tenant_id, user.user_id]
  )).rows[0];
  const providerName = setting && setting.valore2 ? String(setting.valore2).trim() : '';
  if (!providerName) throw httpError(400, 'Scegli l\'AI in Impostazioni › AI › "AI generazione e-mail recap"');

  const data = row.data_calendar ? String(row.data_calendar).split('-').reverse().join('/') : '';
  const prompt = buildRecapPrompt({
    TRASCRIZIONE: row.trascrizione.trim(),
    OGGETTO: row.oggetto || '',
    DATA: [data, row.orario_calendar ? String(row.orario_calendar).slice(0, 5) : ''].filter(Boolean).join(' '),
    UTENTE: await speakerName(user)
  });

  const result = await askAiProvider(user.user_id, providerName, prompt);
  const recap = String(result.text || '').trim();
  if (!recap) throw httpError(502, `${result.label} non ha restituito alcun testo`);

  await db.query(
    `UPDATE rec_meeting SET recap = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
    [encRec(recap), user.tenant_id, user.user_id, idCalendar]
  );
  console.log(`[RECAP] ✓ Recap generato con ${result.label} per la riunione ${idCalendar}`);
  return { provider: result.label, model: result.model, length: recap.length };
}

// ----------------------------------------------------------------------------
// CODA (tabella rec_meeting_chunks)
// ----------------------------------------------------------------------------

// Blocco audio in coda (base64 dei WAV, cifrato). Restituisce l'id della riga.
export async function enqueueChunk(user, idCalendar, { micB64, sysB64, mime, offset, startLabel }) {
  const r = await db.query(
    `INSERT INTO rec_meeting_chunks
       (tenant_id, user_id, user_email, id_calendar, kind, mime, offset_sec, start_label, audio_mic, audio_system)
     VALUES ($1, $2, $3, $4, 'audio', $5, $6, $7, $8, $9)
     RETURNING id`,
    // Cifrati: audio, email e intestazione. In chiaro solo le chiavi tecniche della coda.
    [user.tenant_id, user.user_id, user.email ? encRec(user.email) : null, idCalendar, mime || 'audio/wav',
      Number(offset) || 0, startLabel ? encRec(String(startLabel).slice(0, 120)) : null,
      micB64 ? encRec(micB64) : null, sysB64 ? encRec(sysB64) : null]
  );
  kickTranscriptionWorker();
  return r.rows[0].id;
}

// Fine registrazione: quando i blocchi precedenti della riunione sono trascritti, recap.
export async function enqueueFinalize(user, idCalendar) {
  await db.query(
    `INSERT INTO rec_meeting_chunks (tenant_id, user_id, user_email, id_calendar, kind)
     VALUES ($1, $2, $3, $4, 'finalize')`,
    [user.tenant_id, user.user_id, user.email ? encRec(user.email) : null, idCalendar]
  );
  kickTranscriptionWorker();
}

// Blocchi ancora in coda per le riunioni indicate: Map id_calendar -> numero di blocchi audio.
export async function pendingChunks(user, ids) {
  if (!ids.length) return new Map();
  try {
    const r = await db.query(
      `SELECT id_calendar, COUNT(*)::int AS n FROM rec_meeting_chunks
        WHERE tenant_id = $1 AND user_id = $2 AND kind = 'audio' AND id_calendar = ANY($3::text[])
        GROUP BY id_calendar`,
      [user.tenant_id, user.user_id, ids]
    );
    return new Map(r.rows.map((x) => [x.id_calendar, x.n]));
  } catch (e) {
    return new Map(); // tabella non ancora creata: nessuna coda
  }
}

// Ultimo orario già "prenotato" dai blocchi in coda (per far continuare gli orari di una
// nuova registrazione della stessa riunione anche se la trascrizione non è ancora finita).
export async function queuedEndOffset(user, idCalendar) {
  try {
    const r = await db.query(
      `SELECT MAX(offset_sec) AS m FROM rec_meeting_chunks
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND kind = 'audio'`,
      [user.tenant_id, user.user_id, idCalendar]
    );
    return r.rows[0].m == null ? -1 : Number(r.rows[0].m) + 60;
  } catch (e) {
    return -1;
  }
}

// Prossimo lavoro: il più vecchio tra i "primi della fila" di ogni riunione pronti ora
// (l'ordine dei blocchi di una riunione è sempre rispettato, anche durante i tentativi).
async function nextJob() {
  const r = await db.query(
    `SELECT c.* FROM rec_meeting_chunks c
      WHERE c.seq = (SELECT MIN(c2.seq) FROM rec_meeting_chunks c2
                      WHERE c2.tenant_id = c.tenant_id AND c2.user_id = c.user_id AND c2.id_calendar = c.id_calendar)
        AND c.next_try_at <= NOW()
      ORDER BY c.seq
      LIMIT 1`
  );
  return r.rows[0] || null;
}

async function hasPendingJobs() {
  const r = await db.query('SELECT 1 FROM rec_meeting_chunks LIMIT 1');
  return r.rows.length > 0;
}

async function dropJob(job) {
  await db.query('DELETE FROM rec_meeting_chunks WHERE id = $1', [job.id]);
}

async function retryLater(job, error) {
  const attempts = (Number(job.attempts) || 0) + 1;
  const waitSec = Math.min(60 * attempts, 15 * 60); // 1, 2, 3 ... fino a 15 minuti
  await db.query(
    `UPDATE rec_meeting_chunks
        SET attempts = $2, last_error = $3, next_try_at = NOW() + ($4 || ' seconds')::interval
      WHERE id = $1`,
    [job.id, attempts, encRec(String(error.message || error).slice(0, 500)), String(waitSec)]
  );
  console.warn(`[TRASCRIZIONE] ${job.kind} ${job.id_calendar}: tentativo ${attempts}/${MAX_ATTEMPTS} fallito (${error.message}), nuovo tentativo tra ${waitSec}s`);
}

// Blocco che non si riesce a trascrivere: nella trascrizione resta una nota (niente buchi silenziosi).
async function markChunkLost(user, job, reason) {
  try {
    const cur = await db.query(
      `SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [user.tenant_id, user.user_id, job.id_calendar]
    );
    if (cur.rows.length === 0) return;
    const note = `${job.start_label ? `\n--- ${job.start_label} ---\n` : ''}[${hhmmss(job.offset_sec)}] (blocco audio non trascritto: ${String(reason).slice(0, 150)})\n`;
    await db.query(
      `UPDATE rec_meeting SET trascrizione = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
      [encRec((cur.rows[0].trascrizione || '') + note), user.tenant_id, user.user_id, job.id_calendar]
    );
  } catch (e) { /* la nota è facoltativa */ }
}

async function processJob(job) {
  const user = { tenant_id: job.tenant_id, user_id: job.user_id, email: job.user_email };
  try {
    if (job.kind === 'finalize') {
      const t = await db.query(
        `SELECT (trascrizione IS NOT NULL AND BTRIM(trascrizione) <> '') AS has_tr FROM rec_meeting
          WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
        [user.tenant_id, user.user_id, job.id_calendar]
      );
      if (t.rows[0] && t.rows[0].has_tr) await generateRecap(user, job.id_calendar);
    } else {
      // Lettura dal pool con decifratura automatica: l'audio torna base64 in chiaro.
      const mic = job.audio_mic ? Buffer.from(job.audio_mic, 'base64') : null;
      const sys = job.audio_system ? Buffer.from(job.audio_system, 'base64') : null;
      const n = await transcribeChunkInto(user, job.id_calendar, {
        mic, sys, mime: job.mime || 'audio/wav', offset: job.offset_sec, startLabel: job.start_label
      });
      console.log(`[TRASCRIZIONE] ✓ ${job.id_calendar} blocco da ${hhmmss(job.offset_sec)}: ${n} frasi`);
    }
    await dropJob(job);
  } catch (error) {
    const attempts = (Number(job.attempts) || 0) + 1;
    if (isTemporary(error) && attempts < MAX_ATTEMPTS) {
      await retryLater(job, error);
      return;
    }
    console.error(`❌ [TRASCRIZIONE] ${job.kind} ${job.id_calendar} abbandonato: ${error.message}`);
    if (job.kind === 'audio') await markChunkLost(user, job, error.message);
    await dropJob(job);
  }
}

// ----------------------------------------------------------------------------
// ELABORAZIONE IN BACKGROUND + KEEP-ALIVE
// ----------------------------------------------------------------------------

let workerRunning = false;
let keepAliveTimer = null;

// Finché la coda lavora, il server chiama il proprio indirizzo pubblico: per Render è
// traffico in ingresso, quindi il servizio Free non si spegne a metà (anche a pagina chiusa).
function startKeepAlive() {
  const base = String(process.env.BACKEND_URL || '').replace(/\/+$/, '');
  if (keepAliveTimer || !/^https:\/\//.test(base)) return;
  keepAliveTimer = setInterval(() => {
    fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  }, KEEPALIVE_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function cleanupStale() {
  const r = await db.query(
    `DELETE FROM rec_meeting_chunks WHERE created_at < NOW() - ($1 || ' hours')::interval`,
    [String(STALE_HOURS)]
  );
  if (r.rowCount) console.warn(`[TRASCRIZIONE] scartati ${r.rowCount} blocchi più vecchi di ${STALE_HOURS} ore`);
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  startKeepAlive();
  try {
    await cleanupStale();
    for (;;) {
      const job = await nextJob();
      if (job) { await processJob(job); continue; }
      if (!(await hasPendingJobs())) break;               // coda vuota: fine
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS)); // solo blocchi in attesa di nuovo tentativo
    }
  } catch (error) {
    // Tabella non ancora creata o database non raggiungibile: si riproverà al prossimo avvio/blocco.
    if (!/rec_meeting_chunks/.test(error.message || '')) console.error('❌ [TRASCRIZIONE] coda:', error.message);
  } finally {
    workerRunning = false;
    stopKeepAlive();
  }
}

// Avvia l'elaborazione (se non è già in corso). Chiamata a ogni nuovo blocco e all'avvio
// del server, per riprendere i blocchi rimasti in coda.
export function kickTranscriptionWorker() {
  runWorker().catch(() => {});
}
