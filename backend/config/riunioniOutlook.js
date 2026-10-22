// ============================================================================
// RIUNIONI COMPLETATE DALL'ADD-IN DI OUTLOOK (2026-10-22) - tabella rec_meeting_outlook
// ----------------------------------------------------------------------------
// Con il calendario condiviso (ICS) Projexa vede solo titolo, data, durata e link. Dall'add-in
// («Collega a Projexa» su un appuntamento aperto, routes/outlookAddin.js) arrivano organizzatore,
// partecipanti, cliente e progetto riconosciuti: si salvano qui, agganciati alla riunione per
// data, ora d'inizio e titolo (Outlook non espone l'UID del calendario). Poi si usano:
//  - elenco riunioni della dashboard (arricchisciEventi): partecipanti e organizzatore sugli
//    eventi che non li hanno, quindi destinatari del recap e nomi per la trascrizione;
//  - riga di rec_meeting (completaRiunione): cliente, progetto e destinatari del recap
//    (A = organizzatore e obbligatori, Cc = facoltativi) SOLO dove sono vuoti;
//  - glossario della trascrizione (nomiPartecipanti): i nomi aiutano Whisper e Parakeet.
// Testi cifrati (oggetto, organizzatore, partecipanti); il pool li restituisce in chiaro.
// ============================================================================
import crypto from 'crypto';
import db from './database.js';
import { encryptValue, hasEncryptionKey, isEncrypted } from './crypto.js';

const TOLLERANZA_MINUTI = 10;
const GIORNI_CONSERVAZIONE = 90;

const normTitolo = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const hashTitolo = (t) => crypto.createHash('sha256').update(normTitolo(t)).digest('hex');
const cifra = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return hasEncryptionKey() && !isEncrypted(s) ? encryptValue(s) : s;
};
const minuti = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const json = (s, base) => { try { return s ? JSON.parse(s) : base; } catch { return base; } };

// Data (AAAA-MM-GG) e ora (HH:MM) italiane di un istante ISO.
export function oraItaliana(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    data: d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }),
    ora: d.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false })
  };
}

// Titoli «uguali»: identici normalizzati, oppure uno contiene l'altro (es. prefisso «I:»), oppure
// almeno il 70% delle parole in comune.
function stessoTitolo(a, b) {
  const x = normTitolo(a).replace(/^(r|re|i|fw|fwd|inoltro)\s*:\s*/i, '');
  const y = normTitolo(b).replace(/^(r|re|i|fw|fwd|inoltro)\s*:\s*/i, '');
  if (!x || !y) return false;
  if (x === y || (x.length >= 8 && y.includes(x)) || (y.length >= 8 && x.includes(y))) return true;
  const A = new Set(x.split(/[^a-z0-9àèéìòù]+/).filter((w) => w.length > 2));
  const B = new Set(y.split(/[^a-z0-9àèéìòù]+/).filter((w) => w.length > 2));
  if (!A.size || !B.size) return false;
  let c = 0;
  for (const w of A) if (B.has(w)) c += 1;
  return c / Math.max(A.size, B.size) >= 0.7;
}
const stessaRiunione = (info, ora, oggetto) => Math.abs(minuti(info.ora) - minuti(ora)) <= TOLLERANZA_MINUTI && stessoTitolo(info.oggetto, oggetto);

