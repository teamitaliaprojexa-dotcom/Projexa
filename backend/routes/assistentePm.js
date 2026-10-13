// ============================================================================
// «AI ASSISTENTE PM» DURANTE LA REGISTRAZIONE DI UNA RIUNIONE (2026-10-13)
// ----------------------------------------------------------------------------
// Campo di settings «Ai Assistente PM» (tipo 23: interruttore valore1 + elenco valore2, per
// ora solo «Gemini»). Con l'interruttore acceso, quando si avvia una registrazione (pulsante
// Registra della riga o «Registra» della barra laterale) la dashboard apre la finestra
// «Assistente PM» (sito/js/assistente-pm.js). Fermando la registrazione la sessione si chiude.
//
// All'apertura la finestra chiede la MODALITÀ (scelta dell'utente a ogni registrazione):
//  - TESTO: la trascrizione la fa Projexa (Whisper sulla VM), non Gemini. Oltre ai blocchi
//    normali da ~2 minuti (trascrizione della riunione, coda di jobs/meetingTranscription.js) il
//    browser invia blocchi BREVI (~10 s) solo per l'assistente: il server li trascrive subito
//    (trascriviBloccoBreve, non salvati nella riunione) e ne manda il TESTO a Gemini;
//  - AUDIO LIVE: il browser manda l'audio della riunione in tempo reale (pezzi da ~0,5 s,
//    POST /audio) e il server lo inoltra a Gemini, che lo ascolta e risponde in testo. Il
//    testo di ciò che Gemini ha sentito compare solo nella finestra (non è salvato): la
//    trascrizione della riunione resta sempre quella di Projexa.
// La sessione Gemini Live la apre il server con la chiave dell'utente (che non va mai al
// browser). Gemini fa da project manager senior e risponde in testo; la finestra legge risposte
// e trascrizione con GET /messaggi ogni pochi secondi. L'utente può anche scrivere una domanda.
//
// Sessioni in memoria (un solo processo Node, PM2 fork): un riavvio del server le chiude e la
// finestra lo segnala. Gemini chiude la connessione ogni ~10 minuti con «goAway»: si riapre con
// l'handle di ripresa (sessionResumption), il contesto non si perde.
//
// Istruzioni: prompt ASSISTENTE_PM (app_prompts, file backend/prompts/assistente_pm.txt) con
// i dati del progetto della riunione (gli stessi del Briefing pre-riunione) se ce n'è uno.
// Modello: GEMINI_LIVE_MODEL nel .env (predefinito gemini-3.8-live); se Gemini chiude per quota
// esaurita, sovraccarico o modello non disponibile si passa ai modelli di GEMINI_LIVE_FALLBACK_MODEL
// (predefinito gemini-3.1-flash-live-preview), con avviso nella finestra. Risposta: i modelli
// Live «native audio» rispondono solo in AUDIO: si chiede AUDIO + trascrizione della risposta
// (outputAudioTranscription) e si usa solo il testo. GEMINI_LIVE_MODALITY=TEXT per i modelli
// che rispondono direttamente in testo.
// ============================================================================
import express from 'express';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegration } from '../config/integrations.js';
import { getPromptFor } from '../config/prompts.js';
import { speakerName, trascriviBloccoBreve } from '../jobs/meetingTranscription.js';
import { contestoProgetto, dataIt, oggiIso } from '../config/pmCore.js';

const router = express.Router();

