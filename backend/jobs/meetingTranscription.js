// ============================================================================
// PROGRAMMA: TRASCRIZIONE E RECAP DELLE RIUNIONI (coda sul server)
// ----------------------------------------------------------------------------
// La dashboard registra la riunione e invia blocchi audio WAV di ~30 s: microfono
// dell'utente e audio di sistema MIXATI in una sola traccia (audio_mix), più il volume
// delle due tracce per finestre di 0,5 s (energy), che serve a capire chi parla. I blocchi
// muti non vengono inviati. Ogni blocco viene SALVATO SUBITO nella tabella
// rec_meeting_chunks (audio cifrato) e il server lo elabora in background:
//   1. trascrizione con Whisper: più servizi (WHISPER_URLS) lavorano IN PARALLELO, un
//      blocco ciascuno; chi ha "modalità Trascrizione" = Background-Veloce usa whisper.cpp
//      (WHISPER_CPP_URL);
//   2. il testo del blocco (già formattato, cifrato) resta in coda finché i blocchi
//      precedenti della stessa riunione non sono pronti: viene aggiunto a
//      rec_meeting.trascrizione sempre nell'ordine giusto;
//   3. il blocco viene CANCELLATO dalla coda appena accodato.
// Quando arriva il segnale di fine registrazione (riga "finalize") e i blocchi di quella
// riunione sono finiti, il server genera da solo il recap (rec_meeting.recap).
//
// Così la pagina si può chiudere dopo "Ferma": la coda sta nel database e riparte anche
// dopo un riavvio del server.
//
// Tabella: Supporto/CreaDB/rec_meeting_chunks.sql
// ============================================================================
import db from '../config/database.js';
import { getPromptFor } from '../config/prompts.js';
import { encryptValue, isEncrypted, hasEncryptionKey } from '../config/crypto.js';
import { transcribeAudio, askAiProvider, whisperUrls, whisperCppUrls, localRecapMode, askOllamaRecap } from '../routes/ai.js';

export const NOME_PROGRAMMA = 'meetingTranscription';

const OTHERS_LABEL = 'Partecipanti';
const MAX_ATTEMPTS = 30;              // ~ alcune ore di tentativi con attese crescenti
const STALE_HOURS = 48;               // blocchi più vecchi: scartati (non si conserva audio)
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

// Unione dei segmenti di Whisper in frasi leggibili: Whisper (soprattutto whisper.cpp)
// restituisce pezzi di 2-3 parole e a volte spezza una parola a metà ("cedol" + "ini").
// Si uniscono i pezzi consecutivi della STESSA persona finché la frase non è finita
// (. ? ! …) e abbastanza lunga; si va a capo anche dopo una pausa lunga o oltre una
// lunghezza massima. Un pezzo che continua una parola (cont) si incolla sempre, senza spazio.
const LINE_MIN_CHARS = 60;    // sotto questa lunghezza si continua anche dopo il punto
const LINE_MAX_CHARS = 320;   // oltre si va comunque a capo
const LINE_MAX_GAP_SEC = 3;   // pausa oltre la quale inizia una nuova riga

function mergeLines(lines) {
  const out = [];
  for (const l of lines) {
    const text = String(l.text || '').replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    const start = Number(l.start) || 0;
    const end = Math.max(start, Number(l.end) || 0);
    const last = out[out.length - 1];
    if (last) {
      const sentenceDone = /[.?!…]["'»”)]?$/.test(last.text) && last.text.length >= LINE_MIN_CHARS;
      const join = l.cont || (last.who === l.who
        && !sentenceDone
        && start - last.end <= LINE_MAX_GAP_SEC
        && last.text.length + text.length < LINE_MAX_CHARS);
      if (join) {
        const glue = l.cont || /^[.,;:!?…)»”]/.test(text) ? '' : ' ';
        last.text += glue + text;
        last.end = Math.max(last.end, end);
        continue;
      }
    }
    out.push({ start, end, who: l.who || '', text });
  }
  return out;
}

