// ============================================================================
// AI ED ESECUZIONE PER FUNZIONE (Impostazioni › AI) - 2026-10-09
// ----------------------------------------------------------------------------
// Ogni funzione di Projexa che usa l'AI ha due campi in Impostazioni › AI (settings.valore2):
//   «AI <funzione>»          ChatGPT / Claude / Gemini / Mistral /
//                            "Chiedi sempre" (la sceglie l'utente a ogni uso). Vuoto = l'AI di
//                            «AI generazione e-mail recap» (come prima).
//   «Esecuzione <funzione>»  "Immediato" / "Batch (50% off)" / "Chiedi Sempre". Vuoto = Immediato.
// Le OPERAZIONI sono i singoli pulsanti: più operazioni possono condividere la stessa funzione
// (le 5 funzioni PM usano «AI Funzioni PM»).
// 2026-10-29: tolta l'AI interna «Projexa» (Ollama): solo AI esterne con chiave API.
// Il recap delle riunioni (cliente e interno) ha la sua logica in jobs/meetingTranscription.js.
// ============================================================================
import db from './database.js';
import { PROVIDERS, aiCollegate } from '../routes/ai.js';

export const FUNZIONI = {
  email_attivita: { ai: ['AI Email attività'], esecuzione: 'Esecuzione Email attività' },
  dossier: { ai: ['AI Dossier Cliente'], esecuzione: 'Esecuzione Dossier' },
  kickoff: { ai: ['AI Slide Kick-off'], esecuzione: 'Esecuzione Kick-off' },
  // Offerta: senza il suo campo usa l'AI del Kick-off (comportamento precedente).
  offerta: { ai: ['AI Offerta economica', 'AI Slide Kick-off'], esecuzione: 'Esecuzione Offerta economica' },
  pm: { ai: ['AI Funzioni PM'], esecuzione: 'Esecuzione Funzioni PM' },
  // Add-in di Outlook (2026-10-22, routes/outlookAddin.js): campo tipo 23 «AI Add-in Outlook»
  // (valore1 = attivo, valore2 = AI). «Esecuzione Add-in Outlook» facoltativo (vuoto = Immediato).
  outlook: { ai: ['AI Add-in Outlook'], esecuzione: 'Esecuzione Add-in Outlook', soloSuo: true }
};