const CAMPO = 'ai assistente pm';
// Modello principale e, in ordine, quelli di riserva usati se Gemini chiude la sessione per
// quota esaurita, sovraccarico o modello non disponibile (GEMINI_LIVE_FALLBACK_MODEL, separati
// da virgola; vuota = nessuna riserva).
const MODELLI = [...new Set([
  process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
  ...String(process.env.GEMINI_LIVE_FALLBACK_MODEL ?? 'gemini-3.1-flash-live-preview').split(',')
].map((m) => m.trim().replace(/^models\//, '')).filter(Boolean))];
const RISERVA_RE = /quota|resource[_ ]?exhausted|rate.?limit|too many|exceeded|overload|unavailable|not found|not supported|busy|capacity/i;
const CHIAVE_RE = /api key/i;
const CONTESTO_PEZZI = 8; // pezzi di riunione rimandati al modello di riserva
const MODALITA = String(process.env.GEMINI_LIVE_MODALITY || 'AUDIO').toUpperCase() === 'TEXT' ? 'TEXT' : 'AUDIO';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// AI gestite per ora dall'Assistente PM (voci dell'elenco del campo).
const AI_SUPPORTATE = { gemini: { provider: 'Gemini', prefix: 'gemini' } };
// Dati del progetto nelle istruzioni: restano nel contesto e si pagano a OGNI turno (Gemini Live
// non ha la cache del contesto), quindi ~4-5.000 token al massimo, sotto la soglia di compressione.
const MAX_DATI = 16000;
// Compressione del contesto (token): oltre COMPRESSIONE_DA si torna a COMPRESSIONE_A.
const COMPRESSIONE_DA = Number(process.env.GEMINI_LIVE_TRIGGER_TOKENS) || 24000;
const COMPRESSIONE_A = Number(process.env.GEMINI_LIVE_TARGET_TOKENS) || 12000;
const MAX_AUDIO_LIVE_BYTES = 256 * 1024; // pezzo di audio live: ~0,5 s = 16 KB
const MAX_ATTESA_AUDIO = 80;              // pezzi tenuti mentre Gemini si ricollega o risponde (~40 s)
const ATTESA_RISPOSTA_MS = 25000;         // audio live: attesa massima della risposta a un turno
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;  // blocco breve: ~30 s di WAV 16 kHz = ~1 MB
const MAX_MESSAGGI = 400;                 // messaggi tenuti per la finestra
const MAX_RICONNESSIONI = 5;              // di fila, senza una risposta riuscita in mezzo
const TURNO_TIMEOUT_MS = 90000;           // risposta che non arriva: si passa al testo successivo
// Audio live: ogni quanti ms si chiude il «turno» e Gemini valuta l'audio ascoltato. Il
// rilevamento automatico delle pause di Gemini non va bene per una riunione: si parla quasi di
// continuo e ogni nuova voce interromperebbe la risposta (che così non arriva mai).
const AUDIO_TURNO_MS = Math.max(5000, Number(process.env.ASSISTENTE_PM_TURNO_AUDIO_MS) || 30000);
// 30 s (era 15, scelta utente 2026-10-13): con tratti più lunghi Gemini capisce se un punto è
// già stato chiarito e interviene meno e meglio.
const INATTIVA_MS = 4 * 3600000;          // sessione dimenticata aperta: chiusa dopo 4 ore
const CONSERVA_MS = 2 * 3600000;          // messaggi tenuti dopo «Ferma» per l'export in Word
const vero = (v) => v === true || v === 'true' || v === 't' || v === 1 || v === '1';
const errore = (status, msg) => Object.assign(new Error(msg), { status });
// Risposta «niente da dire» (il prompt chiede un punto): non si mostra.
const SILENZIO_RE = /^[\s.…\-–—]*(ok|nessun suggerimento)?[\s.…\-–—]*$/i;
// Si mostrano solo i suggerimenti che iniziano con una parola chiave del prompt: il resto
// (es. «Io vi sento. C'è altro che posso fare?», il modello che parla alla riunione) si scarta.
// Le risposte alle domande scritte dall'utente si mostrano sempre.
const SUGGERIMENTO_RE = /^\W*(DOMANDA|RISCHIO|CR|ATTENZIONE|AGENDA)\s*:/i;

// "tenant|utente|id_calendar" -> sessione
const sessioni = new Map();
const chiave = (user, id) => `${user.tenant_id}|${user.user_id}|${id}`;

// Impostazione dell'utente: { attiva, ai } (ai = voce scelta, es. «Gemini»).
async function leggiImpostazione(user) {
  const r = (await db.query(
    `SELECT valore1, valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, CAMPO]
  )).rows[0];
  if (!r || !vero(r.valore1)) return { attiva: false, ai: '' };
  return { attiva: true, ai: String(r.valore2 || '').trim() || 'Gemini' };
}

// Dati della riunione per le istruzioni: oggetto, data, cliente/progetto e, se la riunione è
// collegata a un progetto dell'utente, il contesto del progetto (scheda, salute, RAID, azioni,
// recap delle ultime riunioni).
async function datiRiunione(user, idCalendar, titolo) {
  const m = (await db.query(
    `SELECT oggetto, data_calendar::text AS d, orario_calendar::text AS o, project_id::text AS p
       FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, idCalendar])).rows[0];
  const oggetto = (m && m.oggetto) || titolo || 'Riunione';
  let riunione = ` «${oggetto}»`;
  if (m && m.d) riunione += ` del ${dataIt(m.d)}${m.o ? ` alle ${String(m.o).slice(0, 5)}` : ''}`;
  let dati = 'Nessun progetto collegato alla riunione: basati solo sulla trascrizione.';
  if (m && m.p) {
    try {
      const ctx = await contestoProgetto(user, m.p, { riunioni: 3, maxRecap: 4000 });
      riunione += ` sul progetto «${ctx.prog.nome}»${ctx.prog.cliente ? ` del cliente ${ctx.prog.cliente}` : ''}`;
      dati = ctx.testo.slice(0, MAX_DATI);
    } catch (e) {
      // Progetto di un altro utente o non più disponibile: si prosegue senza dati.
      console.warn(`[ASSISTENTE PM] ${idCalendar}: dati del progetto non letti (${e.message})`);
    }
  }
  return { riunione, dati };
}

// {{INGRESSO}} del prompt: cosa riceve Gemini, secondo la modalità scelta nella finestra.
const INGRESSO = {
  testo: 'Ricevi la trascrizione della riunione a pezzi brevi di circa 10 secondi, man mano che viene detta (una frase può continuare nel pezzo successivo; righe «[ora] Nome: testo», dove «Partecipanti» sono le altre persone collegate).',
  audio: 'Ascolti in tempo reale l\'audio della riunione: la voce di chi ti usa (dal suo microfono) e quella degli altri partecipanti.'
};

async function istruzioni(user, idCalendar, titolo, modalita) {
  const { riunione, dati } = await datiRiunione(user, idCalendar, titolo);
  const utente = String(await speakerName(user) || '').trim() || user.email || '';
  const vars = { UTENTE: utente, RIUNIONE: riunione, DATA: dataIt(oggiIso()), DATI: dati, INGRESSO: INGRESSO[modalita] };
  let tpl = (await getPromptFor('ASSISTENTE_PM', user)).testo;
  if (!tpl.includes('{{INGRESSO}}')) tpl = `{{INGRESSO}}\n${tpl}`;
  if (!tpl.includes('{{DATI}}')) tpl += '\n\nDATI\n{{DATI}}';
  return tpl.replace(/\{\{(UTENTE|RIUNIONE|DATA|DATI|INGRESSO)\}\}/g, (x, k) => vars[k]);
}

// ----------------------------------------------------------------------------
// SESSIONE GEMINI LIVE (lato server)
// ----------------------------------------------------------------------------

function aggiungi(s, tipo, testo) {
  s.messaggi.push({ n: ++s.seq, tipo, testo: String(testo || ''), ora: new Date().toISOString() });
  if (s.messaggi.length > MAX_MESSAGGI) s.messaggi.splice(0, s.messaggi.length - MAX_MESSAGGI);
  s.ultimoUso = Date.now();
}

function connetti(s) {
  if (s.chiusa) return;
  s.pronta = false;
  const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(s.apiKey)}`);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.addEventListener('open', () => {
    const setup = {
      model: `models/${MODELLI[s.modelloIdx]}`,
      generationConfig: { responseModalities: [MODALITA] },
      systemInstruction: { parts: [{ text: s.istruzioni }] },
      // Riunioni lunghe: il contesto più vecchio si scarta invece di chiudere la sessione.
      // Soglia bassa anche per il COSTO: Gemini Live fattura a ogni risposta tutto il contesto
      // della sessione (con l'audio cresce di ~25 token al secondo). Le istruzioni restano.
      contextWindowCompression: { triggerTokens: COMPRESSIONE_DA, slidingWindow: { targetTokens: COMPRESSIONE_A } },
      sessionResumption: s.handle ? { handle: s.handle } : {}
    };
    if (MODALITA === 'AUDIO') setup.outputAudioTranscription = {};
    // Audio live: i turni li decide il server (activityStart/activityEnd ogni AUDIO_TURNO_MS),
    // chi parla non interrompe la risposta di Gemini. Gemini restituisce anche il testo di ciò
    // che ha sentito, mostrato SOLO nella finestra (scheda «Trascrizione live», non salvato:
    // la trascrizione della riunione resta quella di Projexa).
    if (s.modalita === 'audio') {
      setup.inputAudioTranscription = {};
      setup.realtimeInputConfig = { automaticActivityDetection: { disabled: true }, activityHandling: 'NO_INTERRUPTION' };
    }
    ws.send(JSON.stringify({ setup }));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      msg = JSON.parse(raw);
    } catch { return; }
    gestisciMessaggio(s, ws, msg);
  });
  ws.addEventListener('error', (ev) => {
    console.warn(`[ASSISTENTE PM] ${s.idCalendar}: errore WebSocket Gemini (${(ev && ev.message) || 'connessione'})`);
  });
  ws.addEventListener('close', (ev) => {
    if (s.ws !== ws) return; // connessione già sostituita
    s.pronta = false;
    s.ws = null;
    s.attivitaAperta = false;
    // Risposta persa con la connessione: l'audio messo da parte resta in attesaAudio e parte
    // con la nuova connessione (setupComplete).
    if (s.attesaRisposta) { s.attesaRisposta = false; clearTimeout(s.timerRisposta); }
    if (s.chiusa) return;
    // Risposta interrotta: il testo in attesa resta in coda e riparte con la nuova connessione.
    if (s.inTurno) { s.inTurno = false; clearTimeout(s.timerTurno); }
    const motivo = ev.reason || `codice ${ev.code}`;
    console.warn(`[ASSISTENTE PM] ${s.idCalendar}: Gemini ${MODELLI[s.modelloIdx]} ha chiuso la connessione (${motivo})`);
    // Chiave non valida: nessun modello può funzionare.
    if (CHIAVE_RE.test(ev.reason || '')) {
      aggiungi(s, 'errore', `Gemini ha rifiutato la sessione: ${motivo}`);
      chiudi(s, false);
      return;
    }
    // Quota esaurita, sovraccarico o modello non disponibile: si passa al modello di riserva.
    s.riconnessioni++;
    if (RISERVA_RE.test(ev.reason || '') || ev.code === 1007 || ev.code === 1008 || s.riconnessioni > MAX_RICONNESSIONI) {
      if (passaAlModelloSuccessivo(s, motivo)) return;
      aggiungi(s, 'errore', `Gemini ha chiuso la sessione: ${motivo}. Nessun altro modello Live di riserva: assistente fermato.`);
      chiudi(s, false);
      return;
    }
    setTimeout(() => connetti(s), Math.min(1000 * s.riconnessioni, 5000));
  });
}

// Modello di riserva (GEMINI_LIVE_FALLBACK_MODEL): sessione nuova con le stesse istruzioni. Il
// contesto della conversazione non passa da un modello all'altro: si rimandano come contesto gli
// ultimi pezzi di riunione (senza chiedere una risposta). false = non ci sono altri modelli.
function passaAlModelloSuccessivo(s, motivo) {
  if (s.modelloIdx + 1 >= MODELLI.length) return false;
  const prima = MODELLI[s.modelloIdx];
  s.modelloIdx++;
  s.handle = null; // l'handle di ripresa vale solo per il modello che l'ha dato
  s.riconnessioni = 0;
  s.risposta = '';
  const ultimi = s.messaggi.filter((m) => m.tipo === 'trascrizione').slice(-CONTESTO_PEZZI).map((m) => m.testo);
  s.contestoRipresa = ultimi.length
    ? `Riprendi l'assistenza: la sessione precedente si è interrotta. Ecco gli ultimi pezzi della riunione, solo come contesto (non rispondere a questo messaggio):\n${ultimi.join('\n')}`
    : '';
  aggiungi(s, 'avviso', `${prima} non disponibile (${String(motivo).slice(0, 200)}): continuo con ${MODELLI[s.modelloIdx]}.`);
  setTimeout(() => connetti(s), 500);
  return true;
}

function gestisciMessaggio(s, ws, msg) {
  if (msg.setupComplete) {
    s.pronta = true;
    if (s.contestoRipresa) {
      try { ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: s.contestoRipresa }] }], turnComplete: false } })); } catch { /* si riparte senza */ }
      s.contestoRipresa = '';
    }
    if (!s.avviata) {
      s.avviata = true;
      aggiungi(s, 'info', s.modalita === 'audio'
        ? 'Assistente collegato in AUDIO LIVE: ascolta la riunione e ti suggerirà domande e punti da chiarire.'
        : 'Assistente collegato in modalità TESTO: ti suggerirà domande e punti da chiarire man mano che Projexa trascrive la riunione.');
    }
    // Audio arrivato mentre Gemini si collegava (o si ricollegava dopo «goAway»).
    for (const pcm of s.attesaAudio.splice(0)) inviaAudio(s, pcm);
    if (s.modalita === 'audio' && !s.timerAudio) s.timerAudio = setInterval(() => chiudiTurnoAudio(s), AUDIO_TURNO_MS);
    prossimo(s);
    return;
  }
  if (msg.sessionResumptionUpdate) {
    const u = msg.sessionResumptionUpdate;
    if (u.resumable && u.newHandle) s.handle = u.newHandle;
    return;
  }
  if (msg.goAway) {
    // Gemini sta per chiudere: si riapre subito con l'handle (close -> connetti).
    try { ws.close(); } catch { /* già chiusa */ }
    return;
  }
  const sc = msg.serverContent;
  if (!sc) return;
  if (MODALITA === 'TEXT' && sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
    for (const p of sc.modelTurn.parts) if (p && p.text && !p.thought) s.risposta += p.text;
  }
  if (sc.outputTranscription && sc.outputTranscription.text) s.risposta += sc.outputTranscription.text;
  // Audio live: testo di ciò che Gemini ha sentito, a frammenti; si mostra a frasi.
  if (sc.inputTranscription && sc.inputTranscription.text) {
    s.ascoltato += sc.inputTranscription.text;
    if (s.ascoltato.length > 300) scriviAscoltato(s, true);
  }
  if (sc.turnComplete || sc.interrupted) {
    scriviAscoltato(s);
    const testo = s.risposta.replace(/\s+\n/g, '\n').trim();
    s.risposta = '';
    s.valutazioni++;
    const libera = s.rispostaLibera;
    s.rispostaLibera = false;
    const scartata = !!testo && !SILENZIO_RE.test(testo) && !libera && !SUGGERIMENTO_RE.test(testo);
    const silenzio = !testo || SILENZIO_RE.test(testo) || scartata;
    if (scartata) console.log(`[ASSISTENTE PM] ${s.idCalendar}: risposta senza parola chiave scartata (${testo.length} caratteri)`);
    if (silenzio) s.silenzi++;
    else aggiungi(s, 'ai', testo);
    console.log(`[ASSISTENTE PM] ${s.idCalendar}: risposta ${s.valutazioni} (turni chiesti ${s.turniChiesti}) ${sc.interrupted ? 'interrotta' : 'completa'}, ${silenzio ? 'nessun suggerimento' : `suggerimento di ${testo.length} caratteri`}`);
    s.riconnessioni = 0;
    s.inTurno = false;
    clearTimeout(s.timerTurno);
    if (s.attesaRisposta) fineAttesaRisposta(s);
    prossimo(s);
  }
}