// Righe "[hh:mm:ss] Nome: testo" di un blocco, con l'intestazione di sessione se presente.
function formatLines(lines, offset, startLabel) {
  lines.sort((a, b) => a.start - b.start);
  let add = '';
  if (startLabel) add += `\n--- ${String(startLabel).slice(0, 80)} ---\n`;
  for (const l of mergeLines(lines)) add += `[${hhmmss((Number(offset) || 0) + l.start)}] ${l.who ? `${l.who}: ` : ''}${l.text}\n`;
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
      lines.push({ start: seg.start, end: seg.end, who, text: seg.text, cont: seg.cont });
    }
  } else {
    if (job.audio_mic) {
      const me = await speakerName(user);
      const r = await transcribeAudio(user.user_id, Buffer.from(job.audio_mic, 'base64'), mime, baseUrl);
      r.segments.forEach((x) => lines.push({ start: x.start, end: x.end, who: me, text: x.text, cont: x.cont }));
    }
    if (job.audio_system) {
      const r = await transcribeAudio(user.user_id, Buffer.from(job.audio_system, 'base64'), mime, baseUrl);
      const who = job.audio_mic ? OTHERS_LABEL : '';
      r.segments.forEach((x) => lines.push({ start: x.start, end: x.end, who, text: x.text, cont: x.cont }));
    }
  }
  return formatLines(lines, job.offset_sec, job.start_label);
}

// ----------------------------------------------------------------------------
// CORREZIONI AUTOMATICHE (tabella rec_correzioni, Supporto/CreaDB/rec_correzioni.sql)
// ----------------------------------------------------------------------------
//
// Righe "errato" (varianti separate da |) -> "corretto" dell'utente: quelle senza cliente
// valgono per tutte le riunioni, quelle con client_id solo per le riunioni di quel cliente.
// Si sostituiscono parole intere, senza distinguere maiuscole/minuscole.

// Una riga -> { re, corretto } (null se incompleta).
export function correctionRule(errato, corretto) {
  const target = String(corretto || '').trim();
  // varianti più lunghe prima: "le ruame tabrico" prima di "le ruame"
  const variants = String(errato || '').split('|').map((v) => v.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!target || !variants.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // parola intera: niente lettere/cifre subito prima o subito dopo (vale anche per le
  // lettere accentate, a differenza di \b)
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${variants.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return { re, corretto: target };
}

// Regole valide per la riunione: [{ re, corretto }]. Se la tabella non c'è (es. staging
// non aggiornato) o la query fallisce, nessuna correzione: la trascrizione non si blocca.
export async function loadCorrections(user, idCalendar) {
  try {
    const r = await db.query(
      `SELECT c.errato, c.corretto
         FROM rec_correzioni c
        WHERE c.tenant_id = $1 AND c.user_id = $2
          AND (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE)
          AND (c.client_id IS NULL OR c.client_id = (
                SELECT m.client_id FROM rec_meeting m
                 WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.id_calendar = $3 LIMIT 1))`,
      [user.tenant_id, user.user_id, idCalendar]
    );
    return r.rows.map((row) => correctionRule(row.errato, row.corretto)).filter(Boolean);
  } catch (e) {
    if (!/rec_correzioni/.test(e.message || '')) console.warn('⚠️ REC_CORREZIONI:', e.message);
    return [];
  }
}

// Recap da incollare in un'email: via la formattazione Markdown che i modelli aggiungono anche
// quando il prompt la vieta. **grassetto** / __grassetto__ -> testo, "### Titolo" -> "Titolo",
// elenchi "* " o "• " -> "- " (il formato richiesto dal prompt), asterischi doppi rimasti soli
// eliminati. Il testo non cambia in nessun altro modo.
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^([ \t]*)[*•][ \t]+/gm, '$1- ')
    .replace(/\*\*/g, '');
}

// Come applyCorrections, ma su un recap formattato (HTML): si correggono solo i pezzi di
// testo tra un tag e l'altro, mai i nomi dei tag o gli attributi (stili, colori...).
export function applyCorrectionsHtml(html, rules) {
  let count = 0;
  const out = String(html || '').split(/(<[^>]*>)/).map((part) => {
    if (!part || part.startsWith('<')) return part;
    const r = applyCorrections(part, rules);
    count += r.count;
    return r.text;
  }).join('');
  return { html: out, count };
}

