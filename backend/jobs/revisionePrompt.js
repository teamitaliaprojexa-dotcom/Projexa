// ============================================================================
// REVISIONE DEI PROMPT DEL RECAP DALLE ANALISI NOTTURNE (2026-10-20, revisione_prompt.sql)
// ----------------------------------------------------------------------------
// Nella pagina Analisi PM › Recap l'utente corregge (o segna come errati) i recap cliente e i
// recap interni scritti di notte dall'AI insegnante (jobs/analisiRecap.js). Le differenze tra
// il testo dell'AI e quello corretto dicono dove il prompt guida male: a fine giro notturno,
// se ci sono almeno MIN_NUOVE valutazioni utili non ancora usate, la stessa AI propone un testo
// nuovo del prompt (RECAP_EMAIL o RECAP_INTERNO) con il motivo e l'elenco delle modifiche.
// La proposta resta in prompt_proposte finché l'utente non la applica (anche dopo averla
// ritoccata) o la scarta dalla pagina: NIENTE si cambia da solo.
// Controlli prima di salvare una proposta: stessi segnaposto {{...}} del prompt attuale e le
// parti che il codice legge (Oggetto, AZIONI IN CARICO AL CLIENTE; SINTESI, ATTIVITA e righe
// con «|»): un testo che le perde romperebbe «Crea task», promemoria e recap interno.
// ============================================================================
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { getPromptFor, getPromptRow, savePrompt, PROMPT_FUNCTIONS } from '../config/prompts.js';
import { askAiProvider } from '../routes/ai.js';
import { aiScelta } from './analisiPm.js';

export const FUNZIONI_REVISIONE = { recap: 'RECAP_EMAIL', interno: 'RECAP_INTERNO' };
const MIN_NUOVE = 3;          // valutazioni utili (corrette con testo cambiato, o errate) per proporre
const MAX_ESEMPI = 6;         // esempi messi nella richiesta all'AI
const MAX_TESTO_ESEMPIO = 3500;

// Parti del testo che il codice legge: devono restare nel prompt.
const OBBLIGATORI = {
  RECAP_EMAIL: [
    { re: /Oggetto:/, cosa: 'la riga «Oggetto:»' },
    { re: /AZIONI IN CARICO AL CLIENTE/, cosa: 'la sezione «AZIONI IN CARICO AL CLIENTE» (la leggono Crea task e i promemoria)' }
  ],
  RECAP_INTERNO: [
    { re: /SINTESI/, cosa: 'la parte «SINTESI»' },
    { re: /ATTIVITA/, cosa: 'la parte «ATTIVITA»' },
    { re: /\|[^\n]*\|[^\n]*\|/, cosa: 'il formato delle righe «- Argomento | Descrizione | Owner | Scadenza»' }
  ]
};

const segnaposto = (t) => new Set((String(t).match(/\{\{([A-Z_]+)\}\}/g) || []).map((x) => x.slice(2, -2)));

// Problemi del testo proposto rispetto all'attuale ([] = va bene).
export function controllaProposta(funzione, attuale, proposto) {
  const problemi = [];
  const t = String(proposto || '');
  if (t.trim().length < 200) problemi.push('testo troppo corto');
  const prima = segnaposto(attuale);
  const dopo = segnaposto(t);
  for (const s of prima) if (!dopo.has(s)) problemi.push(`manca il segnaposto {{${s}}}`);
  const ammessi = new Set((PROMPT_FUNCTIONS[funzione] || {}).segnaposto || []);
  for (const s of dopo) if (!ammessi.has(s)) problemi.push(`segnaposto sconosciuto {{${s}}}`);
  for (const o of OBBLIGATORI[funzione] || []) if (!o.re.test(t)) problemi.push(`manca ${o.cosa}`);
  return problemi;
}

const corto = (t) => { const s = String(t || '').trim(); return s.length > MAX_TESTO_ESEMPIO ? `${s.slice(0, MAX_TESTO_ESEMPIO)}\n[…]` : s; };

// Valutazioni utili non ancora usate per una revisione: corrette con testo cambiato, o errate.
async function valutazioniNuove(user, tipo) {
  return (await db.query(
    `SELECT id, esito, risposta, testo_corretto FROM recap_analisi
      WHERE tenant_id = $1 AND user_id = $2 AND tipo = $3 AND usata_revisione IS NULL
        AND (esito = 'errata' OR (esito = 'corretta' AND testo_corretto IS NOT NULL))
      ORDER BY updated_at DESC LIMIT 40`, [user.tenant_id, user.user_id, tipo])).rows;
}

