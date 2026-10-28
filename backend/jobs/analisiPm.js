// ============================================================================
// ANALISI PM NOTTURNA (2026-10-20, Supporto/CreaDB/analisi_pm.sql)
// ----------------------------------------------------------------------------
// Le riunioni segnate con «Analisi PM» (rec_meeting.analisi_pm, pulsante nella finestra della
// trascrizione) vengono analizzate di notte dal job analisi_pm (ogni 30 minuti, 00:00-06:30):
// per ogni pezzo della riunione (~1 minuto di parlato, come i tratti di Pm projexa in call)
// l'AI dice quale domanda da PM senior si poteva fare, e se l'utente l'ha poi fatta davvero
// (le sue righe «Nome Cognome: …» sono riconoscibili) o se è mancata.
//   - Gemini (piano gratuito): UN gruppo di pezzi per giro, così non si consumano i limiti;
//   - ChatGPT: solo Batch (metà prezzo), tutta la riunione in una richiesta, raccolta ai giri dopo.
// AI scelta nella pagina Analisi PM (pm_analisi_config). Le domande vanno in pm_analisi (cifrate)
// e la mattina si valutano nella pagina (sito/analisi-pm.html, routes/analisiPm.js). Finita
// l'analisi il segno sulla riunione si toglie.
// ============================================================================
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { getPromptFor } from '../config/prompts.js';
import { askAiProvider, inviaBatchAi, statoBatchAi } from '../routes/ai.js';
import { speakerName } from './meetingTranscription.js';

export const PEZZO_CHARS = 900;       // un pezzo ≈ un tratto valutato da Pm projexa durante la call
const GRUPPO_PEZZI = 40;              // Gemini: pezzi per chiamata (~36.000 caratteri)
const MAX_TENTATIVI = 6;              // giri falliti di fila prima di segnare l'errore
const TRATTO_CHARS = 1200;            // testo del pezzo salvato con la domanda
const AI_AMMESSE = ['Gemini', 'ChatGPT'];
export const FORMATO_RE = /^\s*(DOMANDA|RISCHIO|CR|ATTENZIONE|AGENDA)\s*\[\s*(\d{1,2})\s*\]\s*:\s*(.+)$/i;