// file = il risultato è un file da scaricare (in Batch resta nella cartella temporanea).
// facoltativa = la funzione funziona anche senza AI (solo dati, con un avviso al posto del testo).
export const OPERAZIONI = {
  email_attivita: { funzione: 'email_attivita', etichetta: 'Email attività a carico' },
  // Pulsante «Email» del registro delle azioni a carico del cliente: stessa AI/esecuzione.
  email_azioni_cliente: { funzione: 'email_attivita', etichetta: 'Email azioni del cliente' },
  dossier: { funzione: 'dossier', etichetta: 'Dossier Cliente', facoltativa: true },
  kickoff: { funzione: 'kickoff', etichetta: 'Slide Kick-off', file: true },
  offerta: { funzione: 'offerta', etichetta: 'Offerta economica', file: true },
  pm_raid: { funzione: 'pm', etichetta: 'Rischi e decisioni dalla riunione' },
  pm_cr: { funzione: 'pm', etichetta: 'Change Request dalla riunione' },
  pm_documento: { funzione: 'pm', etichetta: 'Documento di progetto (anteprima)', facoltativa: true },
  pm_docx: { funzione: 'pm', etichetta: 'Documento di progetto (Word)', file: true },
  pm_chiedi: { funzione: 'pm', etichetta: 'Chiedi al progetto' },
  pm_briefing: { funzione: 'pm', etichetta: 'Briefing della riunione' },
  // sempreInBackground: anche in Immediato diventa un lavoro (coda, più richieste insieme, ripresa
  // dopo un riavvio); il pannello di Outlook ne legge lo stato. cancellaInput: a lavoro concluso
  // il testo dell'email si toglie da ai_lavori.parametri (resta solo il risultato, 7 giorni).
  outlook_analisi: { funzione: 'outlook', etichetta: 'Analisi email (Outlook)', sempreInBackground: true, cancellaInput: true, notificaSoloErrori: true }
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
  // soloSuo: la funzione usa solo il suo campo (niente ripiego sull'AI del recap).
  for (const campo of f.soloSuo ? f.ai : [...f.ai, CAMPO_RECAP]) {
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

// Valore rimasto dall'AI interna (voci «Projexa», «Projexa 14B», tolte il 2026-10-29): si usa la
// prima AI con chiave collegata finché l'utente non sceglie in Impostazioni › AI.
const exProjexa = (nome) => /^projexa\b/i.test(String(nome || '').trim());

// AI ed esecuzione da usare per una richiesta. scelte = { ai, esecuzione } dalla finestra di
// scelta ("Chiedi sempre"). Restituisce { nome, label, esecuzione } oppure errore
// (409 + code AI_SCELTA se manca una scelta: la pagina deve chiederla).
export async function risolviAi(user, operazione, scelte = {}) {
  const { op, f, ai: impostata, esecuzione: esImpostata } = await impostazioni(user, operazione);
  let nome = impostata;
  if (isChiedi(nome)) {
    nome = String(scelte.ai || '').trim();
    if (!nome) throw errore(409, 'Scegli l\'AI da usare', 'AI_SCELTA');
  }
  if (!nome) throw errore(400, `Scegli l'AI in Impostazioni › AI › «${f.ai[0]}»`);
  if (exProjexa(nome)) {
    const collegate = await aiCollegate(user.user_id);
    if (!collegate.length) throw errore(400, `«${op.etichetta}» richiede un'AI con chiave API (ChatGPT, Claude, Gemini o Mistral): collegala in Impostazioni › AI`);
    nome = collegate[0].nome;
  }
  if (!PROVIDERS[nome.toLowerCase()]) throw errore(400, `L'AI «${nome}» non è utilizzabile per «${op.etichetta}»: scegline un'altra in Impostazioni › AI`);
  let esecuzione = esImpostata;
  if (esecuzione === 'chiedi') {
    esecuzione = String(scelte.esecuzione || '').trim().toLowerCase();
    if (!['immediato', 'batch'].includes(esecuzione)) throw errore(409, 'Scegli se eseguire Immediato o in Batch', 'AI_SCELTA');
  }
  return { nome, label: etichettaAi(nome), esecuzione };
}

// Per la finestra di scelta delle pagine: cosa chiedere e quali AI proporre.
export async function opzioniAi(user, operazione) {
  const { op, ai, esecuzione } = await impostazioni(user, operazione);
  const chiediAi = isChiedi(ai);
  const aiDisponibili = chiediAi
    ? (await aiCollegate(user.user_id)).map((x) => ({ nome: x.nome, label: x.label, batch: true }))
    : [];
  return {
    operazione, etichetta: op.etichetta, ai, chiediAi, esecuzione, chiediEsecuzione: esecuzione === 'chiedi',
    batchPossibile: true,
    aiDisponibili
  };
}

// Riepilogo per le finestre che mostrano l'AI in uso (Kick-off, Offerta, Cruscotto PM):
// { nome, supportata, connessa }; con "Chiedi sempre" nome = "Chiedi sempre".
export async function infoAi(user, operazione) {
  const { ai } = await impostazioni(user, operazione);
  const collegate = await aiCollegate(user.user_id);
  if (isChiedi(ai)) return { nome: 'Chiedi sempre', supportata: true, connessa: collegate.length > 0, chiedi: true };
  if (!ai) return { nome: '', supportata: false, connessa: false };
  if (exProjexa(ai)) {
    // Si userà la prima AI collegata (risolviAi).
    return collegate.length ? { nome: collegate[0].nome, supportata: true, connessa: true } : { nome: ai, supportata: false, connessa: false };
  }
  const cfg = PROVIDERS[ai.toLowerCase()];
  return { nome: ai, supportata: !!cfg, connessa: !!cfg && collegate.some((c) => c.nome.toLowerCase() === ai.toLowerCase()) };
}