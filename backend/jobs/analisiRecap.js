// ============================================================================
// ANALISI RECAP NOTTURNA - l'«insegnante» di recap-projexa (2026-10-20, analisi_recap.sql)
// ----------------------------------------------------------------------------
// Le riunioni segnate con «Analisi Recap» (rec_meeting.analisi_recap, pulsante nella finestra
// della trascrizione) vengono rifatte di notte da un'AI grande (Gemini gratuito o ChatGPT Batch,
// la stessa scelta della pagina Analisi PM) ESATTAMENTE con i compiti che Projexa dà al modello
// locale recap-projexa (routes/ai.js, askRecapProjexa):
//   1. appunti di ogni pezzo di trascrizione (stesso testo del compito, RECAP_CHUNK_PROMPT);
//   2. recap per il cliente dagli appunti (prompt RECAP_EMAIL dell'utente);
//   3. recap interno per il team dagli appunti (prompt RECAP_INTERNO, se attivo).
// Ogni risposta va in recap_analisi con il compito ricevuto (ingresso): la mattina si valuta
// nella pagina Analisi PM › Recap (corretta/errata, testo correggibile) e le corrette diventano
// il file di addestramento di recap-projexa (Colab, poi installazione sulla VM).
//   - Gemini: richieste immediate, al massimo RICHIESTE_GIRO per giro (piano gratuito);
//   - ChatGPT: solo Batch (metà prezzo), una richiesta per fase, raccolta ai giri successivi.
// Finita l'analisi il segno sulla riunione si toglie.
// ============================================================================
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { askAiProvider, inviaBatchAi, statoBatchAi, istruzioniRecapProjexa, pezziRecapRiunione, testoDagliAppunti } from '../routes/ai.js';
import { recapSource, buildRecapPrompt } from './meetingTranscription.js';
import { aiScelta } from './analisiPm.js';

const RICHIESTE_GIRO = 8;   // Gemini: richieste per giro (ogni 30 minuti)
const MAX_TENTATIVI = 6;    // giri falliti di fila prima di segnare l'errore
export const TIPI = ['appunti', 'recap', 'interno'];

// Compito per l'AI insegnante: le stesse istruzioni fisse del modello locale + il compito.
const conIstruzioni = (sistema, compito) => (sistema ? `${sistema}\n\n=== COMPITO ===\n${compito}` : compito);

async function salva(r, ai, tipo, pezzo, ingresso, risposta) {
  const { data } = await encryptRowForWrite(db, 'recap_analisi', { ingresso, risposta: String(risposta || '').trim() });
  await db.query(
    `INSERT INTO recap_analisi (tenant_id, user_id, id_calendar, tipo, pezzo, ai, ingresso, risposta, crypto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, user_id, id_calendar, tipo, pezzo) DO UPDATE
       SET ai = EXCLUDED.ai, ingresso = EXCLUDED.ingresso, risposta = EXCLUDED.risposta, crypto = EXCLUDED.crypto,
           testo_corretto = NULL, updated_at = now()
     WHERE recap_analisi.esito IS NULL`,
    [r.tenant_id, r.user_id, r.id_calendar, tipo, pezzo, ai, data.ingresso, data.risposta, data.crypto ?? 0]);
}

// Dati della riunione: pezzi (compiti «appunti») e costruttori dei prompt di recap e recap interno.
async function prepara(r) {
  const user = { tenant_id: r.tenant_id, user_id: r.user_id };
  const { transcript, vars } = await recapSource(user, r.id_calendar);
  const p = pezziRecapRiunione(transcript, vars.OGGETTO);
  let interno = null;
  try {
    const { prepara: preparaInterno } = await import('../routes/recapInterno.js');
    interno = (await preparaInterno(user, r.id_calendar)).build;
  } catch (e) {
    console.warn(`[ANALISI RECAP] ${r.id_calendar}: recap interno saltato (${e.message})`);
  }
  return {
    user, ...p, sistema: await istruzioniRecapProjexa(),
    recap: (testo) => buildRecapPrompt(user, { ...vars, TRASCRIZIONE: testo }),
    interno
  };
}

// Testo messo al posto della trascrizione nei recap: trascrizione (riunione breve) oppure gli
// appunti già scritti dall'insegnante (testo corretto se c'è).
async function testoPerRecap(r, p) {
  if (p.unico) return p.plain;
  const a = (await db.query(
    `SELECT pezzo, coalesce(testo_corretto, risposta) AS t FROM recap_analisi
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND tipo = 'appunti' AND pezzo < $4 ORDER BY pezzo`,
    [r.tenant_id, r.user_id, r.id_calendar, p.messaggi.length])).rows;
  if (a.length < p.messaggi.length) throw new Error('appunti incompleti: la trascrizione è cambiata durante l\'analisi');
  return testoDagliAppunti(a.map((x) => x.t));
}