// Utenti abilitati (2026-10-28): campo settings «Addestramento Ai Projexa» a true (valore1) per
// tenant/utente, non scaduto. Vale per pagina Analisi PM, pulsanti della trascrizione, deploy
// dei modelli e insegnanti (Associazioni, RAID e CR). user = { tenant_id, user_id }.
const CAMPO_ADDESTRAMENTO = 'addestramento ai projexa';
export async function analisiPmAbilitata(user) {
  if (!user || !user.tenant_id || !user.user_id) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM settings
        WHERE tenant_id = $1 AND user_id = $2
          AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
          AND valore1 = true
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        LIMIT 1`,
      [user.tenant_id, user.user_id, CAMPO_ADDESTRAMENTO]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error('❌ [ANALISI PM] controllo «Addestramento Ai Projexa»:', e.message);
    return false;
  }
}

// Pezzi di ~PEZZO_CHARS caratteri a righe intere. Stessa funzione per analisi e download:
// il numero del pezzo resta lo stesso finché la trascrizione non cambia.
export function pezzi(testo) {
  const out = [];
  let cur = '';
  for (const riga of String(testo || '').replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + riga.length + 1 > PEZZO_CHARS) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + riga;
  }
  if (cur) out.push(cur);
  return out;
}

export async function aiScelta(user) {
  try {
    const r = (await db.query('SELECT ai FROM pm_analisi_config WHERE tenant_id = $1 AND user_id = $2', [user.tenant_id, user.user_id])).rows[0];
    return r && AI_AMMESSE.includes(r.ai) ? r.ai : 'Gemini';
  } catch {
    return 'Gemini';
  }
}
export { AI_AMMESSE };

// Prompt: regole di Pm projexa (prompt PM_PROJEXA) + compito di analisi su un gruppo [da, a).
async function promptAnalisi(user, nome, elenco, da, a) {
  const tpl = (await getPromptFor('PM_PROJEXA', user)).testo;
  const vars = {
    UTENTE: nome, RIUNIONE: '', DATA: '(riunione passata)', DATI: '(non disponibili in questa analisi)',
    INGRESSO: 'Ricevi la trascrizione di una riunione (righe «[ora] Nome: testo»).'
  };
  const regole = tpl.replace(/\{\{(UTENTE|RIUNIONE|DATA|DATI|INGRESSO)\}\}/g, (x, k) => vars[k]);
  const prima = elenco.slice(Math.max(0, da - 2), da);
  const dopo = elenco.slice(a, a + 2);
  return `${regole}

=== COMPITO DI QUESTA RICHIESTA: ANALISI DI UNA RIUNIONE GIÀ SVOLTA ===
Sei un project manager senior che rivede la riunione di ${nome} per insegnargli quali domande avrebbe
potuto fare. La riunione è divisa in PEZZI numerati nell'ordine in cui sono stati detti.
Per OGNI pezzo da ${da + 1} a ${a} indica la domanda (o il punto da far notare) che Pm projexa avrebbe
dovuto suggerire IN QUEL MOMENTO a ${nome}, seguendo le regole sopra: segnali 1-13, formato
"PAROLA [n]: frase", al massimo un suggerimento, molto selettivo (per la maggior parte dei pezzi la
risposta giusta è "Nessun suggerimento.").

COME USARE CIÒ CHE HA DETTO ${nome.toUpperCase()}: le righe «${nome}: …» sono sue.
- Se in un pezzo c'è un segnale e ${nome} lo coglie poco dopo, il suggerimento giusto è proprio
  quello che poi ha chiesto (anticipato e scritto nel formato), con "fatta": true.
- Se un PM senior avrebbe dovuto chiedere o far notare qualcosa e ${nome} NON l'ha fatto (punto
  rimasto aperto, data mai fissata, CR non segnalata, dipendenza senza responsabile, rischio non
  detto), scrivi il suggerimento con "fatta": false: sono i più preziosi.
- Non suggerire ciò che ${nome} ha già chiesto PRIMA o nello stesso pezzo, né ciò che viene
  chiarito subito dopo da qualcun altro. Non ripetere un suggerimento già dato.