// soloFrasiFinite: si scrive fino all'ultima frase conclusa, il resto aspetta i frammenti dopo.
function scriviAscoltato(s, soloFrasiFinite = false) {
  let t = s.ascoltato;
  if (soloFrasiFinite) {
    const m = t.match(/^[\s\S]*[.?!…](?=\s|$)/);
    if (!m) return;
    t = m[0];
  }
  s.ascoltato = s.ascoltato.slice(t.length);
  t = t.replace(/\s+/g, ' ').trim();
  if (t) aggiungi(s, 'trascrizione', t);
}

// Fine del turno audio: Gemini valuta quanto ascoltato dall'ultimo turno (se c'è audio nuovo).
// Fino alla sua risposta (o ATTESA_RISPOSTA_MS) NON si apre un turno nuovo: aprirlo subito
// (il pezzo di audio successivo arriva dopo mezzo secondo) annullava quasi sempre la risposta
// in preparazione (prima prova reale 2026-10-13: 4 valutazioni in 35 minuti). L'audio che
// arriva intanto si tiene da parte e parte appena arriva la risposta: non si perde nulla.
function chiudiTurnoAudio(s) {
  if (s.chiusa || !s.pronta || !s.ws || !s.attivitaAperta || !s.audioNuovo || s.attesaRisposta) return;
  try {
    s.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    s.attivitaAperta = false;
    s.audioNuovo = false;
    s.attesaRisposta = true;
    s.turniChiesti++;
    s.timerRisposta = setTimeout(() => {
      if (!s.attesaRisposta) return;
      s.senzaRisposta++;
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: turno ${s.turniChiesti} senza risposta da Gemini dopo ${ATTESA_RISPOSTA_MS / 1000} s`);
      fineAttesaRisposta(s);
    }, ATTESA_RISPOSTA_MS);
  } catch { /* connessione in chiusura */ }
}

function fineAttesaRisposta(s) {
  s.attesaRisposta = false;
  clearTimeout(s.timerRisposta);
  for (const pcm of s.attesaAudio.splice(0)) inviaAudio(s, pcm);
}

// Audio live verso Gemini: PCM 16 bit mono 16 kHz in base64. Se la connessione non è pronta
// (avvio o riconnessione) o si aspetta la risposta al turno appena chiuso, si tengono gli
// ultimi pezzi e si inviano appena possibile.
function inviaAudio(s, pcmB64) {
  if (s.chiusa) return;
  if (!s.pronta || !s.ws || s.attesaRisposta) {
    s.attesaAudio.push(pcmB64);
    if (s.attesaAudio.length > MAX_ATTESA_AUDIO) s.attesaAudio.shift();
    return;
  }
  try {
    if (!s.attivitaAperta) {
      s.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      s.attivitaAperta = true;
    }
    s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcmB64, mimeType: 'audio/pcm;rate=16000' } } }));
    s.audioNuovo = true;
  } catch { /* connessione in chiusura: il pezzo si perde */ }
}

// Invia il prossimo testo in coda, uno alla volta: un nuovo messaggio a Gemini interrompe la
// risposta in corso, quindi si aspetta la fine del turno (o TURNO_TIMEOUT_MS).
// Elementi della coda: { testo, domanda } (domanda = scritta dall'utente: la risposta si mostra
// anche senza parola chiave, vedi SUGGERIMENTO_RE).
function prossimo(s) {
  if (s.chiusa || !s.pronta || s.inTurno || !s.coda.length || !s.ws) return;
  const voce = s.coda.shift();
  s.inTurno = true;
  s.risposta = '';
  s.rispostaLibera = !!voce.domanda;
  s.timerTurno = setTimeout(() => { s.inTurno = false; prossimo(s); }, TURNO_TIMEOUT_MS);
  try {
    s.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: voce.testo }] }], turnComplete: true } }));
  } catch (e) {
    s.coda.unshift(voce);
    s.inTurno = false;
    clearTimeout(s.timerTurno);
  }
}

function accoda(s, testo, { domanda = false } = {}) {
  s.coda.push({ testo, domanda });
  // Coda che cresce (Gemini lento): i blocchi di trascrizione in attesa si uniscono in uno.
  if (s.coda.length > 3) {
    s.coda.splice(0, s.coda.length, { testo: s.coda.map((v) => v.testo).join('\n\n'), domanda: s.coda.some((v) => v.domanda) });
  }
  prossimo(s);
}

function chiudi(s, rimuovi = true) {
  s.chiusa = true;
  if (!s.chiusaIl) s.chiusaIl = Date.now();
  clearTimeout(s.timerTurno);
  clearInterval(s.timerAudio);
  clearTimeout(s.timerRisposta);
  try { if (s.ws) s.ws.close(1000, 'fine riunione'); } catch { /* già chiusa */ }
  s.ws = null;
  if (rimuovi) sessioni.delete(s.chiave);
}

// Sessioni dimenticate aperte (pagina chiusa senza fermare la registrazione).
setInterval(() => {
  const limite = Date.now() - INATTIVA_MS;
  for (const s of sessioni.values()) {
    if (s.chiusa ? (s.chiusaIl || 0) < Date.now() - CONSERVA_MS : s.ultimoUso < limite) chiudi(s);
  }
}, 15 * 60000).unref();

function sessioneDi(req, idCalendar) {
  return sessioni.get(chiave(req.user, idCalendar)) || null;
}

const idDa = (v) => String(v || '').trim().slice(0, 300);

// ----------------------------------------------------------------------------
// ROTTE
// ----------------------------------------------------------------------------

// AI e chiave dell'utente; errore comprensibile se manca qualcosa.
async function aiUtente(user) {
  const conf = await leggiImpostazione(user);
  if (!conf.attiva) return null;
  const ai = AI_SUPPORTATE[conf.ai.toLowerCase()];
  if (!ai) throw errore(400, `Assistente PM: «${conf.ai}» non è ancora supportata (per ora solo Gemini)`);
  const el = await getIntegration(user.user_id, ai.provider);
  const apiKey = el[`${ai.prefix}_api_key`];
  if (!apiKey) throw errore(428, 'Assistente PM: collega la chiave API di Gemini in Impostazioni › AI');
  return { ai, apiKey };
}

// All'avvio della registrazione: assistente acceso? Se sì la finestra chiede la modalità.
// Risposta: { attiva:false } oppure { attiva, ai }.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const x = await aiUtente(req.user);
    res.json(x ? { attiva: true, ai: x.ai.provider } : { attiva: false });
  } catch (e) {
    if (!e.status) console.error('❌ [ASSISTENTE PM]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Avvio della sessione con la modalità scelta nella finestra.
// Body: { id_calendar, titolo, modalita: 'testo' | 'audio' }.
//   testo -> blocchi brevi trascritti da Projexa (POST /blocco), il testo va a Gemini;
//   audio -> audio live a Gemini (POST /audio), Gemini risponde in testo.
// Risposta: { attiva:false } (interruttore spento) oppure { attiva, ai, modello, modalita }.
router.post('/avvia', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = idDa(b.id_calendar);
    if (!idCalendar) throw errore(400, 'id_calendar richiesto');
    const modalita = b.modalita === 'audio' ? 'audio' : 'testo';
    const x = await aiUtente(req.user);
    if (!x) return res.json({ attiva: false });
    const { ai, apiKey } = x;

    const k = chiave(req.user, idCalendar);
    const vecchia = sessioni.get(k);
    if (vecchia) chiudi(vecchia); // registrazione ripresa: sessione nuova
    const s = {
      chiave: k, idCalendar, apiKey, modalita, handle: null, ws: null, pronta: false, avviata: false, chiusa: false,
      titolo: String(b.titolo || '').trim().slice(0, 200) || 'Riunione', creataIl: Date.now(), chiusaIl: 0,
      istruzioni: await istruzioni(req.user, idCalendar, String(b.titolo || '').slice(0, 200), modalita),
      coda: [], inTurno: false, risposta: '', ascoltato: '', attesaAudio: [], timerTurno: null, riconnessioni: 0,
      timerAudio: null, attivitaAperta: false, audioNuovo: false, valutazioni: 0, silenzi: 0, rispostaLibera: false,
      attesaRisposta: false, timerRisposta: null, turniChiesti: 0, senzaRisposta: 0,
      modelloIdx: 0, contestoRipresa: '',
      messaggi: [], seq: 0, ultimoUso: Date.now(), blocchi: Promise.resolve()
    };
    sessioni.set(k, s);
    aggiungi(s, 'info', 'Collegamento a Gemini Live…');
    connetti(s);
    res.json({ attiva: true, ai: ai.provider, modello: MODELLI[0], modalita });
  } catch (e) {
    if (!e.status) console.error('❌ [ASSISTENTE PM]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Blocco audio breve (8-15 s) solo per l'assistente: trascritto da Projexa, il testo va a
// Gemini. Body: { id_calendar, audio_mix (WAV base64), energy_mic, energy_system, names, offset_sec }.
// Risponde subito (202): la trascrizione prosegue in background, in ordine di arrivo.
router.post('/blocco', requireAuth, (req, res) => {
  const b = req.body || {};
  const s = sessioneDi(req, idDa(b.id_calendar));
  if (!s || s.chiusa) return res.status(404).json({ error: 'Assistente PM non attivo per questa riunione' });
  if (s.modalita !== 'testo') return res.status(409).json({ error: 'L\'assistente è in modalità audio live' });
  const audio = String(b.audio_mix || '');
  if (!audio) return res.status(400).json({ error: 'Audio mancante' });
  if (Math.floor(audio.length * 3 / 4) > MAX_AUDIO_BYTES) return res.status(413).json({ error: 'Blocco audio troppo grande' });
  const pulisci = (v) => (Array.isArray(v) ? v.slice(0, 200).map((x) => Math.max(0, Math.min(1, Number(x) || 0))) : null);
  const energy = {
    mic: pulisci(b.energy_mic),
    system: pulisci(b.energy_system),
    names: (Array.isArray(b.names) ? b.names : []).map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, 20)
  };
  const offset = Math.max(0, Number(b.offset_sec) || 0);
  const user = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, email: req.user.email };
  s.ultimoUso = Date.now();
  s.blocchi = s.blocchi.then(async () => {
    if (s.chiusa) return;
    try {
      const testo = await trascriviBloccoBreve(user, s.idCalendar, { audioB64: audio, energy, offset });
      if (!testo || s.chiusa) return;
      aggiungi(s, 'trascrizione', testo);
      accoda(s, `TRASCRIZIONE (nuovo pezzo della riunione):\n${testo}`);
    } catch (e) {
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: blocco non trascritto (${e.message})`);
      aggiungi(s, 'avviso', `Un pezzo di riunione non è stato trascritto per l'assistente (${e.message}).`);
    }
  });
  res.status(202).json({ ok: true });
});