async function avanza(r, campi) {
  const set = Object.keys(campi).map((k, i) => `${k} = $${i + 4}`).join(', ');
  await db.query(`UPDATE recap_analisi_riunioni SET ${set}, updated_at = now() WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
    [r.tenant_id, r.user_id, r.id_calendar, ...Object.values(campi)]);
  Object.assign(r, campi);
}

async function chiudiRiunione(r, stato, errore = null) {
  await db.query(
    `UPDATE recap_analisi_riunioni SET stato = $4, errore = $5, batch_id = NULL, updated_at = now(),
            completata_il = CASE WHEN $4 = 'fatta' THEN now() ELSE completata_il END
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
    [r.tenant_id, r.user_id, r.id_calendar, stato, errore]);
  await db.query('UPDATE rec_meeting SET analisi_recap = false WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
    [r.tenant_id, r.user_id, r.id_calendar]);
}

async function errore(r, e, report) {
  const tentativi = (Number(r.tentativi) || 0) + 1;
  const msg = String((e && e.message) || e).slice(0, 500);
  report.errori.push(`${r.id_calendar}: ${msg}`);
  if (tentativi >= MAX_TENTATIVI) { await chiudiRiunione(r, 'errore', msg); return; }
  await db.query('UPDATE recap_analisi_riunioni SET tentativi = $4, errore = $5, updated_at = now() WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
    [r.tenant_id, r.user_id, r.id_calendar, tentativi, msg]);
}

// Fase successiva a quella data (appunti -> recap -> interno -> fine).
const dopo = (fase, p) => (fase === 'appunti' ? 'recap' : fase === 'recap' && p.interno ? 'interno' : null);

// --- Gemini: un passo alla volta, richieste immediate ---------------------------------------
async function passoGemini(r, p) {
  if (r.fase === 'appunti') {
    const i = Number(r.prossimo) || 0;
    if (i >= p.messaggi.length) { await avanza(r, { fase: 'recap', prossimo: 0 }); return false; }
    const x = await askAiProvider(r.user_id, 'Gemini', conIstruzioni(p.sistema, p.messaggi[i]));
    await salva(r, 'Gemini', 'appunti', i, p.messaggi[i], x.text);
    await avanza(r, { prossimo: i + 1, pezzi_tot: p.messaggi.length, tentativi: 0, errore: null });
    return true;
  }
  const testo = await testoPerRecap(r, p);
  const ingresso = r.fase === 'recap' ? await p.recap(testo) : p.interno(testo);
  const x = await askAiProvider(r.user_id, 'Gemini', conIstruzioni(p.sistema, ingresso));
  await salva(r, 'Gemini', r.fase, 0, ingresso, x.text);
  const prossima = dopo(r.fase, p);
  if (prossima) await avanza(r, { fase: prossima, prossimo: 0, tentativi: 0, errore: null });
  else { await chiudiRiunione(r, 'fatta'); return 'fine'; }
  return true;
}

// --- ChatGPT: una richiesta Batch per fase (gli appunti di tutti i pezzi in una) ------------
function promptAppuntiBatch(p) {
  return `${p.sistema}

=== COMPITO DI QUESTA RICHIESTA ===
Qui sotto ci sono ${p.messaggi.length} compiti, uno per ogni pezzo della stessa riunione. Esegui ognuno
SEPARATAMENTE, usando solo il testo di quel pezzo (non mescolare informazioni tra pezzi).
Rispondi SOLO con JSON: {"pezzi":[{"i":1,"appunti":"..."}, ...]}, un elemento per ogni pezzo, con gli
appunti in testo semplice (righe separate da \\n) come chiede il compito.

${p.messaggi.map((m, i) => `##### COMPITO ${i + 1} #####\n${m}`).join('\n\n')}`;
}

function leggiAppunti(testo, n) {
  let j = null;
  const t = String(testo || '');
  try { j = JSON.parse(t); } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) try { j = JSON.parse(m[0]); } catch { /* non JSON */ }
  }
  const lista = j && Array.isArray(j.pezzi) ? j.pezzi : null;
  if (!lista) throw new Error('risposta dell\'AI non leggibile (JSON non valido)');
  const out = new Map();
  for (const x of lista) {
    const i = Number(x && x.i) - 1;
    if (Number.isInteger(i) && i >= 0 && i < n && String(x.appunti || '').trim()) out.set(i, String(x.appunti).trim());
  }
  return out;
}

