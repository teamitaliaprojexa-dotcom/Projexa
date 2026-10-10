// ============================================================================
// AI ED ESECUZIONE PER FUNZIONE (Impostazioni › AI) - 2026-10-09
// ----------------------------------------------------------------------------
// Ogni funzione di Projexa che usa l'AI ha due campi in Impostazioni › AI (settings.valore2):
//   «AI <funzione>»          ChatGPT / Claude / Gemini / Mistral / Recap Projexa (lento) /
//                            "Chiedi sempre" (la sceglie l'utente a ogni uso). Vuoto = l'AI di
//                            «AI generazione e-mail recap» (come prima).
//   «Esecuzione <funzione>»  "Immediato" / "Batch (50% off)" / "Chiedi Sempre". Vuoto = Immediato.
// Le OPERAZIONI sono i singoli pulsanti: più operazioni possono condividere la stessa funzione
// (le 5 funzioni PM usano «AI Funzioni PM»). locale = ammessa "Recap Projexa (lento)", che non
// ha il Batch (è già gratuito): con lei l'esecuzione è sempre Immediata.
// Il recap delle riunioni (cliente e interno) ha la sua logica in jobs/meetingTranscription.js.
// ============================================================================
import db from './database.js';
import { PROVIDERS, aiCollegate, localRecapMode } from '../routes/ai.js';

export const FUNZIONI = {
  email_attivita: { ai: ['AI Email attività'], esecuzione: 'Esecuzione Email attività' },
  dossier: { ai: ['AI Dossier Cliente'], esecuzione: 'Esecuzione Dossier' },
  kickoff: { ai: ['AI Slide Kick-Off'], esecuzione: 'Esecuzione Kick-Off' },
  // Offerta: senza il suo campo usa l'AI del Kick-off (comportamento precedente).
  offerta: { ai: ['AI Offerta Economica', 'AI Slide Kick-Off'], esecuzione: 'Esecuzione Offerta Economica' },
  pm: { ai: ['AI Funzioni PM'], esecuzione: 'Esecuzione Funzioni PM' }
};

// file = il risultato è un file da scaricare (in Batch resta nella cartella temporanea).
// facoltativa = la funzione funziona anche senza AI (solo dati, con un avviso al posto del testo).
export const OPERAZIONI = {
  email_attivita: { funzione: 'email_attivita', etichetta: 'Email attività a carico', locale: true },
  dossier: { funzione: 'dossier', etichetta: 'Dossier Cliente', locale: true, facoltativa: true },
  kickoff: { funzione: 'kickoff', etichetta: 'Slide Kick-off', locale: false, file: true },
  offerta: { funzione: 'offerta', etichetta: 'Offerta Economica', locale: false, file: true },
  pm_raid: { funzione: 'pm', etichetta: 'Rischi e decisioni dalla riunione', locale: false },
  pm_cr: { funzione: 'pm', etichetta: 'Change Request dalla riunione', locale: false },
  pm_documento: { funzione: 'pm', etichetta: 'Documento di progetto (anteprima)', locale: true, facoltativa: true },
  pm_docx: { funzione: 'pm', etichetta: 'Documento di progetto (Word)', locale: false, file: true },
  pm_chiedi: { funzione: 'pm', etichetta: 'Chiedi al progetto', locale: false },
  pm_briefing: { funzione: 'pm', etichetta: 'Briefing della riunione', locale: true }
};

const CAMPO_RECAP = 'AI generazione e-mail recap';
export const isChiedi = (v) => /^chiedi/i.test(String(v || '').trim());
const errore = (status, message, code) => Object.assign(new Error(message), { status, code });

async function valore(user, campo) {
  const c = String(campo).trim().toLowerCase();
  const r = (await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, c]
  )).rows[0];
  return r && r.valore2 ? String(r.valore2).trim() : '';
}

// Valori dei campi della funzione così come sono: { ai, esecuzione: 'immediato'|'batch'|'chiedi' }.
async function impostazioni(user, operazione) {
  const op = OPERAZIONI[operazione];
  if (!op) throw errore(400, 'Funzione AI non riconosciuta');
  const f = FUNZIONI[op.funzione];
  let ai = '';
  for (const campo of [...f.ai, CAMPO_RECAP]) {
    ai = await valore(user, campo);
    if (ai) break;
  }
  const e = await valore(user, f.esecuzione);
  const esecuzione = isChiedi(e) ? 'chiedi' : (/^batch/i.test(e) ? 'batch' : 'immediato');
  return { op, f, ai, esecuzione };
}