function richiesta(funzione, attuale, esempi) {
  const cosa = funzione === 'RECAP_EMAIL' ? 'l\'email di recap per il CLIENTE' : 'il RECAP INTERNO per il team di lavoro';
  return `Sei un esperto di prompt per modelli linguistici e di project management. Il prompt qui sotto serve a far scrivere a un'AI ${cosa} di una riunione di progetto HR TeamSystem, partendo dalla trascrizione o dagli appunti. Lo usano anche modelli piccoli (7B) su CPU: deve restare chiaro, breve e senza contraddizioni.

Il project manager ha rivisto alcuni testi scritti con questo prompt: per ognuno trovi il testo dell'AI e la versione CORRETTA da lui, oppure l'indicazione che il testo era sbagliato. Capisci quali regole mancano, sono ambigue o portano a errori ricorrenti (argomenti persi, azioni alla persona sbagliata, date inventate, tono, struttura, lunghezza…) e riscrivi il prompt per evitarli.

VINCOLI (obbligatori)
- Tieni TUTTI i segnaposto tra doppie graffe esattamente come sono (es. {{TRASCRIZIONE}}, {{OGGETTO}}): Projexa li sostituisce con i dati veri. Non aggiungerne di nuovi.
${funzione === 'RECAP_EMAIL'
    ? '- Tieni la riga «Oggetto:» e la sezione «AZIONI IN CARICO AL CLIENTE» come ultima parte prima dei saluti, con le azioni raggruppate per persona del cliente («<Nome>» e sotto righe «- azione – scadenza»): Projexa la legge per creare i task. Le altre parti (punti aperti, prossimi passi TeamSystem, prossimo incontro) restano PRIMA di quella sezione.'
    : '- Tieni le parti «SINTESI» e «ATTIVITA» e il formato delle righe «- Argomento | Descrizione | Owner | Scadenza» con esattamente 3 separatori «|»: Projexa le legge per creare le attività.'}
- Non mettere nel prompt nomi, clienti, ticket o fatti delle riunioni d'esempio: le regole devono valere per tutte le riunioni.
- Cambia solo ciò che serve: se il prompt va già bene su un punto, lascialo com'è.

Rispondi SOLO con JSON: {"motivazione":"2-4 frasi su cosa hai visto negli esempi","modifiche":["modifica 1","modifica 2"],"testo":"il prompt completo nuovo"}

=== PROMPT ATTUALE ===
${attuale}

=== TESTI RIVISTI DAL PROJECT MANAGER ===
${esempi.map((e, i) => (e.esito === 'errata'
    ? `--- ESEMPIO ${i + 1}: testo dell'AI giudicato SBAGLIATO ---\n${corto(e.risposta)}`
    : `--- ESEMPIO ${i + 1}: testo dell'AI ---\n${corto(e.risposta)}\n--- ESEMPIO ${i + 1}: versione CORRETTA dal project manager ---\n${corto(e.testo_corretto)}`)).join('\n\n')}`;
}

function leggiJson(testo) {
  const t = String(testo || '');
  try { return JSON.parse(t); } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch { /* non JSON */ }
  }
  return null;
}

// Proposta per un tipo ('recap' | 'interno'). forza = anche con meno di MIN_NUOVE valutazioni
// (pulsante «Proponi ora»). Restituisce { creata, motivo }.
export async function proponiRevisione(user, tipo, { forza = false } = {}) {
  const funzione = FUNZIONI_REVISIONE[tipo];
  if (!funzione) throw Object.assign(new Error('Tipo non valido'), { status: 400 });
  const aperta = (await db.query(
    `SELECT 1 FROM prompt_proposte WHERE tenant_id = $1 AND user_id = $2 AND funzione = $3 AND stato = 'proposta' LIMIT 1`,
    [user.tenant_id, user.user_id, funzione])).rowCount;
  if (aperta) return { creata: false, motivo: 'c\'è già una proposta da valutare per questo prompt' };
  const nuove = await valutazioniNuove(user, tipo);
  if (!nuove.length || (!forza && nuove.length < MIN_NUOVE)) {
    return { creata: false, motivo: `servono almeno ${forza ? 1 : MIN_NUOVE} testi corretti (con il testo cambiato) o errati non ancora usati: ora ${nuove.length}` };
  }
  // Prima le correzioni (dicono COSA cambiare), poi gli errati.
  const esempi = [...nuove.filter((x) => x.esito === 'corretta'), ...nuove.filter((x) => x.esito === 'errata')].slice(0, MAX_ESEMPI);
  const attuale = (await getPromptFor(funzione, user)).testo;
  const ai = await aiScelta(user);
  const r = await askAiProvider(user.user_id, ai, richiesta(funzione, attuale, esempi), { json: true });
  const j = leggiJson(r.text);
  if (!j || typeof j.testo !== 'string') throw new Error('risposta dell\'AI non leggibile (JSON non valido)');
  const testo = j.testo.replace(/\r\n?/g, '\n').trim();
  const problemi = controllaProposta(funzione, attuale, testo);
  if (problemi.length) throw new Error(`proposta scartata: ${problemi.join('; ')}`);
  if (testo === attuale.trim()) return { creata: false, motivo: 'l\'AI non ha trovato nulla da cambiare' };
  const modifiche = (Array.isArray(j.modifiche) ? j.modifiche : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
  const { data } = await encryptRowForWrite(db, 'prompt_proposte', {
    motivazione: String(j.motivazione || '').trim().slice(0, 3000), modifiche: modifiche.join('\n')
  });
  await db.query(
    `INSERT INTO prompt_proposte (tenant_id, user_id, funzione, testo_attuale, testo_proposto, motivazione, modifiche, esempi, ai, crypto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [user.tenant_id, user.user_id, funzione, attuale, testo, data.motivazione, data.modifiche, esempi.length, ai, data.crypto ?? 0]);
  await db.query('UPDATE recap_analisi SET usata_revisione = now() WHERE id = ANY($1::uuid[])', [esempi.map((x) => x.id)]);
  console.log(`[REVISIONE PROMPT] ${funzione}: proposta creata per ${user.user_id} con ${ai} (${esempi.length} esempi)`);
  return { creata: true, motivo: `proposta su ${esempi.length} testi rivisti` };
}