Rispondi SOLO con JSON: {"pezzi":[{"i":${da + 1},"risposta":"...","fatta":true}, ...]}, un elemento
per ogni pezzo da ${da + 1} a ${a} ("fatta" true/false solo quando c'è un suggerimento).
${prima.length ? `\n=== PRIMA (solo contesto, già analizzato) ===\n${prima.join('\n')}\n` : ''}
${elenco.slice(da, a).map((p, k) => `--- PEZZO ${da + k + 1} ---\n${p}`).join('\n\n')}
${dopo.length ? `\n=== DOPO (solo contesto, NON analizzarlo) ===\n${dopo.join('\n')}` : ''}`;
}

// JSON dell'AI -> [{ i (da 0), testo, segnale, fatta }] solo per i pezzi con un suggerimento.
function leggiRisposta(testo, da, a) {
  let j = null;
  const t = String(testo || '');
  try { j = JSON.parse(t); } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) try { j = JSON.parse(m[0]); } catch { /* non JSON */ }
  }
  const lista = j && Array.isArray(j.pezzi) ? j.pezzi : Array.isArray(j) ? j : null;
  if (!lista) throw new Error('risposta dell\'AI non leggibile (JSON non valido)');
  const out = [];
  for (const x of lista) {
    const i = Number(x && x.i) - 1;
    if (!Number.isInteger(i) || i < da || i >= a) continue;
    const m = String(x.risposta || '').replace(/\*\*/g, '').trim().match(FORMATO_RE);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 13) continue;
    out.push({ i, testo: `${m[1].toUpperCase()} [${Number(m[2])}]: ${m[3].trim()}`, segnale: Number(m[2]), fatta: typeof x.fatta === 'boolean' ? x.fatta : null });
  }
  return out;
}

// Salva le domande; quelle già valutate (esito) non si toccano se la riunione si rianalizza.
async function salvaDomande(r, ai, elenco, domande) {
  for (const d of domande) {
    const { data } = await encryptRowForWrite(db, 'pm_analisi', {
      tratto: elenco[d.i].slice(-TRATTO_CHARS), suggerimento: d.testo
    });
    await db.query(
      `INSERT INTO pm_analisi (tenant_id, user_id, id_calendar, pezzo, ai, segnale, fatta, tratto, suggerimento, crypto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, user_id, id_calendar, pezzo) DO UPDATE
         SET ai = EXCLUDED.ai, segnale = EXCLUDED.segnale, fatta = EXCLUDED.fatta, tratto = EXCLUDED.tratto,
             suggerimento = EXCLUDED.suggerimento, crypto = EXCLUDED.crypto, updated_at = now()
       WHERE pm_analisi.esito IS NULL`,
      [r.tenant_id, r.user_id, r.id_calendar, d.i, ai, d.segnale, d.fatta, data.tratto, data.suggerimento, data.crypto ?? 0]);
  }
}

async function trascrizioneDi(r) {
  const m = (await db.query(
    'SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1',
    [r.tenant_id, r.user_id, r.id_calendar])).rows[0];
  return pezzi(m && m.trascrizione);
}

async function chiudiRiunione(r, stato, errore = null) {
  await db.query(
    `UPDATE pm_analisi_riunioni SET stato = $4, errore = $5, batch_id = NULL, updated_at = now(),
            completata_il = CASE WHEN $4 = 'fatta' THEN now() ELSE completata_il END
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
    [r.tenant_id, r.user_id, r.id_calendar, stato, errore]);
  // Il segno «da analizzare» si toglie sia a analisi finita sia in errore (si rimette a mano).
  await db.query('UPDATE rec_meeting SET analisi_pm = false WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
    [r.tenant_id, r.user_id, r.id_calendar]);
}

async function errore(r, e, report) {
  const tentativi = (Number(r.tentativi) || 0) + 1;
  const msg = String((e && e.message) || e).slice(0, 500);
  report.errori.push(`${r.id_calendar}: ${msg}`);
  if (tentativi >= MAX_TENTATIVI) { await chiudiRiunione(r, 'errore', msg); return; }
  await db.query('UPDATE pm_analisi_riunioni SET tentativi = $4, errore = $5, updated_at = now() WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
    [r.tenant_id, r.user_id, r.id_calendar, tentativi, msg]);
}