const etichettaAi = (nome) => {
  const cfg = PROVIDERS[String(nome || '').toLowerCase()];
  return cfg ? cfg.label : nome;
};

// AI ed esecuzione da usare per una richiesta. scelte = { ai, esecuzione } dalla finestra di
// scelta ("Chiedi sempre"). Restituisce { nome, label, locale, esecuzione } oppure errore
// (409 + code AI_SCELTA se manca una scelta: la pagina deve chiederla).
export async function risolviAi(user, operazione, scelte = {}) {
  const { op, f, ai: impostata, esecuzione: esImpostata } = await impostazioni(user, operazione);
  let nome = impostata;
  if (isChiedi(nome)) {
    nome = String(scelte.ai || '').trim();
    if (!nome) throw errore(409, 'Scegli l\'AI da usare', 'AI_SCELTA');
  }
  if (!nome) throw errore(400, `Scegli l'AI in Impostazioni › AI › «${f.ai[0]}»`);
  let locale = localRecapMode(nome) === 'server';
  if (locale && !op.locale) {
    // Recap Projexa (lento) non può fare questa funzione (risposte strutturate / file): si usa
    // la prima AI con chiave collegata, come facevano prima le funzioni PM.
    const collegate = await aiCollegate(user.user_id);
    if (!collegate.length) throw errore(400, `«${op.etichetta}» richiede un'AI con chiave API (ChatGPT, Claude, Gemini o Mistral): collegala in Impostazioni › AI`);
    nome = collegate[0].nome;
    locale = false;
  }
  if (!locale && !PROVIDERS[nome.toLowerCase()]) throw errore(400, `L'AI «${nome}» non è utilizzabile per «${op.etichetta}»: scegline un'altra in Impostazioni › AI`);
  let esecuzione = esImpostata;
  if (esecuzione === 'chiedi') {
    esecuzione = String(scelte.esecuzione || '').trim().toLowerCase();
    if (locale) esecuzione = 'immediato';
    if (!['immediato', 'batch'].includes(esecuzione)) throw errore(409, 'Scegli se eseguire Immediato o in Batch', 'AI_SCELTA');
  }
  if (locale) esecuzione = 'immediato';
  return { nome, label: locale ? 'Recap Projexa (lento)' : etichettaAi(nome), locale, esecuzione };
}

// Per la finestra di scelta delle pagine: cosa chiedere e quali AI proporre.
export async function opzioniAi(user, operazione) {
  const { op, ai, esecuzione } = await impostazioni(user, operazione);
  const chiediAi = isChiedi(ai);
  const aiDisponibili = chiediAi
    ? [...(await aiCollegate(user.user_id)).map((x) => ({ nome: x.nome, label: x.label, batch: true })),
      ...(op.locale ? [{ nome: 'Recap Projexa (lento)', label: 'Recap Projexa (lento, gratuito)', batch: false }] : [])]
    : [];
  return {
    operazione, etichetta: op.etichetta, ai, chiediAi, esecuzione, chiediEsecuzione: esecuzione === 'chiedi',
    // AI già impostata: il Batch c'è solo se non è Recap Projexa.
    batchPossibile: chiediAi ? true : localRecapMode(ai) !== 'server',
    aiDisponibili
  };
}

// Riepilogo per le finestre che mostrano l'AI in uso (Kick-off, Offerta, Cruscotto PM):
// { nome, supportata, connessa, locale } come prima; con "Chiedi sempre" nome = "Chiedi sempre".
export async function infoAi(user, operazione) {
  const { op, ai } = await impostazioni(user, operazione);
  const collegate = await aiCollegate(user.user_id);
  if (isChiedi(ai)) return { nome: 'Chiedi sempre', supportata: true, connessa: collegate.length > 0 || op.locale, locale: false, chiedi: true };
  if (!ai) return { nome: '', supportata: false, connessa: false, locale: false };
  const locale = localRecapMode(ai) === 'server';
  if (locale) {
    if (op.locale) return { nome: ai, supportata: true, connessa: true, locale: true };
    // Funzione che Recap Projexa non sa fare: si userà la prima AI collegata (risolviAi).
    return collegate.length ? { nome: collegate[0].nome, supportata: true, connessa: true, locale: false } : { nome: ai, supportata: false, connessa: false, locale: false };
  }
  const cfg = PROVIDERS[ai.toLowerCase()];
  return { nome: ai, supportata: !!cfg, connessa: !!cfg && collegate.some((c) => c.nome.toLowerCase() === ai.toLowerCase()), locale: false };
}