// Audio live (modalità «audio»): un pezzo da ~0,5 s di PCM 16 bit mono 16 kHz.
// Body: { id_calendar, pcm (base64) }. Va subito a Gemini, nulla viene salvato.
router.post('/audio', requireAuth, (req, res) => {
  const b = req.body || {};
  const s = sessioneDi(req, idDa(b.id_calendar));
  if (!s || s.chiusa) return res.status(404).json({ error: 'Assistente PM non attivo per questa riunione' });
  if (s.modalita !== 'audio') return res.status(409).json({ error: 'L\'assistente è in modalità testo' });
  const pcm = String(b.pcm || '');
  if (!pcm || !/^[A-Za-z0-9+/=]+$/.test(pcm)) return res.status(400).json({ error: 'Audio mancante' });
  if (Math.floor(pcm.length * 3 / 4) > MAX_AUDIO_LIVE_BYTES) return res.status(413).json({ error: 'Pezzo audio troppo grande' });
  s.ultimoUso = Date.now();
  inviaAudio(s, pcm);
  res.status(204).end();
});

// Domanda scritta dall'utente nella finestra. Body: { id_calendar, testo, mostra }.
router.post('/chiedi', requireAuth, (req, res) => {
  const b = req.body || {};
  const s = sessioneDi(req, idDa(b.id_calendar));
  if (!s || s.chiusa) return res.status(404).json({ error: 'Assistente PM non attivo per questa riunione' });
  const testo = String(b.testo || '').trim().slice(0, 2000);
  if (!testo) return res.status(400).json({ error: 'Scrivi una domanda' });
  // mostra: testo breve per la finestra (pulsante «Suggerisci»), altrimenti la domanda stessa.
  aggiungi(s, 'utente', String(b.mostra || '').trim().slice(0, 200) || testo);
  accoda(s, `DOMANDA SCRITTA DA CHI TI USA (rispondi in modo diretto e breve):\n${testo}`, { domanda: true });
  res.json({ ok: true });
});