// Applica le regole al testo. Restituisce { text, count } (count = sostituzioni fatte).
export function applyCorrections(text, rules) {
  let out = String(text || '');
  let count = 0;
  for (const { re, corretto } of rules) {
    out = out.replace(re, (m) => {
      if (m === corretto) return m;
      count++;
      return corretto;
    });
  }
  return { text: out, count };
}

// Aggiunge (cifrato) il testo di un blocco alla trascrizione della riunione.
// q: client della transazione di flushInOrder (scrittura in ordine, sotto lock).
// Prima di salvarlo si applicano le correzioni automatiche (rec_correzioni).
async function appendTranscript(q, user, idCalendar, add) {
  if (!add) return;
  // Lette dal pool, NON con q: un errore dentro la transazione la renderebbe inutilizzabile.
  add = applyCorrections(add, await loadCorrections(user, idCalendar)).text;
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
// (settings.valore2 per tenant/utente). Il prompt è la funzione RECAP_EMAIL della tabella
// app_prompts (modificabile dall'admin di Projexa in prompt-editor.html): quello
// personalizzato per tenant + utente se esiste, altrimenti lo standard; si rilegge a ogni
// recap, senza riavvii.
// Segnaposto: {{TRASCRIZIONE}}, {{OGGETTO}}, {{DATA}}, {{UTENTE}}. Il recap sostituisce
// quello eventualmente già presente.
async function buildRecapPrompt(user, vars) {
  let tpl = (await getPromptFor('RECAP_EMAIL', user)).testo;
  // Se il file non prevede il segnaposto, la trascrizione si aggiunge in fondo.
  if (!tpl.includes('{{TRASCRIZIONE}}')) tpl += '\n\nTrascrizione:\n{{TRASCRIZIONE}}';
  return tpl.replace(/\{\{(TRASCRIZIONE|OGGETTO|DATA|UTENTE)\}\}/g, (m, k) => vars[k] || '');
}

// AI scelta nel campo "AI generazione e-mail recap" (settings.valore2), '' se non scelta.
export async function recapProviderName(user) {
  const setting = (await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND LOWER(BTRIM(campo)) IN ('ai generazione e-mail recap', '(*) ai generazione e-mail recap')
      LIMIT 1`,
    [user.tenant_id, user.user_id]
  )).rows[0];
  return setting && setting.valore2 ? String(setting.valore2).trim() : '';
}

async function recapSource(user, idCalendar) {
  const row = (await db.query(
    `SELECT trascrizione, oggetto, data_calendar, orario_calendar FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, idCalendar]
  )).rows[0];
  if (!row) throw httpError(404, 'Riunione non gestita con Projexa');
  if (!row.trascrizione || !row.trascrizione.trim()) throw httpError(400, 'Nessuna trascrizione da cui generare il recap');
  const data = row.data_calendar ? String(row.data_calendar).split('-').reverse().join('/') : '';
  // Correzioni automatiche anche sul testo passato all'AI: una correzione aggiunta dopo la
  // trascrizione vale subito per il recap, senza dover prima correggere la trascrizione.
  const rules = await loadCorrections(user, idCalendar);
  return {
    rules,
    transcript: applyCorrections(row.trascrizione.trim(), rules).text,
    vars: {
      OGGETTO: row.oggetto || '',
      DATA: [data, row.orario_calendar ? String(row.orario_calendar).slice(0, 5) : ''].filter(Boolean).join(' '),
      UTENTE: await speakerName(user)
    }
  };
}

// Recap sul server in corso (Recap Projexa lento: può durare molti minuti): la dashboard mostra
// la clessidra invece del pulsante "Recap".
const recapRunning = new Set(); // "tenant|utente|id_calendar"
const recapKey = (user, idCalendar) => `${user.tenant_id}|${user.user_id}|${idCalendar}`;

