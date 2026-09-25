// ============================================================================
// PROGRAMMA: TRASCRIZIONE E RECAP DELLE RIUNIONI (coda sul server)
// ----------------------------------------------------------------------------
// La dashboard registra la riunione e invia blocchi audio WAV di ~30 s: microfono
// dell'utente e audio di sistema MIXATI in una sola traccia (audio_mix), più il volume
// delle due tracce per finestre di 0,5 s (energy), che serve a capire chi parla. I blocchi
// muti non vengono inviati. Ogni blocco viene SALVATO SUBITO nella tabella
// rec_meeting_chunks (audio cifrato) e il server lo elabora in background:
//   1. trascrizione con Whisper: più servizi (WHISPER_URLS) lavorano IN PARALLELO, un
//      blocco ciascuno;
//   2. il testo del blocco (già formattato, cifrato) resta in coda finché i blocchi
//      precedenti della stessa riunione non sono pronti: viene aggiunto a
//      rec_meeting.trascrizione sempre nell'ordine giusto;
//   3. il blocco viene CANCELLATO dalla coda appena accodato.
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
import { transcribeAudio, askAiProvider, whisperUrls } from '../routes/ai.js';

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
// TRASCRIZIONE DI UN BLOCCO -> testo formattato
// ----------------------------------------------------------------------------

const ENERGY_WINDOW_SEC = 0.5;

function jobUser(job) {
  return { tenant_id: job.tenant_id, user_id: job.user_id, email: job.user_email };
}

function parseEnergy(raw) {
  try {
    const e = JSON.parse(raw || '{}');
    return {
      mic: Array.isArray(e.mic) && e.mic.length ? e.mic : null,
      system: Array.isArray(e.system) && e.system.length ? e.system : null
    };
  } catch {
    return { mic: null, system: null };
  }
}

// Volume medio di una traccia tra start ed end (secondi), sulle finestre da 0,5 s.
function avgEnergy(list, start, end) {
  const i0 = Math.max(0, Math.floor(start / ENERGY_WINDOW_SEC));
  const i1 = Math.min(list.length - 1, Math.max(i0, Math.ceil(end / ENERGY_WINDOW_SEC) - 1));
  let sum = 0;
  let n = 0;
  for (let i = i0; i <= i1; i++) { sum += Number(list[i]) || 0; n++; }
  return n ? sum / n : 0;
}

// Righe "[hh:mm:ss] Nome: testo" di un blocco, con l'intestazione di sessione se presente.
function formatLines(lines, offset, startLabel) {
  lines.sort((a, b) => a.start - b.start);
  let add = '';
  if (startLabel) add += `\n--- ${String(startLabel).slice(0, 80)} ---\n`;
  for (const l of lines) add += `[${hhmmss((Number(offset) || 0) + l.start)}] ${l.who ? `${l.who}: ` : ''}${l.text.replace(/\s*\n\s*/g, ' ')}\n`;
  return add;
}

// Trascrive un blocco sul servizio Whisper indicato e restituisce il testo formattato.
//  - traccia unica (audio_mix): UNA trascrizione; per ogni frase si confronta il volume del
//    microfono con quello dell'audio di sistema nello stesso intervallo: se prevale il
//    microfono la frase è dell'utente, altrimenti degli altri partecipanti;
//  - formato precedente (audio_mic / audio_system): due trascrizioni, una per traccia.
async function transcribeJob(job, baseUrl) {
  const user = jobUser(job);
  const mime = job.mime || 'audio/wav';
  const lines = [];
  if (job.audio_mix) {
    const energy = parseEnergy(job.energy);
    const me = energy.mic ? await speakerName(user) : '';
    const r = await transcribeAudio(user.user_id, Buffer.from(job.audio_mix, 'base64'), mime, baseUrl);
    for (const seg of r.segments) {
      let who = '';
      if (energy.mic && energy.system) {
        who = avgEnergy(energy.mic, seg.start, seg.end) >= avgEnergy(energy.system, seg.start, seg.end) ? me : OTHERS_LABEL;
      } else if (energy.mic) {
        who = me;
      }
      lines.push({ start: seg.start, who, text: seg.text });
    }
  } else {
    if (job.audio_mic) {
      const me = await speakerName(user);
      const r = await transcribeAudio(user.user_id, Buffer.from(job.audio_mic, 'base64'), mime, baseUrl);
      r.segments.forEach((x) => lines.push({ start: x.start, who: me, text: x.text }));
    }
    if (job.audio_system) {
      const r = await transcribeAudio(user.user_id, Buffer.from(job.audio_system, 'base64'), mime, baseUrl);
      const who = job.audio_mic ? OTHERS_LABEL : '';
      r.segments.forEach((x) => lines.push({ start: x.start, who, text: x.text }));
    }
  }
  return formatLines(lines, job.offset_sec, job.start_label);
}