// A fine giro notturno (jobs/analisiRecap.js): una proposta per prompt e per utente al massimo
// una volta al giorno, solo se ci sono abbastanza valutazioni nuove. Non lancia errori.
export async function eseguiRevisioni() {
  const out = { proposte: 0, errori: [] };
  let utenti = [];
  try {
    utenti = (await db.query(
      `SELECT DISTINCT a.tenant_id, a.user_id, a.tipo FROM recap_analisi a
        WHERE a.tipo IN ('recap', 'interno') AND a.usata_revisione IS NULL
          AND (a.esito = 'errata' OR (a.esito = 'corretta' AND a.testo_corretto IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM prompt_proposte p WHERE p.tenant_id = a.tenant_id AND p.user_id = a.user_id
                           AND p.created_at > now() - interval '20 hours')`)).rows;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') out.errori.push(e.message); // revisione_prompt.sql non eseguito
    return out;
  }
  for (const u of utenti) {
    try {
      const r = await proponiRevisione(u, u.tipo);
      if (r.creata) out.proposte++;
    } catch (e) {
      out.errori.push(`${FUNZIONI_REVISIONE[u.tipo]}: ${e.message}`);
    }
  }
  return out;
}

// Applica una proposta (testo eventualmente ritoccato dall'utente): copia del testo in uso in
// app_prompts_backup, poi salva sul prompt che l'utente usa davvero (il suo personale se c'è,
// altrimenti lo standard). Restituisce { ambito }.
export async function applicaProposta(user, id, testo, autore) {
  const p = (await db.query(`SELECT * FROM prompt_proposte WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, user.tenant_id, user.user_id])).rows[0];
  if (!p) throw Object.assign(new Error('Proposta non trovata'), { status: 404 });
  if (p.stato !== 'proposta') throw Object.assign(new Error('Proposta già applicata o scartata'), { status: 409 });
  const nuovo = String(testo || p.testo_proposto).replace(/\r\n?/g, '\n').trim();
  const attuale = await getPromptFor(p.funzione, user);
  const problemi = controllaProposta(p.funzione, attuale.testo, nuovo);
  if (problemi.length) throw Object.assign(new Error(`Testo non applicabile: ${problemi.join('; ')}`), { status: 400 });
  const personale = await getPromptRow(p.funzione, user.tenant_id, user.user_id);
  const [t, u] = personale ? [user.tenant_id, user.user_id] : [null, null];
  await db.query(
    `INSERT INTO app_prompts_backup (funzione, tenant_id, user_id, testo, updated_by, nota)
     VALUES ($1, $2, $3, $4, $5, $6)`, [p.funzione, t, u, attuale.testo, null, `prima della proposta ${id}`]);
  await savePrompt(p.funzione, t, u, nuovo, `${autore} (proposta Analisi Recap)`);
  await db.query(`UPDATE prompt_proposte SET stato = 'applicata', testo_applicato = $2, decisa_il = now() WHERE id = $1`, [id, nuovo]);
  console.log(`[REVISIONE PROMPT] ${p.funzione} (${personale ? 'personale' : 'standard'}) aggiornato da ${autore} con la proposta ${id}`);
  return { ambito: personale ? 'personale' : 'standard' };
}