export async function recapInProgress(user, ids) {
  const out = new Set(ids.filter((id) => recapRunning.has(recapKey(user, id))));
  try {
    const r = await db.query(
      `SELECT DISTINCT id_calendar FROM rec_meeting_chunks
        WHERE tenant_id = $1 AND user_id = $2 AND kind = 'finalize' AND id_calendar = ANY($3::text[])`,
      [user.tenant_id, user.user_id, ids]
    );
    for (const x of r.rows) out.add(x.id_calendar);
  } catch (e) { /* tabella della coda non ancora creata */ }
  return out;
}

// user: { tenant_id, user_id, email }. Restituisce { provider, model, length }.
export async function generateRecap(user, idCalendar) {
  const providerName = await recapProviderName(user);
  if (!providerName) throw httpError(400, 'Scegli l\'AI in Impostazioni › AI › "AI generazione e-mail recap"');
  const local = localRecapMode(providerName);
  const { transcript, vars, rules } = await recapSource(user, idCalendar);

  let result;
  const key = recapKey(user, idCalendar);
  recapRunning.add(key);
  try {
    result = local === 'server'
      ? await askOllamaRecap((text) => buildRecapPrompt(user, { ...vars, TRASCRIZIONE: text }), transcript)
      : await askAiProvider(user.user_id, providerName, await buildRecapPrompt(user, { ...vars, TRASCRIZIONE: transcript }));
  } finally {
    recapRunning.delete(key);
  }
  // e sul recap prodotto (l'AI può riscrivere a modo suo un nome già corretto)
  const recap = stripMarkdown(applyCorrections(String(result.text || '').trim(), rules).text).trim();
  if (!recap) throw httpError(502, `${result.label} non ha restituito alcun testo`);

  await db.query(
    // recap_html = NULL: un recap rigenerato sostituisce anche la versione modificata a mano.
    `UPDATE rec_meeting SET recap = $1, recap_html = NULL, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
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
// Può esserci più di un server sullo stesso database (es. la VM e un server locale): un
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
// owners (facoltativo): { keys: ['tenant|utente', ...], include: true|false } limita i blocchi
// a quelli di questi utenti (include) o a tutti gli altri (!include). Serve a separare i
// blocchi "Background-Veloce" (whisper.cpp) da quelli standard.
async function claimAudioJobs(n, owners = null) {
  if (n <= 0) return [];
  const params = [n];
  let filter = '';
  if (owners && (owners.include || owners.keys.length)) {
    params.push(owners.keys);
    filter = `AND ${owners.include ? '' : 'NOT '}((tenant_id::text || '|' || user_id::text) = ANY($2::text[]))`;
  }
  const r = await db.query(
    `UPDATE rec_meeting_chunks SET state = 'transcribing', next_try_at = NOW()
      WHERE id IN (SELECT id FROM rec_meeting_chunks
                    WHERE kind = 'audio' AND state = 'pending' AND next_try_at <= NOW() ${filter}
                    ORDER BY seq LIMIT $1
                    FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    params
  );
  return r.rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

// Utenti con blocchi in attesa che hanno scelto "modalità Trascrizione" = Background-Veloce
// (whisper.cpp). Il confronto si fa qui e non in SQL perché valore2 può essere cifrato
// (la decifratura avviene in lettura). Restituisce le chiavi 'tenant|utente'.
async function fastOwnerKeys() {
  const r = await db.query(
    `SELECT DISTINCT c.tenant_id::text AS t, c.user_id::text AS u, s.valore2
       FROM rec_meeting_chunks c
       JOIN settings s ON s.tenant_id = c.tenant_id AND s.user_id = c.user_id
                      AND LOWER(BTRIM(s.campo)) LIKE '%modalit%trascrizione%'
      WHERE c.kind = 'audio' AND c.state = 'pending'`
  );
  return [...new Set(r.rows
    .filter((x) => String(x.valore2 || '').trim().toLowerCase() === 'background-veloce')
    .map((x) => `${x.t}|${x.u}`))];
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
// timeout lungo perché dopo un riavvio il servizio impiega un po' a caricare il modello.
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

// Mentre un servizio si avvia le prime richieste possono fallire subito (connessione
// chiusa, 502/503) invece di attendere: si riprova per circa 3 minuti,
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
// ELABORAZIONE IN BACKGROUND
// ----------------------------------------------------------------------------

let workerRunning = false;
const busyUrls = new Set();   // servizi Whisper occupati
const inflight = new Map();   // id blocco -> promise della trascrizione

// All'inizio di una registrazione verifica i servizi Whisper, così risultano pronti quando
// arriva il primo blocco. Usa lo stesso controllo della coda (urlReady), quindi non ripete
// la richiesta se un servizio risulta già pronto o è in corso di verifica.
export function warmWhisperServices() {
  for (const url of [...whisperUrls(), ...whisperCppUrls()]) urlReady(url);
}

// Rete di sicurezza: blocchi rimasti 'transcribing' orfani (processo riavviato/morto a
// metà) rimessi in attesa, così vengono ritrascritti in fretta invece di restare appesi.
// Sicuro: NON tocca i blocchi in carico a QUESTO worker (inflight), né quelli fermi da meno
// di 5 minuti — sopra il tempo massimo di una trascrizione reale, così non disturba un job
// lento o in corso su un altro server. Viene chiamata all'avvio e a ogni giro del worker.
async function reclaimStuck() {
  const ids = [...inflight.keys()];
  const r = await db.query(
    `UPDATE rec_meeting_chunks SET state = 'pending'
      WHERE state = 'transcribing' AND next_try_at < NOW() - interval '5 minutes'
        AND NOT (id = ANY($1::uuid[]))`,
    [ids]
  );
  if (r.rowCount) console.warn(`[TRASCRIZIONE] recuperati ${r.rowCount} blocchi rimasti appesi (rimessi in coda)`);
}

async function cleanupStale() {
  const r = await db.query(
    `DELETE FROM rec_meeting_chunks WHERE created_at < NOW() - ($1 || ' hours')::interval`,
    [String(STALE_HOURS)]
  );
  if (r.rowCount) console.warn(`[TRASCRIZIONE] scartati ${r.rowCount} blocchi più vecchi di ${STALE_HOURS} ore`);
  await reclaimStuck();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await cleanupStale();
    for (;;) {
      await reclaimStuck(); // recupera blocchi appesi anche mentre il worker è già in esecuzione
      await flushInOrder();

      const urls = whisperUrls();
      const cppUrls = whisperCppUrls();
      if (urls.length || cppUrls.length) {
        const start = (jobs, free) => jobs.forEach((job, i) => {
          const url = free[i];
          busyUrls.add(url);
          const p = processAudioJob(job, url).finally(() => { busyUrls.delete(url); inflight.delete(job.id); });
          inflight.set(job.id, p);
        });
        // Background-Veloce: i blocchi di chi l'ha scelto vanno a whisper.cpp. Se whisper.cpp
        // non è configurato o non risponde, vanno ai servizi standard (nessun blocco resta fermo).
        const cppOn = cppUrls.some((u) => busyUrls.has(u) || urlReady(u));
        const fastKeys = cppOn ? await fastOwnerKeys() : [];
        if (fastKeys.length) {
          const freeCpp = cppUrls.filter((u) => !busyUrls.has(u) && urlReady(u));
          start(await claimAudioJobs(freeCpp.length, { keys: fastKeys, include: true }), freeCpp);
        }
        // Un blocco per ogni servizio Whisper libero e raggiungibile: lavorano in parallelo.
        const free = urls.filter((u) => !busyUrls.has(u) && urlReady(u));
        start(await claimAudioJobs(free.length, { keys: fastKeys, include: false }), free);
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
  }
}

// Avvia l'elaborazione (se non è già in corso). Chiamata a ogni nuovo blocco e all'avvio
// del server, per riprendere i blocchi rimasti in coda.
export function kickTranscriptionWorker() {
  runWorker().catch(() => {});
}