async function passoChatGpt(r, p) {
  if (r.stato === 'in_corso') {
    // Invio della fase corrente.
    let prompt;
    let opzioni = {};
    if (r.fase === 'appunti') { prompt = promptAppuntiBatch(p); opzioni = { json: true }; }
    else {
      const testo = await testoPerRecap(r, p);
      const ingresso = r.fase === 'recap' ? await p.recap(testo) : p.interno(testo);
      prompt = conIstruzioni(p.sistema, ingresso);
    }
    const b = await inviaBatchAi(r.user_id, 'ChatGPT', prompt, opzioni);
    await avanza(r, { stato: 'batch', batch_id: b.batchId, pezzi_tot: p.messaggi.length, tentativi: 0, errore: null });
    return 'inviato';
  }
  const s = await statoBatchAi(r.user_id, 'ChatGPT', r.batch_id);
  if (s.stato === 'in_corso') return null;
  if (s.stato !== 'pronto') throw new Error(s.errore || 'Batch non riuscito');
  if (r.fase === 'appunti') {
    const appunti = leggiAppunti(s.text, p.messaggi.length);
    for (let i = 0; i < p.messaggi.length; i++) {
      if (appunti.has(i)) await salva(r, 'ChatGPT', 'appunti', i, p.messaggi[i], appunti.get(i));
    }
    if (appunti.size < p.messaggi.length) throw new Error(`appunti mancanti per ${p.messaggi.length - appunti.size} pezzi`);
  } else {
    const testo = await testoPerRecap(r, p);
    const ingresso = r.fase === 'recap' ? await p.recap(testo) : p.interno(testo);
    await salva(r, 'ChatGPT', r.fase, 0, ingresso, s.text);
  }
  const prossima = dopo(r.fase, p);
  if (!prossima) { await chiudiRiunione(r, 'fatta'); return 'fine'; }
  await avanza(r, { stato: 'in_corso', fase: prossima, batch_id: null, prossimo: 0 });
  return 'raccolto';
}

export async function eseguiAnalisiRecap() {
  const report = { nuove: 0, gemini: 0, batchInviati: 0, batchRaccolti: 0, completate: 0, errori: [] };

  // 1. Riunioni segnate: una riga di avanzamento (nuova, o ripartita da capo se già analizzata).
  const segnate = (await db.query(
    `SELECT m.tenant_id, m.user_id, m.id_calendar FROM rec_meeting m
      WHERE m.analisi_recap AND m.trascrizione IS NOT NULL AND btrim(m.trascrizione) <> ''
        AND NOT EXISTS (SELECT 1 FROM recap_analisi_riunioni a WHERE a.tenant_id = m.tenant_id AND a.user_id = m.user_id
                         AND a.id_calendar = m.id_calendar AND a.stato IN ('in_corso', 'batch'))`)).rows;
  for (const m of segnate) {
    await db.query(
      `INSERT INTO recap_analisi_riunioni (tenant_id, user_id, id_calendar, ai, stato, fase, prossimo, tentativi)
       VALUES ($1, $2, $3, $4, 'in_corso', NULL, 0, 0)
       ON CONFLICT (tenant_id, user_id, id_calendar) DO UPDATE
         SET ai = EXCLUDED.ai, stato = 'in_corso', fase = NULL, prossimo = 0, tentativi = 0, errore = NULL, batch_id = NULL,
             completata_il = NULL, updated_at = now()`,
      [m.tenant_id, m.user_id, m.id_calendar, await aiScelta(m)]);
    report.nuove++;
  }

  const aperte = (await db.query(`SELECT * FROM recap_analisi_riunioni WHERE stato IN ('in_corso', 'batch') ORDER BY created_at`)).rows;
  let richieste = 0;
  for (const r of aperte) {
    if (r.ai === 'Gemini' && richieste >= RICHIESTE_GIRO) continue;
    try {
      const p = await prepara(r);
      if (!r.fase) await avanza(r, { fase: p.unico ? 'recap' : 'appunti', prossimo: 0 });
      // Recap interno non più disponibile (tabelle tolte) a metà analisi: si chiude con quel che c'è.
      if (r.fase === 'interno' && !p.interno) { await chiudiRiunione(r, 'fatta'); report.completate++; continue; }
      if (r.ai === 'ChatGPT') {
        const esito = await passoChatGpt(r, p);
        if (esito === 'inviato') report.batchInviati++;
        if (esito === 'raccolto' || esito === 'fine') report.batchRaccolti++;
        if (esito === 'fine') report.completate++;
        continue;
      }
      // Gemini: passi finché ci sono richieste disponibili in questo giro.
      while (richieste < RICHIESTE_GIRO) {
        const esito = await passoGemini(r, p);
        if (esito) { richieste++; report.gemini++; }
        if (esito === 'fine') { report.completate++; break; }
      }
    } catch (e) {
      await errore(r, e, report);
    }
  }

  const riepilogo = `nuove ${report.nuove}, richieste Gemini ${report.gemini}, Batch inviati ${report.batchInviati}, raccolti ${report.batchRaccolti}, completate ${report.completate}${report.errori.length ? `, errori ${report.errori.length}` : ''}`;
  return { ok: !report.errori.length, riepilogo, ...report };
}