export async function eseguiAnalisiPm() {
  const report = { nuove: 0, gemini: 0, batchInviati: 0, batchRaccolti: 0, completate: 0, errori: [] };

  // 1. Riunioni segnate: una riga di avanzamento (nuova o ripartita da capo se già analizzata).
  const segnate = (await db.query(
    `SELECT m.tenant_id, m.user_id, m.id_calendar FROM rec_meeting m
      WHERE m.analisi_pm AND m.trascrizione IS NOT NULL AND btrim(m.trascrizione) <> ''
        AND NOT EXISTS (SELECT 1 FROM pm_analisi_riunioni a WHERE a.tenant_id = m.tenant_id AND a.user_id = m.user_id
                         AND a.id_calendar = m.id_calendar AND a.stato IN ('in_corso', 'batch'))`)).rows;
  for (const m of segnate) {
    const ai = await aiScelta(m);
    await db.query(
      `INSERT INTO pm_analisi_riunioni (tenant_id, user_id, id_calendar, ai, stato, prossimo_da, tentativi)
       VALUES ($1, $2, $3, $4, 'in_corso', 0, 0)
       ON CONFLICT (tenant_id, user_id, id_calendar) DO UPDATE
         SET ai = EXCLUDED.ai, stato = 'in_corso', prossimo_da = 0, tentativi = 0, errore = NULL, batch_id = NULL,
             completata_il = NULL, updated_at = now()`,
      [m.tenant_id, m.user_id, m.id_calendar, ai]);
    report.nuove++;
  }

  const aperte = (await db.query(
    `SELECT * FROM pm_analisi_riunioni WHERE stato IN ('in_corso', 'batch') ORDER BY created_at`)).rows;

  // 2. ChatGPT: invio in Batch di tutta la riunione, raccolta ai giri successivi.
  for (const r of aperte.filter((x) => x.ai === 'ChatGPT')) {
    try {
      const nome = await speakerName({ user_id: r.user_id });
      if (r.stato === 'in_corso') {
        const elenco = await trascrizioneDi(r);
        if (!elenco.length) { await chiudiRiunione(r, 'errore', 'trascrizione vuota'); continue; }
        const b = await inviaBatchAi(r.user_id, 'ChatGPT', await promptAnalisi(r, nome, elenco, 0, elenco.length), { json: true });
        await db.query(`UPDATE pm_analisi_riunioni SET stato = 'batch', batch_id = $4, pezzi_tot = $5, tentativi = 0, errore = NULL, updated_at = now()
                          WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`, [r.tenant_id, r.user_id, r.id_calendar, b.batchId, elenco.length]);
        report.batchInviati++;
      } else {
        const s = await statoBatchAi(r.user_id, 'ChatGPT', r.batch_id);
        if (s.stato === 'in_corso') continue;
        if (s.stato !== 'pronto') { await chiudiRiunione(r, 'errore', s.errore || 'Batch non riuscito'); report.errori.push(`${r.id_calendar}: ${s.errore}`); continue; }
        const elenco = await trascrizioneDi(r);
        await salvaDomande(r, 'ChatGPT', elenco, leggiRisposta(s.text, 0, elenco.length));
        await chiudiRiunione(r, 'fatta');
        report.batchRaccolti++;
        report.completate++;
      }
    } catch (e) {
      await errore(r, e, report);
    }
  }

  // 3. Gemini (gratuito): UN gruppo di pezzi per giro, della riunione più vecchia in corso.
  const g = aperte.find((x) => x.ai === 'Gemini');
  if (g) {
    try {
      const nome = await speakerName({ user_id: g.user_id });
      const elenco = await trascrizioneDi(g);
      if (!elenco.length) await chiudiRiunione(g, 'errore', 'trascrizione vuota');
      else {
        const da = Math.min(Number(g.prossimo_da) || 0, elenco.length);
        const a = Math.min(elenco.length, da + GRUPPO_PEZZI);
        if (da < a) {
          const r = await askAiProvider(g.user_id, 'Gemini', await promptAnalisi(g, nome, elenco, da, a), { json: true });
          await salvaDomande(g, 'Gemini', elenco, leggiRisposta(r.text, da, a));
          report.gemini++;
        }
        if (a >= elenco.length) { await chiudiRiunione(g, 'fatta'); report.completate++; }
        else {
          await db.query(`UPDATE pm_analisi_riunioni SET prossimo_da = $4, pezzi_tot = $5, tentativi = 0, errore = NULL, updated_at = now()
                            WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`, [g.tenant_id, g.user_id, g.id_calendar, a, elenco.length]);
        }
      }
    } catch (e) {
      await errore(g, e, report);
    }
  }

  const riepilogo = `nuove ${report.nuove}, gruppi Gemini ${report.gemini}, Batch inviati ${report.batchInviati}, raccolti ${report.batchRaccolti}, completate ${report.completate}${report.errori.length ? `, errori ${report.errori.length}` : ''}`;
  return { ok: !report.errori.length, riepilogo, ...report };
}