// Messaggi nuovi per la finestra. Query: id_calendar, dopo (ultimo n già mostrato).
router.get('/messaggi', requireAuth, (req, res) => {
  const s = sessioneDi(req, idDa(req.query.id_calendar));
  if (!s) return res.json({ attiva: false, messaggi: [] });
  const dopo = Number(req.query.dopo) || 0;
  s.ultimoUso = Date.now();
  res.json({
    attiva: !s.chiusa,
    modalita: s.modalita,
    titolo: s.titolo,
    collegata: s.pronta,
    inAttesa: s.inTurno || s.coda.length > 0,
    // Quante volte Gemini ha valutato la riunione e quante senza suggerimenti (per la finestra).
    valutazioni: s.valutazioni,
    silenzi: s.silenzi,
    turniChiesti: s.turniChiesti,
    senzaRisposta: s.senzaRisposta,
    messaggi: s.messaggi.filter((m) => m.n > dopo)
  });
});

// Fine registrazione (o chiusura della finestra). Body: { id_calendar }.
// La sessione si chiude con Gemini ma i messaggi restano CONSERVA_MS (export in Word dalla
// finestra rimasta aperta dopo «Ferma»).
router.post('/ferma', requireAuth, (req, res) => {
  const s = sessioneDi(req, idDa((req.body || {}).id_calendar));
  if (s && !s.chiusa) chiudi(s, false);
  res.json({ ok: true });
});