// Aggiunge (cifrato) il testo di un blocco alla trascrizione della riunione.
// q: client della transazione di flushInOrder (scrittura in ordine, sotto lock).
async function appendTranscript(q, user, idCalendar, add) {
  if (!add) return;
  // Il testo è cifrato: si legge in chiaro (decifratura automatica), si aggiunge e si
  // riscrive tutto cifrato.
  const cur = await q.query(
    `SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1 FOR UPDATE`,
    [user.tenant_id, user.user_id, idCalendar]
  );
  if (cur.rows.length === 0) return; // riunione cancellata nel frattempo
  await q.query(
    `UPDATE rec_meeting SET trascrizione = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
    [encRec((cur.rows[0].trascrizione || '') + add), user.tenant_id, user.user_id, idCalendar]
  );
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

// Blocco audio in coda (cifrato). Restituisce l'id della riga.
//   mixB64 + energy: traccia unica mixata con il volume delle due tracce (formato attuale);
//   micB64 / sysB64: due tracce separate (formato precedente, ancora accettato).
export async function enqueueChunk(user, idCalendar, { mixB64, energy, micB64, sysB64, mime, offset, startLabel }) {
  const r = await db.query(
    `INSERT INTO rec_meeting_chunks
       (tenant_id, user_id, user_email, id_calendar, kind, mime, offset_sec, start_label,
        audio_mix, energy, audio_mic, audio_system)
     VALUES ($1, $2, $3, $4, 'audio', $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    // Cifrati: audio, email e intestazione. In chiaro solo le chiavi tecniche della coda e
    // il volume (numeri, nessun dato personale).
    [user.tenant_id, user.user_id, user.email ? encRec(user.email) : null, idCalendar, mime || 'audio/wav',
      Number(offset) || 0, startLabel ? encRec(String(startLabel).slice(0, 120)) : null,
      mixB64 ? encRec(mixB64) : null, energy ? JSON.stringify(energy) : null,
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
    return r.rows[0].m == null ? -1 : Number(r.rows[0].m) + 30; // + durata di un blocco
  } catch (e) {
    return -1;
  }
}

// Blocco che non si riesce a trascrivere: nella trascrizione resta una nota (niente buchi
// silenziosi), accodata comunque nel punto giusto.
function lostChunkNote(job, reason) {
  return `${job.start_label ? `\n--- ${job.start_label} ---\n` : ''}[${hhmmss(job.offset_sec)}] (blocco audio non trascritto: ${String(reason).slice(0, 150)})\n`;
}

// Trascrive un blocco già "prenotato" (state = 'transcribing') sul servizio indicato.
async function processAudioJob(job, baseUrl) {
  try {
    const text = await transcribeJob(job, baseUrl);
    await db.query(
      `UPDATE rec_meeting_chunks SET state = 'done', result = $2, audio_mix = NULL, audio_mic = NULL, audio_system = NULL WHERE id = $1`,
      [job.id, encRec(text || ' ')]
    );
    console.log(`[TRASCRIZIONE] ✓ ${job.id_calendar} blocco da ${hhmmss(job.offset_sec)} (${baseUrl})`);
  } catch (error) {
    // Servizio irraggiungibile: per un po' non gli si assegnano altri blocchi.
    if (baseUrl && (error.status === 502 || error.status === 503) && !error.upstreamStatus) markUrl(baseUrl, false);
    const attempts = (Number(job.attempts) || 0) + 1;
    if (isTemporary(error) && attempts < MAX_ATTEMPTS) {
      const waitSec = Math.min(60 * attempts, 15 * 60); // 1, 2, 3 ... fino a 15 minuti
      await db.query(
        `UPDATE rec_meeting_chunks
            SET state = 'pending', attempts = $2, last_error = $3, next_try_at = NOW() + ($4 || ' seconds')::interval
          WHERE id = $1`,
        [job.id, attempts, encRec(String(error.message || error).slice(0, 500)), String(waitSec)]
      );
      console.warn(`[TRASCRIZIONE] ${job.id_calendar}: tentativo ${attempts}/${MAX_ATTEMPTS} fallito (${error.message}), nuovo tentativo tra ${waitSec}s`);
      return;
    }
    console.error(`❌ [TRASCRIZIONE] ${job.id_calendar} blocco da ${hhmmss(job.offset_sec)} abbandonato: ${error.message}`);
    await db.query(
      `UPDATE rec_meeting_chunks SET state = 'done', result = $2, audio_mix = NULL, audio_mic = NULL, audio_system = NULL WHERE id = $1`,
      [job.id, encRec(lostChunkNote(job, error.message))]
    );
  }
}

// Recap a fine registrazione. La riga "finalize" è già stata tolta dalla coda (sotto lock):
// in caso di errore temporaneo viene rimessa in coda con un nuovo tentativo.
async function processFinalize(job) {
  const user = jobUser(job);
  try {
    const t = await db.query(
      `SELECT (trascrizione IS NOT NULL AND BTRIM(trascrizione) <> '') AS has_tr FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [user.tenant_id, user.user_id, job.id_calendar]
    );
    if (t.rows[0] && t.rows[0].has_tr) await generateRecap(user, job.id_calendar);
  } catch (error) {
    const attempts = (Number(job.attempts) || 0) + 1;
    if (isTemporary(error) && attempts < 10) {
      await db.query(
        `INSERT INTO rec_meeting_chunks (tenant_id, user_id, user_email, id_calendar, kind, attempts, last_error, next_try_at)
         VALUES ($1, $2, $3, $4, 'finalize', $5, $6, NOW() + interval '2 minutes')`,
        [user.tenant_id, user.user_id, user.email ? encRec(user.email) : null, job.id_calendar, attempts,
          encRec(String(error.message || error).slice(0, 500))]
      );
      console.warn(`[RECAP] ${job.id_calendar}: tentativo ${attempts} fallito (${error.message}), nuovo tentativo tra 2 minuti`);
      return;
    }
    console.error(`❌ [RECAP] ${job.id_calendar} non generato: ${error.message}`);
  }
}

// Accoda IN ORDINE i blocchi pronti: per ogni riunione si guarda il primo della fila; se è
// trascritto il suo testo va nella riunione e la riga si cancella, e si passa al successivo.
// Se in testa c'è la riga "finalize" parte il recap.
// Può esserci più di un server sullo stesso database (es. Render e un server locale): un
// lock di transazione garantisce che uno solo alla volta faccia questo passo.
const FLUSH_LOCK_KEY = 771010;
const finalizing = new Map(); // id riga finalize -> promise
async function flushInOrder() {
  const client = await db.connect();
  const toFinalize = [];
  try {
    await client.query('BEGIN');
    const got = (await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [FLUSH_LOCK_KEY])).rows[0].ok;
    if (!got) { await client.query('ROLLBACK'); return; }
    for (;;) {
      const heads = await client.query(
        `SELECT c.* FROM rec_meeting_chunks c
          WHERE c.seq = (SELECT MIN(c2.seq) FROM rec_meeting_chunks c2
                          WHERE c2.tenant_id = c.tenant_id AND c2.user_id = c.user_id AND c2.id_calendar = c.id_calendar)`
      );
      let progressed = false;
      for (const head of heads.rows) {
        if (head.kind === 'audio' && head.state === 'done') {
          await appendTranscript(client, jobUser(head), head.id_calendar, String(head.result || '').trim() ? head.result : '');
          await client.query('DELETE FROM rec_meeting_chunks WHERE id = $1', [head.id]);
          progressed = true;
        } else if (head.kind === 'finalize' && new Date(head.next_try_at) <= new Date()) {
          await client.query('DELETE FROM rec_meeting_chunks WHERE id = $1', [head.id]);
          toFinalize.push(head);
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  // Il recap (lento: chiama l'AI) parte fuori dalla transazione.
  for (const job of toFinalize) {
    const p = processFinalize(job).finally(() => finalizing.delete(job.id));
    finalizing.set(job.id, p);
  }
}

// Prenota fino a n blocchi da trascrivere (i più vecchi), marcandoli 'transcribing'.
// SKIP LOCKED: con più server sullo stesso database nessun blocco viene preso due volte.
async function claimAudioJobs(n) {
  if (n <= 0) return [];
  const r = await db.query(
    `UPDATE rec_meeting_chunks SET state = 'transcribing', next_try_at = NOW()
      WHERE id IN (SELECT id FROM rec_meeting_chunks
                    WHERE kind = 'audio' AND state = 'pending' AND next_try_at <= NOW()
                    ORDER BY seq LIMIT $1
                    FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [n]
  );
  return r.rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

async function hasPendingJobs() {
  const r = await db.query('SELECT 1 FROM rec_meeting_chunks LIMIT 1');
  return r.rows.length > 0;
}

// ----------------------------------------------------------------------------
// SERVIZI WHISPER: si assegna un blocco solo a un servizio che risponde
// ----------------------------------------------------------------------------
// Un server con un servizio spento (es. un server locale senza Whisper avviato) non deve
// "prendere" blocchi che un altro server potrebbe trascrivere. Il controllo /health ha un
// timeout lungo perché un servizio Render Free addormentato impiega un minuto a svegliarsi.
const urlHealth = new Map(); // url -> { ok, until, checking }

function markUrl(url, ok) {
  urlHealth.set(url, { ok, until: Date.now() + (ok ? 5 * 60 * 1000 : 60 * 1000), checking: false });
}

function urlReady(url) {
  const h = urlHealth.get(url);
  if (h && h.until > Date.now()) return h.ok;
  if (!h || !h.checking) {
    urlHealth.set(url, { ok: false, until: 0, checking: true });
    checkUrlHealth(url).then(({ ok, reason }) => {
      markUrl(url, ok);
      if (ok) console.log(`[TRASCRIZIONE] servizio Whisper pronto: ${url}`);
      else console.warn(`[TRASCRIZIONE] servizio Whisper non raggiungibile: ${url} (${reason})`);
    });
  }
  return false;
}

// Durante il risveglio di un servizio Render Free le prime richieste possono fallire
// subito (connessione chiusa, 502/503) invece di attendere: si riprova per circa 3 minuti,
// finché /health risponde e il modello risulta caricato ("ready": true).
async function checkUrlHealth(url) {
  const deadline = Date.now() + 180000;
  let reason = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(90000) });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ready !== false) return { ok: true };
      reason = r.ok ? 'modello in caricamento' : `HTTP ${r.status}`;
    } catch (error) {
      reason = error.name === 'TimeoutError' ? 'timeout' : (error.cause && (error.cause.code || error.cause.message)) || error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { ok: false, reason };
}

// ----------------------------------------------------------------------------
// ELABORAZIONE IN BACKGROUND + KEEP-ALIVE
// ----------------------------------------------------------------------------

let workerRunning = false;
let keepAliveTimer = null;
const busyUrls = new Set();   // servizi Whisper occupati
const inflight = new Map();   // id blocco -> promise della trascrizione

// Finché la coda lavora, il server chiama il proprio indirizzo pubblico: per Render è
// traffico in ingresso, quindi il servizio Free non si spegne a metà (anche a pagina chiusa).
function startKeepAlive() {
  const base = String(process.env.BACKEND_URL || '').replace(/\/+$/, '');
  if (keepAliveTimer || !/^https:\/\//.test(base)) return;
  keepAliveTimer = setInterval(() => {
    fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
    // Anche i servizi Whisper restano svegli finché la coda lavora.
    for (const url of whisperUrls()) fetch(`${url}/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  }, KEEPALIVE_MS);
}

// Sveglia i servizi Whisper (Render Free si addormenta dopo 15 minuti) all'inizio di una
// registrazione: il risveglio richiede circa un minuto, così sono pronti quando arriva il
// primo blocco. Usa lo stesso controllo della coda (urlReady), quindi non ripete la
// richiesta se un servizio risulta già sveglio o è in corso di verifica. Non tiene accesi
// i servizi in modo permanente: le ore gratuite di Render sono condivise tra tutti.
export function warmWhisperServices() {
  for (const url of whisperUrls()) urlReady(url);
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
  // Blocchi rimasti "in trascrizione" da molto (server riavviato a metà): di nuovo in attesa.
  await db.query(
    `UPDATE rec_meeting_chunks SET state = 'pending'
      WHERE state = 'transcribing' AND next_try_at < NOW() - interval '15 minutes'`
  );
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  startKeepAlive();
  try {
    await cleanupStale();
    for (;;) {
      await flushInOrder();

      const urls = whisperUrls();
      if (urls.length) {
        // Un blocco per ogni servizio Whisper libero e raggiungibile: lavorano in parallelo.
        const free = urls.filter((u) => !busyUrls.has(u) && urlReady(u));
        const jobs = await claimAudioJobs(free.length);
        jobs.forEach((job, i) => {
          const url = free[i];
          busyUrls.add(url);
          const p = processAudioJob(job, url).finally(() => { busyUrls.delete(url); inflight.delete(job.id); });
          inflight.set(job.id, p);
        });
      } else {
        // Nessun servizio configurato: i blocchi vengono chiusi con una nota (non restano in coda).
        const orphan = await claimAudioJobs(50);
        for (const job of orphan) await processAudioJob(job, null);
      }

      if (!inflight.size && !finalizing.size && !(await hasPendingJobs())) break; // coda vuota: fine
      // Si riparte appena finisce una trascrizione o un recap, o dopo qualche secondo (blocchi
      // in attesa di un nuovo tentativo o servizi che si stanno svegliando).
      await Promise.race([
        ...inflight.values(),
        ...finalizing.values(),
        new Promise((r) => setTimeout(r, 5000))
      ]);
    }
  } catch (error) {
    // Tabella non ancora creata o database non raggiungibile: si riproverà al prossimo avvio/blocco.
    if (!/rec_meeting_chunks/.test(error.message || '')) console.error('❌ [TRASCRIZIONE] coda:', error.message);
    await Promise.allSettled([...inflight.values(), ...finalizing.values()]);
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