// Salva (o aggiorna) i dati di un appuntamento. info = { data, ora, fine, oggetto,
// organizzatore: { nome, email }, partecipanti: [{ nome, email, tipo }], clientId, projectId }.
let ultimaPulizia = 0;
export async function salvaInfoOutlook(user, info) {
  if (Date.now() - ultimaPulizia > 6 * 3600 * 1000) {
    ultimaPulizia = Date.now();
    db.query(`DELETE FROM rec_meeting_outlook WHERE data_calendar < CURRENT_DATE - ${GIORNI_CONSERVAZIONE}`).catch(() => {});
  }
  await db.query(
    `INSERT INTO rec_meeting_outlook (tenant_id, user_id, data_calendar, orario_calendar, orario_fine, titolo_hash, oggetto, organizzatore, partecipanti, client_id, project_id)
     VALUES ($1, $2, $3::date, $4::time, $5::time, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, user_id, data_calendar, orario_calendar, titolo_hash) DO UPDATE
       SET orario_fine = EXCLUDED.orario_fine, oggetto = EXCLUDED.oggetto, organizzatore = EXCLUDED.organizzatore,
           partecipanti = EXCLUDED.partecipanti, client_id = EXCLUDED.client_id, project_id = EXCLUDED.project_id, aggiornato_il = now()`,
    [user.tenant_id, user.user_id, info.data, info.ora, info.fine || null, hashTitolo(info.oggetto), cifra(info.oggetto),
      cifra(JSON.stringify(info.organizzatore || {})), cifra(JSON.stringify(info.partecipanti || [])), info.clientId || null, info.projectId || null]
  );
}

// Dati salvati per i giorni indicati: Map data -> [info].
async function infoDeiGiorni(user, giorni) {
  const perGiorno = new Map();
  if (!giorni.length) return perGiorno;
  let r;
  try {
    r = await db.query(
      `SELECT to_char(data_calendar, 'YYYY-MM-DD') AS data, to_char(orario_calendar, 'HH24:MI') AS ora, oggetto, organizzatore, partecipanti,
              client_id::text AS client_id, project_id::text AS project_id
         FROM rec_meeting_outlook WHERE tenant_id = $1 AND user_id = $2 AND data_calendar = ANY($3::date[])`,
      [user.tenant_id, user.user_id, giorni]);
  } catch (e) {
    if (e.code !== '42P01') console.warn('[OUTLOOK] riunioni collegate non lette:', e.message);
    return perGiorno;
  }
  for (const x of r.rows) {
    const info = { data: x.data, ora: x.ora, oggetto: x.oggetto || '', organizzatore: json(x.organizzatore, {}), partecipanti: json(x.partecipanti, []),
      clientId: x.client_id, projectId: x.project_id };
    if (!perGiorno.has(info.data)) perGiorno.set(info.data, []);
    perGiorno.get(info.data).push(info);
  }
  return perGiorno;
}

export async function infoPerRiunione(user, { data, ora, oggetto }) {
  const lista = (await infoDeiGiorni(user, [data])).get(data) || [];
  return lista.find((i) => stessaRiunione(i, ora, oggetto)) || null;
}