// Export in Word: prima i suggerimenti (con le domande scritte e le risposte), poi la
// trascrizione live. Query: id_calendar. Funziona durante la sessione e fino a CONSERVA_MS
// dopo «Ferma».
router.get('/export', requireAuth, async (req, res) => {
  try {
    const s = sessioneDi(req, idDa(req.query.id_calendar));
    if (!s) return res.status(404).json({ error: 'Sessione dell\'assistente non più disponibile (i messaggi restano 2 ore dopo la fine della registrazione)' });
    const ora = (iso) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    const riga = (m, chi) => new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: `${ora(m.ora)}${chi ? ` · ${chi}` : ''}  `, bold: true, color: '6B7280' }),
        ...String(m.testo).split('\n').flatMap((t, i) => (i ? [new TextRun({ text: t, break: 1 })] : [new TextRun({ text: t })]))]
    });
    const suggerimenti = s.messaggi.filter((m) => m.tipo === 'ai' || m.tipo === 'utente');
    const trascrizione = s.messaggi.filter((m) => m.tipo === 'trascrizione');
    const vuoto = (t) => new Paragraph({ children: [new TextRun({ text: t, italics: true, color: '6B7280' })] });
    const giorno = new Date(s.creataIl).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
    const children = [
      new Paragraph({ text: `Assistente PM – ${s.titolo}`, heading: HeadingLevel.TITLE }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun({
        text: `Riunione del ${giorno} · ${s.modalita === 'audio' ? 'Audio live' : 'Testo'} · ${MODELLI[s.modelloIdx]}`, color: '6B7280' })] }),
      new Paragraph({ text: 'Suggerimenti dell\'assistente', heading: HeadingLevel.HEADING_1 }),
      ...(suggerimenti.length ? suggerimenti.map((m) => riga(m, m.tipo === 'utente' ? 'Tu' : 'Assistente')) : [vuoto('Nessun suggerimento.')]),
      new Paragraph({ text: 'Trascrizione live', heading: HeadingLevel.HEADING_1, spacing: { before: 360 } }),
      new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ italics: true, color: '6B7280', text: s.modalita === 'audio'
        ? 'Testo di ciò che Gemini ha sentito (non è la trascrizione ufficiale della riunione).'
        : 'Pezzi di riunione trascritti da Projexa per l\'assistente (non è la trascrizione ufficiale della riunione).' })] }),
      ...(trascrizione.length ? trascrizione.map((m) => riga(m, '')) : [vuoto('Nessun testo.')])
    ];
    const buf = await Packer.toBuffer(new Document({ creator: 'Projexa', title: `Assistente PM – ${s.titolo}`, sections: [{ children }] }));
    const nome = `Assistente PM - ${s.titolo} - ${giorno.replace(/\//g, '-')}.docx`.replace(/[\\/:*?"<>|]+/g, ' ');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="assistente-pm.docx"; filename*=UTF-8''${encodeURIComponent(nome)}`);
    res.send(buf);
  } catch (e) {
    console.error('❌ [ASSISTENTE PM] export:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