// Riga di rec_meeting: cliente, progetto e destinatari del recap SOLO dove sono vuoti (le scelte
// fatte a mano non si toccano). Il progetto si mette solo se è del cliente della riga.
// Restituisce l'elenco dei campi completati.
async function applica(user, riga, info) {
  const campi = [];
  const set = [];
  const valori = [];
  const metti = (colonna, valore, nome) => { valori.push(valore); set.push(`${colonna} = $${valori.length + 3}`); campi.push(nome); };
  const clienteRiga = riga.client_id || null;
  if (!clienteRiga && info.clientId) metti('client_id', info.clientId, 'cliente');
  if (!riga.project_id && info.projectId && (!clienteRiga || clienteRiga === info.clientId)) metti('project_id', info.projectId, 'progetto');
  const io = String(user.email || '').toLowerCase();
  const indirizzi = (l) => [...new Set(l.map((p) => String(p.email || '').toLowerCase()).filter((e) => e && e !== io))].join('; ');
  const a = indirizzi([info.organizzatore || {}, ...info.partecipanti.filter((p) => p.tipo !== 'facoltativo')]);
  const cc = indirizzi(info.partecipanti.filter((p) => p.tipo === 'facoltativo'));
  if (!String(riga.email_a || '').trim() && a) metti('email_a', cifra(a), 'destinatari del recap');
  if (!String(riga.email_cc || '').trim() && cc) metti('email_cc', cifra(cc), 'Cc del recap');
  if (!set.length) return [];
  await db.query(`UPDATE rec_meeting SET ${set.join(', ')} WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
    [user.tenant_id, user.user_id, riga.id_calendar, ...valori]);
  return campi;
}

// Dopo «Collega a Projexa»: riunioni di Projexa (già registrate o caricate) dello stesso giorno,
// ora e titolo. Restituisce [{ idCalendar, oggetto, campi }].
export async function applicaARiunioni(user, info) {
  const r = await db.query(
    `SELECT id_calendar, oggetto, to_char(orario_calendar, 'HH24:MI') AS ora, client_id::text AS client_id, project_id::text AS project_id, email_a, email_cc
       FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND data_calendar = $3::date`,
    [user.tenant_id, user.user_id, info.data]);
  const out = [];
  for (const riga of r.rows.filter((x) => x.ora && stessaRiunione(info, x.ora, x.oggetto))) {
    out.push({ idCalendar: riga.id_calendar, oggetto: riga.oggetto, campi: await applica(user, riga, info) });
  }
  return out;
}

// Quando nasce la riga di una riunione (Registra, caricamento): se l'appuntamento era stato
// collegato da Outlook, si completano subito cliente, progetto e destinatari.
export async function completaRiunione(user, idCalendar) {
  try {
    const riga = (await db.query(
      `SELECT id_calendar, oggetto, to_char(data_calendar, 'YYYY-MM-DD') AS data, to_char(orario_calendar, 'HH24:MI') AS ora,
              client_id::text AS client_id, project_id::text AS project_id, email_a, email_cc
         FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [user.tenant_id, user.user_id, idCalendar])).rows[0];
    if (!riga || !riga.data || !riga.ora) return [];
    const info = await infoPerRiunione(user, { data: riga.data, ora: riga.ora, oggetto: riga.oggetto });
    return info ? await applica(user, riga, info) : [];
  } catch (e) {
    if (e.code !== '42P01') console.warn('[OUTLOOK] riunione non completata:', e.message);
    return [];
  }
}

// Elenco riunioni della dashboard: agli eventi senza partecipanti si aggiungono quelli presi
// da Outlook (e l'organizzatore se manca). Gli eventi restano nel formato del calendario.
export async function arricchisciEventi(user, events) {
  const conOra = events.map((e) => ({ e, t: e && e.start && e.start.dateTime ? oraItaliana(e.start.dateTime) : null })).filter((x) => x.t);
  const perGiorno = await infoDeiGiorni(user, [...new Set(conOra.map((x) => x.t.data))]);
  if (!perGiorno.size) return events;
  for (const { e, t } of conOra) {
    const info = (perGiorno.get(t.data) || []).find((i) => stessaRiunione(i, t.ora, e.summary));
    if (!info) continue;
    if (!Array.isArray(e.attendees) || !e.attendees.filter((a) => a && a.email).length) {
      e.attendees = info.partecipanti.filter((p) => p.email).map((p) => ({ email: p.email, displayName: p.nome || undefined, optional: p.tipo === 'facoltativo' || undefined }));
    }
    if ((!e.organizer || !e.organizer.email) && info.organizzatore && info.organizzatore.email) {
      e.organizer = { email: info.organizzatore.email, displayName: info.organizzatore.nome || '' };
    }
    e.projexaOutlook = { collegato: true, clientId: info.clientId || null, projectId: info.projectId || null };
  }
  return events;
}

// Nomi per il glossario della trascrizione (organizzatore e partecipanti).
export async function nomiPartecipanti(user, { data, ora, oggetto }) {
  try {
    const info = await infoPerRiunione(user, { data, ora, oggetto });
    if (!info) return [];
    return [...new Set([info.organizzatore, ...info.partecipanti].map((p) => String((p && p.nome) || '').trim()).filter((n) => n && !n.includes('@')))];
  } catch { return []; }
}
