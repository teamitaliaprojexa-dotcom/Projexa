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
//
// VOCE «PROJEXA» (2026-10-20): al posto di Gemini l'agente «Pm projexa» su Ollama della VM
// (gratuito, nessuna chiave). Solo modalità TESTO (Ollama non ascolta audio). Istruzioni nel
// prompt PM_PROJEXA (backend/prompts/pm_projexa.txt), scritte sul modo di condurre le call
// dell'utente. Su CPU il modello è lento: si valuta un tratto di riunione alla volta
// (OLLAMA_PM_BLOCCHI blocchi da ~10 s, di norma un minuto di parlato) e la conversazione
// cresce in coda, così Ollama rilegge solo il pezzo nuovo (cache del prompt di llama.cpp).
// ============================================================================
import express from 'express';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegration } from '../config/integrations.js';
import { getPromptFor } from '../config/prompts.js';
import { speakerName, trascriviBloccoBreve } from '../jobs/meetingTranscription.js';
import { contestoProgetto, dataIt, oggiIso } from '../config/pmCore.js';
import { ollamaPost } from './ai.js';

const router = express.Router();

const CAMPO = 'ai assistente pm';
// Campo booleano (creato dall'utente 2026-10-13): export Word automatico a «Ferma».
const CAMPO_DOWNLOAD = 'download automatico file ass pm ai';
// Campo a tendina (creato dall'utente 2026-10-14): modalità scelta in automatico (modalitaImpostata).
const CAMPO_ESECUZIONE = 'esecuzione assistente pm';
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
// AI gestite dall'Assistente PM (voci dell'elenco del campo). locale = Ollama della VM, senza
// chiave API e solo in modalità testo.
const AI_SUPPORTATE = {
  gemini: { provider: 'Gemini', prefix: 'gemini', prompt: 'ASSISTENTE_PM' },
  projexa: { provider: 'Projexa', locale: true, prompt: 'PM_PROJEXA' }
};

// --- Pm projexa (Ollama) ---
const OLLAMA_PM_URL = String(process.env.ASSISTENTE_PM_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_PM_MODEL = process.env.OLLAMA_PM_MODEL || 'pm-projexa';
// Modello di riserva se pm-projexa non è stato creato sulla VM (stessi pesi, stessi parametri).
const OLLAMA_PM_RISERVA = process.env.OLLAMA_RECAP_MODEL || 'qwen2.5:7b';
// Contesto FISSO: cambiarlo tra una richiesta e l'altra fa ricaricare il modello e perdere la
// cache delle istruzioni già lette.
const OLLAMA_PM_CTX = 8192;
// Core usati da Ollama (VM con 4 core): durante una call ne resta almeno uno a Whisper (prova
// 2026-10-20: con Ollama su tutti i core la trascrizione per l'assistente arrivava a 1 pezzo ogni
// 2 minuti e quella della riunione restava indietro).
const OLLAMA_PM_THREADS = Math.max(1, Number(process.env.OLLAMA_PM_THREADS) || 3);
// Modelli tenuti caricati dopo l'ultima richiesta: con le istruzioni fisse, la call successiva
// le trova già lette (il 14B occupa ~11 GB di RAM finché resta caricato).
const OLLAMA_PM_KEEP_ALIVE = process.env.OLLAMA_PM_KEEP_ALIVE || '4h';
const OLLAMA_PM_OPZIONI = { num_thread: OLLAMA_PM_THREADS, num_ctx: OLLAMA_PM_CTX, temperature: 0.2, top_p: 0.9, repeat_penalty: 1.1, num_predict: 90 };
// num_predict 90: si tiene un solo suggerimento (~40 token); il secondo che il modello scrive
// comunque costava ~7 s di scrittura sulla VM (~5 token/s).
// Blocchi minimi per valutazione. Con Projexa la finestra manda blocchi da ~25 s (Whisper
// elabora comunque finestre da 30 s: blocchi da 10 s costavano lo stesso e sulla VM
// arrivavano uno al minuto). Misura 2026-10-20: un turno ~20 s grazie alla cache, quindi si
// valuta ogni blocco; se Ollama è occupato i blocchi arrivati intanto si uniscono.
const OLLAMA_PM_BLOCCHI = Math.max(1, Number(process.env.OLLAMA_PM_BLOCCHI) || 1);
const OLLAMA_PM_PAUSA_MS = 90000;        // tratto incompleto ma fermo da tanto: si valuta lo stesso
const OLLAMA_PM_TIMEOUT_MS = 10 * 60000; // una risposta (la prima legge anche le istruzioni)
// Dati del progetto nelle istruzioni: su CPU ogni carattere va letto (~2,5 caratteri/token,
// ~10-20 token/s), quindi molti meno che per Gemini.
const OLLAMA_PM_MAX_DATI = 3000;
// Conversazione tenuta per il contesto (caratteri, istruzioni escluse; ~8 minuti di parlato):
// oltre si riparte da un riepilogo (vedi prossimoOllama). Istruzioni + dati + conversazione
// devono stare in OLLAMA_PM_CTX token (~2,5 caratteri/token).
const OLLAMA_PM_STORIA_CHARS = 6000;
// Tratto nuovo al massimo (caratteri, si tiene la parte più recente): dopo il preriscaldamento
// o una pausa di Ollama possono essersi accumulati molti blocchi.
const OLLAMA_PM_TRATTO_CHARS = 3000;
// Filtro a due stadi (2026-10-20): un modello piccolo e veloce legge ogni pezzo e risponde solo
// «SI n» / «NO» (prompt PM_PROJEXA_FILTRO); il modello grande (pm-projexa, da 14B) scrive il
// suggerimento solo dopo un SI, così la VM lavora molto meno. Vuota/«nessuno» = niente filtro.
// Sulla VM i due modelli devono restare caricati insieme: OLLAMA_MAX_LOADED_MODELS=2.
const OLLAMA_PM_FILTRO_MODEL = (() => {
  const v = String(process.env.OLLAMA_PM_FILTRO_MODEL ?? 'qwen2.5:3b').trim();
  return /^(|nessuno|none|off)$/i.test(v) ? '' : v;
})();
// Contesto fisso anche qui (cache del prompt): istruzioni brevi + pezzo precedente + nuovo.
const OLLAMA_PM_FILTRO_OPZIONI = { num_thread: OLLAMA_PM_THREADS, num_ctx: 4096, temperature: 0, num_predict: 6 };
// «SI n», «NO» oppure solo «n» (il 3B a volte scrive solo il numero del segnale = SI).
const FILTRO_RE = /^\W*(SI|SÌ|NO|(?=\d))(?![a-zà-ú])\s*\[?\s*(\d{1,2})?/i;
// Una richiesta alla volta verso Ollama (sulla VM gira 1 richiesta per volta comunque).
let codaOllama = Promise.resolve();
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
const MAX_SESSIONI_UTENTE = 2;   // sessioni Gemini Live aperte contemporaneamente per utente
const MAX_BLOCCHI_IN_CODA = 6;   // blocchi audio in attesa di trascrizione per sessione
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
async function datiRiunione(user, idCalendar, titolo, maxDati = MAX_DATI) {
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
      dati = ctx.testo.slice(0, maxDati);
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

// ai: voce di AI_SUPPORTATE (prompt da usare; locale = meno dati del progetto).
async function istruzioni(user, idCalendar, titolo, modalita, ai) {
  const { riunione, dati } = await datiRiunione(user, idCalendar, titolo, ai.locale ? OLLAMA_PM_MAX_DATI : MAX_DATI);
  const utente = String(await speakerName(user) || '').trim() || user.email || '';
  const vars = { UTENTE: utente, RIUNIONE: riunione, DATA: dataIt(oggiIso()), DATI: dati, INGRESSO: INGRESSO[modalita] };
  let tpl = (await getPromptFor(ai.prompt, user)).testo;
  if (!tpl.includes('{{INGRESSO}}')) tpl = `{{INGRESSO}}\n${tpl}`;
  if (ai.locale) {
    // Pm projexa: istruzioni IDENTICHE per tutte le riunioni (riunione, data e dati del progetto
    // tolti), così Ollama le tiene già lette da una call all'altra (cache del prompt, modello
    // tenuto caricato). Prova reale 2026-10-20: rilette a ogni call durante la registrazione
    // richiedevano 536 s. Riunione e dati vanno nel primo messaggio della conversazione.
    const fissi = { ...vars, RIUNIONE: '', DATA: '(vedi il primo messaggio)', DATI: '(nel primo messaggio della conversazione)' };
    return {
      sistema: tpl.replace(/\{\{(UTENTE|RIUNIONE|DATA|DATI|INGRESSO)\}\}/g, (x, k) => fissi[k]),
      contesto: `CONTESTO DI QUESTA RIUNIONE (solo informazioni, non rispondere a questo messaggio):\nRiunione${riunione}, oggi ${vars.DATA}.\n\nDATI DEL PROGETTO\n${dati}`
    };
  }
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

// --- Diagnostica dei blocchi di Gemini (2026-10-15) ---
// Gemini a volte smette di rispondere senza chiudere la connessione e senza errori. Per capire
// quando succede si annota cosa arriva da Gemini (tipi di messaggio, token del contesto, ora
// dell'ultimo messaggio) e lo si scrive nel log a ogni turno senza risposta e a ogni risposta.
function notaDiagnostica(s, msg) {
  const d = s.diag;
  d.ultimoMsg = Date.now();
  const tipi = Object.keys(msg);
  if (msg.serverContent) tipi.push(...Object.keys(msg.serverContent).map((k) => `serverContent.${k}`));
  for (const t of tipi) d.tipi[t] = (d.tipi[t] || 0) + 1;
  const u = msg.usageMetadata;
  if (u && Number.isFinite(Number(u.totalTokenCount))) d.token = Number(u.totalTokenCount);
  if (msg.goAway) console.warn(`[ASSISTENTE PM] ${s.idCalendar}: goAway da Gemini (timeLeft ${msg.goAway.timeLeft || '?'}) dopo ${secondiDa(d.connessaIl)} s di connessione`);
}
const secondiDa = (t) => (t ? Math.round((Date.now() - t) / 1000) : '?');
// Riga di stato per il log; azzera i tipi di messaggio contati (si riparte dal turno dopo).
function rigaDiagnostica(s) {
  const d = s.diag;
  const tipi = Object.entries(d.tipi).map(([k, n]) => `${k}×${n}`).join(', ') || 'nessuno';
  d.tipi = {};
  return `connessione n.${d.connessioni} aperta da ${secondiDa(d.connessaIl)} s · ultimo messaggio da Gemini ${secondiDa(d.ultimoMsg)} s fa · token contesto ${d.token ?? '?'} · ws ${s.ws ? s.ws.readyState : '-'} · ricevuti dal turno prima: ${tipi}`;
}

function connetti(s) {
  if (s.chiusa) return;
  s.pronta = false;
  const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(s.apiKey)}`);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  s.diag.connessioni++;
  s.diag.connessaIl = Date.now();
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
    if (s.ws !== ws) return; // connessione abbandonata (sbloccaGemini): risposte in ritardo ignorate
    notaDiagnostica(s, msg);
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
  s.contestoRipresa = contestoUltimiPezzi(s);
  aggiungi(s, 'avviso', `${prima} non disponibile (${String(motivo).slice(0, 200)}): continuo con ${MODELLI[s.modelloIdx]}.`);
  setTimeout(() => connetti(s), 500);
  return true;
}

// Ultimi pezzi di riunione da rimandare come contesto a una sessione Gemini nuova.
function contestoUltimiPezzi(s) {
  const ultimi = s.messaggi.filter((m) => m.tipo === 'trascrizione').slice(-CONTESTO_PEZZI).map((m) => m.testo);
  return ultimi.length
    ? `Riprendi l'assistenza: la sessione precedente si è interrotta. Ecco gli ultimi pezzi della riunione, solo come contesto (non rispondere a questo messaggio):\n${ultimi.join('\n')}`
    : '';
}

// Gemini «appeso»: la connessione resta aperta ma non risponde più a nessun turno (né manda la
// trascrizione di ciò che sente). Caso reale 2026-10-14: dopo 3 risposte, 54 turni di fila senza
// risposta per tutta la riunione, senza che la connessione si chiudesse. Dopo SBLOCCO_TURNI turni
// di fila senza risposta si riapre la connessione: la prima volta riprendendo la stessa sessione
// (handle, contesto intatto), poi con una sessione nuova (ultimi pezzi come contesto); se non
// basta ancora si prova il modello di riserva.
const SBLOCCO_TURNI = 2;
function sbloccaGemini(s) {
  if (s.chiusa) return;
  s.senzaRispostaDiFila = 0;
  s.sblocchi++;
  if (s.sblocchi > 3 && passaAlModelloSuccessivo(s, 'nessuna risposta da diversi minuti')) {
    staccaConnessione(s);
    return;
  }
  const nuova = s.sblocchi > 1;
  console.warn(`[ASSISTENTE PM] ${s.idCalendar}: Gemini non risponde da ${SBLOCCO_TURNI} turni, riconnessione ${nuova ? 'con sessione nuova' : 'con ripresa della sessione'} (tentativo ${s.sblocchi})`);
  staccaConnessione(s);
  if (nuova) { s.handle = null; s.contestoRipresa = contestoUltimiPezzi(s); }
  aggiungi(s, 'avviso', 'Gemini non rispondeva più: mi ricollego (l\'ascolto continua).');
  setTimeout(() => connetti(s), 300);
}

// Abbandona la connessione attuale senza passare dal suo «close» (che aspetterebbe la risposta
// di una connessione appesa): lo stato del turno si azzera, l'audio in attesa resta da inviare.
function staccaConnessione(s) {
  const vecchia = s.ws;
  s.ws = null;
  s.pronta = false;
  s.attivitaAperta = false;
  s.risposta = '';
  if (s.attesaRisposta) { s.attesaRisposta = false; clearTimeout(s.timerRisposta); }
  if (s.inTurno) { s.inTurno = false; clearTimeout(s.timerTurno); }
  try { if (vecchia) vecchia.close(1000, 'riconnessione'); } catch { /* già chiusa */ }
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
    console.log(`[ASSISTENTE PM] ${s.idCalendar}: risposta ${s.valutazioni} (turni chiesti ${s.turniChiesti}) ${sc.interrupted ? 'interrotta' : 'completa'}, ${silenzio ? 'nessun suggerimento' : `suggerimento di ${testo.length} caratteri`} · token contesto ${s.diag.token ?? '?'} · connessione n.${s.diag.connessioni} da ${secondiDa(s.diag.connessaIl)} s`);
    s.diag.tipi = {};
    s.riconnessioni = 0;
    s.senzaRispostaDiFila = 0;
    s.sblocchi = 0;
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
      s.senzaRispostaDiFila++;
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: turno ${s.turniChiesti} senza risposta da Gemini dopo ${ATTESA_RISPOSTA_MS / 1000} s · ${rigaDiagnostica(s)}`);
      if (s.senzaRispostaDiFila >= SBLOCCO_TURNI) { sbloccaGemini(s); return; }
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
  if (s.motore === 'projexa') { prossimoOllama(s); return; }
  if (s.chiusa || !s.pronta || s.inTurno || !s.coda.length || !s.ws) return;
  const voce = s.coda.shift();
  s.inTurno = true;
  s.risposta = '';
  s.rispostaLibera = !!voce.domanda;
  s.timerTurno = setTimeout(() => {
    s.inTurno = false;
    // Modalità Testo: stesso controllo di Gemini «appeso» dell'audio live.
    if (++s.senzaRispostaDiFila >= SBLOCCO_TURNI) { sbloccaGemini(s); return; }
    prossimo(s);
  }, TURNO_TIMEOUT_MS);
  try {
    s.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: voce.testo }] }], turnComplete: true } }));
  } catch (e) {
    s.coda.unshift(voce);
    s.inTurno = false;
    clearTimeout(s.timerTurno);
  }
}

// ----------------------------------------------------------------------------
// PM PROJEXA (Ollama della VM)
// ----------------------------------------------------------------------------
// La conversazione con Ollama è [istruzioni, tratto 1, risposta 1, tratto 2, ...]: ogni
// richiesta ripete la precedente e aggiunge il tratto nuovo, così llama.cpp riusa la parte già
// letta (prefisso identico) e legge solo il nuovo. Le istruzioni (~3.000 token) si leggono una
// volta all'avvio (preriscaldamento), mentre la riunione comincia.

// POST /api/chat; se il modello pm-projexa non esiste sulla VM si passa a quello di riserva.
// filtro = chiamata al modello piccolo (OLLAMA_PM_FILTRO_MODEL), con le sue opzioni.
async function chiamaOllama(s, messages, opzioni = {}, { filtro = false } = {}) {
  if (filtro) {
    const r = await ollamaPost(`${OLLAMA_PM_URL}/api/chat`, { model: OLLAMA_PM_FILTRO_MODEL, messages, stream: false, keep_alive: OLLAMA_PM_KEEP_ALIVE, options: OLLAMA_PM_FILTRO_OPZIONI }, OLLAMA_PM_TIMEOUT_MS);
    if (!r.ok) throw new Error((r.data && r.data.error) || `Ollama: errore ${r.status}`);
    const d = r.data || {};
    return { testo: String((d.message && d.message.content) || '').trim(), letti: Number(d.prompt_eval_count) || 0, secondi: Math.round((Number(d.total_duration) || 0) / 1e9) };
  }
  const corpo = () => ({ model: s.modelloOllama, messages, stream: false, keep_alive: OLLAMA_PM_KEEP_ALIVE, options: { ...OLLAMA_PM_OPZIONI, ...opzioni } });
  let r = await ollamaPost(`${OLLAMA_PM_URL}/api/chat`, corpo(), OLLAMA_PM_TIMEOUT_MS);
  if (r.status === 404 && /not found|pull/i.test(String((r.data && r.data.error) || '')) && s.modelloOllama !== OLLAMA_PM_RISERVA) {
    console.warn(`[ASSISTENTE PM] ${s.idCalendar}: modello ${s.modelloOllama} assente su Ollama, uso ${OLLAMA_PM_RISERVA}`);
    s.modelloOllama = OLLAMA_PM_RISERVA;
    r = await ollamaPost(`${OLLAMA_PM_URL}/api/chat`, corpo(), OLLAMA_PM_TIMEOUT_MS);
  }
  if (!r.ok) throw new Error((r.data && r.data.error) || `Ollama: errore ${r.status}`);
  const d = r.data || {};
  return {
    testo: String((d.message && d.message.content) || '').trim(),
    letti: Number(d.prompt_eval_count) || 0,
    scritti: Number(d.eval_count) || 0,
    secondi: Math.round((Number(d.total_duration) || 0) / 1e9)
  };
}

// Messaggio di errore comprensibile (Ollama spento, tunnel chiuso in locale, timeout).
function erroreOllama(e) {
  if (e && e.name === 'TimeoutError') return 'Pm projexa non ha risposto in tempo (la VM è occupata?)';
  if (e && /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND/.test(String(e.code || e.message))) return 'Pm projexa non raggiungibile: Ollama spento o tunnel chiuso';
  return `Pm projexa: ${String((e && e.message) || e).slice(0, 200)}`;
}

// Le istruzioni lette subito, prima che arrivi il primo tratto di riunione.
function preriscaldaOllama(s) {
  s.inTurno = true;
  const inizio = Date.now();
  codaOllama = codaOllama.then(async () => {
    if (s.chiusa) return;
    try {
      // Istruzioni (di solito già in cache da una call precedente) + contesto della riunione.
      const r = await chiamaOllama(s, [{ role: 'system', content: s.istruzioni }, s.storia[0]], { num_predict: 8 });
      console.log(`[ASSISTENTE PM] ${s.idCalendar}: Pm projexa pronto (${s.modelloOllama}, ${r.letti} token di istruzioni letti in ${r.secondi} s)`);
      // Anche il filtro legge subito le sue istruzioni (brevi).
      if (OLLAMA_PM_FILTRO_MODEL && s.istruzioniFiltro && !s.chiusa) {
        try {
          const f = await chiamaOllama(s, [{ role: 'system', content: s.istruzioniFiltro }, { role: 'user', content: 'PEZZO PRECEDENTE (solo contesto):\n(inizio riunione)\n\nPEZZO NUOVO:\nBuongiorno a tutti.' }], {}, { filtro: true });
          console.log(`[ASSISTENTE PM] ${s.idCalendar}: filtro ${OLLAMA_PM_FILTRO_MODEL} pronto (${f.letti} token in ${f.secondi} s)`);
        } catch (e) {
          console.warn(`[ASSISTENTE PM] ${s.idCalendar}: filtro ${OLLAMA_PM_FILTRO_MODEL} non disponibile (${e.message}): lavorerà solo il modello grande`);
        }
      }
      if (!s.chiusa) aggiungi(s, 'info', `Pm projexa pronto (istruzioni lette in ${Math.round((Date.now() - inizio) / 1000)} s): ti suggerirà domande e punti da chiarire man mano che Projexa trascrive la riunione.`);
    } catch (e) {
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: preriscaldamento Pm projexa fallito (${e.message})`);
      if (!s.chiusa) aggiungi(s, 'avviso', `${erroreOllama(e)}. Riprovo al primo tratto di riunione.`);
    } finally {
      s.inTurno = false;
      prossimo(s);
    }
  });
}

// Suggerimento tenuto (al massimo uno per tratto, prova del 2026-10-20: il 7B ne scriveva due
// generici per ogni pezzo): deve iniziare con parola chiave + numero del segnale del prompt
// («DOMANDA [4]: ...»), citare qualcosa del tratto appena detto (ancoraggio: almeno una parola
// significativa in comune) e non ripetere quelli già dati. Le risposte alle domande scritte si
// mostrano intere.
const SEGNALE_RE = /^(DOMANDA|RISCHIO|CR|ATTENZIONE|AGENDA)\s*\[\s*(\d{1,2})\s*\]\s*:\s*(.{10,})$/i;
const VUOTE = new Set(['della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'sulla', 'sulle', 'questo', 'questa', 'quello', 'quella', 'sono', 'anche', 'perché', 'quindi', 'allora', 'chiedi', 'fatti', 'conferma', 'confermare', 'proponi', 'partecipanti', 'entro', 'quando', 'tutti', 'sempre', 'ancora', 'fare', 'essere']);
const parole = (t) => new Set(String(t).toLowerCase().replace(/[^a-zà-ú0-9 ]+/gi, ' ').split(/\s+/).filter((w) => w.length > 3));
function ancorato(sugg, tratto) {
  const T = parole(tratto);
  for (const w of parole(sugg)) if (w.length >= 5 && !VUOTE.has(w) && T.has(w)) return true;
  return false;
}
function simile(a, b) {
  const A = parole(a), B = parole(b);
  if (!A.size || !B.size) return false;
  let comuni = 0;
  for (const w of A) if (B.has(w)) comuni++;
  return comuni / Math.min(A.size, B.size) >= 0.7;
}
function suggerimentiDa(s, testo, tratto) {
  // Più suggerimenti sulla stessa riga: si spezza davanti a ogni parola chiave.
  const pezzi = String(testo).replace(/\*\*/g, '')
    .split(/\n|(?=\b(?:DOMANDA|RISCHIO|CR|ATTENZIONE|AGENDA)\s*(?:\[\s*\d{1,2}\s*\])?\s*:)/)
    .map((r) => r.replace(/^[\s\-*•\d.)]+(?=[A-Z])/, '').trim()).filter(Boolean);
  for (const p of pezzi) {
    const m = p.match(SEGNALE_RE);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 13) continue;
    const r = `${m[1].toUpperCase()}: ${m[3].trim()}`;
    if (!ancorato(r, tratto)) { console.log(`[ASSISTENTE PM] ${s.idCalendar}: Pm projexa, suggerimento non legato al tratto scartato: ${r.slice(0, 120)}`); continue; }
    if (s.giaDetti.some((g) => simile(g, r))) continue;
    // Nella conversazione resta col numero del segnale, così il modello mantiene il formato.
    s.ultimaRisposta = `${m[1].toUpperCase()} [${Number(m[2])}]: ${m[3].trim()}`;
    return [r];
  }
  return [];
}

// Tratto e risposta in coda alla conversazione del modello grande. Conversazione troppo lunga:
// si riparte da un riepilogo breve + l'ultimo tratto. Togliere solo i tratti più vecchi
// cambierebbe tutto ciò che segue le istruzioni e Ollama dovrebbe rileggerlo (minuti sulla VM);
// così resta in cache il prefisso delle istruzioni e si legge solo il riepilogo.
function ricorda(s, testo, risposta) {
  s.storia.push({ role: 'user', content: testo }, { role: 'assistant', content: risposta });
  if (s.storia.reduce((n, m) => n + m.content.length, 0) > OLLAMA_PM_STORIA_CHARS) {
    const contesto = s.storia.slice(0, 2); // contesto della riunione: resta sempre in testa
    const ultimi = s.storia.slice(-2);
    const detti = s.giaDetti.slice(-10);
    s.storia = [
      ...contesto,
      { role: 'user', content: `RIEPILOGO: la prima parte della riunione è già stata valutata.${detti.length ? `\nSuggerimenti già dati (non ripeterli):\n${detti.join('\n')}` : ''}` },
      { role: 'assistant', content: 'Nessun suggerimento.' },
      ...ultimi
    ];
  }
}

function prossimoOllama(s) {
  if (s.chiusa || s.inTurno || !s.coda.length) return;
  const domanda = s.coda.some((v) => v.domanda);
  const blocchi = s.coda.filter((v) => !v.domanda).length;
  // Si valuta un tratto intero (OLLAMA_PM_BLOCCHI blocchi), oppure subito se c'è una domanda
  // scritta, oppure se il tratto è fermo da tempo (pausa nella riunione).
  const fermoDa = Date.now() - (s.coda[0].il || Date.now());
  if (!domanda && blocchi < OLLAMA_PM_BLOCCHI && fermoDa < OLLAMA_PM_PAUSA_MS) {
    clearTimeout(s.timerTratto);
    s.timerTratto = setTimeout(() => prossimo(s), OLLAMA_PM_PAUSA_MS - fermoDa + 500);
    return;
  }
  clearTimeout(s.timerTratto);
  const voci = s.coda.splice(0);
  let trascr = voci.filter((v) => !v.domanda).map((v) => v.testo).join('\n');
  if (trascr.length > OLLAMA_PM_TRATTO_CHARS) trascr = `[…] ${trascr.slice(-OLLAMA_PM_TRATTO_CHARS).replace(/^[^\n]*\n/, '')}`;
  const domande = voci.filter((v) => v.domanda).map((v) => v.testo).join('\n');
  const testo = [trascr && `TRASCRIZIONE (nuovo tratto della riunione):\n${trascr}`,
    domande && `DOMANDA SCRITTA DA CHI TI USA (rispondi in modo diretto e breve):\n${domande}`].filter(Boolean).join('\n\n');
  s.inTurno = true;
  s.turniChiesti++;
  codaOllama = codaOllama.then(async () => {
    if (s.chiusa) return;
    try {
      // Primo stadio: il modello piccolo dice se nel pezzo c'è un segnale. NO = il modello
      // grande non lavora; il pezzo resta comunque nella conversazione come contesto. Filtro in
      // errore o risposta incomprensibile = si passa al modello grande (meglio lento che cieco).
      if (OLLAMA_PM_FILTRO_MODEL && s.istruzioniFiltro && trascr && !domande) {
        let esito = null;
        try {
          const f = await chiamaOllama(s, [{ role: 'system', content: s.istruzioniFiltro },
            { role: 'user', content: `PEZZO PRECEDENTE (solo contesto):\n${s.trattoPrec || '(inizio riunione)'}\n\nPEZZO NUOVO:\n${trascr}` }], {}, { filtro: true });
          const m = f.testo.match(FILTRO_RE);
          esito = m ? { si: !/^no$/i.test(m[1]), n: Number(m[2]) || 0, secondi: f.secondi } : null;
          if (!m) console.log(`[ASSISTENTE PM] ${s.idCalendar}: filtro, risposta non riconosciuta «${f.testo.slice(0, 40)}»: passo al modello grande`);
        } catch (e) {
          console.warn(`[ASSISTENTE PM] ${s.idCalendar}: filtro ${OLLAMA_PM_FILTRO_MODEL} non disponibile (${e.message}): passo al modello grande`);
        }
        s.trattoPrec = trascr.slice(-1500);
        if (s.chiusa) return;
        if (esito && !esito.si) {
          s.valutazioni++;
          s.silenzi++;
          s.filtrati++;
          s.errori = 0;
          ricorda(s, testo, 'Nessun suggerimento.');
          console.log(`[ASSISTENTE PM] ${s.idCalendar}: Pm projexa valutazione ${s.valutazioni} · filtro: nessun segnale (${esito.secondi} s)`);
          return;
        }
        if (esito) console.log(`[ASSISTENTE PM] ${s.idCalendar}: filtro: possibile segnale ${esito.n || '?'} (${esito.secondi} s), scrive ${s.modelloOllama}`);
      }
      const messages = [{ role: 'system', content: s.istruzioni }, ...s.storia, { role: 'user', content: testo }];
      // Si tiene un solo suggerimento: ci si ferma a fine riga (il 14B scrive ~2,3 token/s, il
      // secondo suggerimento costava ~15 s). Le risposte alle domande scritte restano intere.
      const r = await chiamaOllama(s, messages, domande ? {} : { stop: ['\n'] });
      if (s.chiusa) return;
      s.valutazioni++;
      s.errori = 0;
      s.ultimaRisposta = '';
      const tenute = domande ? (r.testo && !SILENZIO_RE.test(r.testo) ? [r.testo.replace(/\*\*/g, '')] : []) : suggerimentiDa(s, r.testo, trascr);
      if (tenute.length) for (const t of tenute) { aggiungi(s, 'ai', t); if (!domande) s.giaDetti.push(t); }
      else s.silenzi++;
      if (s.giaDetti.length > 30) s.giaDetti.splice(0, s.giaDetti.length - 30);
      // Nella conversazione resta la risposta pulita: il modello vede cosa ha già suggerito.
      ricorda(s, testo, (domande ? tenute.join('\n') : s.ultimaRisposta) || 'Nessun suggerimento.');
      console.log(`[ASSISTENTE PM] ${s.idCalendar}: Pm projexa valutazione ${s.valutazioni} · ${r.letti} token letti, ${r.scritti} scritti in ${r.secondi} s · ${tenute.length ? `${tenute.length} suggerimenti` : 'nessun suggerimento'}`);
    } catch (e) {
      s.senzaRisposta++;
      s.errori = (s.errori || 0) + 1;
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: Pm projexa senza risposta (${e.message})`);
      // Un avviso alla prima volta di fila, non a ogni tratto.
      if (s.errori === 1 && !s.chiusa) aggiungi(s, 'avviso', `${erroreOllama(e)}: questo tratto di riunione è stato saltato, riprovo con il prossimo.`);
    } finally {
      s.inTurno = false;
      if (!s.chiusa) prossimo(s);
    }
  });
}

function accoda(s, testo, { domanda = false } = {}) {
  s.coda.push({ testo, domanda, il: Date.now() });
  if (s.motore === 'projexa') { prossimo(s); return; }
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
  clearTimeout(s.timerTratto);
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
  if (!ai) throw errore(400, `Assistente PM: «${conf.ai}» non è ancora supportata (per ora Gemini e Projexa)`);
  if (ai.locale) return { ai, apiKey: null }; // Ollama della VM: nessuna chiave
  const el = await getIntegration(user.user_id, ai.provider);
  const apiKey = el[`${ai.prefix}_api_key`];
  if (!apiKey) throw errore(428, 'Assistente PM: collega la chiave API di Gemini in Impostazioni › AI');
  return { ai, apiKey };
}

// Campo settings «Esecuzione Assistente PM» (2026-10-14, creato dall'utente): "Chiedi Sempre"
// (o vuoto) = la finestra chiede la modalità; "Testo to Testo" = parte subito in Testo;
// "Audio to Testo" = parte subito in Audio live. Restituisce 'testo' | 'audio' | null.
async function modalitaImpostata(user) {
  const r = (await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, CAMPO_ESECUZIONE]
  )).rows[0];
  const v = String((r && r.valore2) || '').trim().toLowerCase();
  if (v.startsWith('testo')) return 'testo';
  if (v.startsWith('audio')) return 'audio';
  return null;
}

// All'avvio della registrazione: assistente acceso? Se sì la finestra chiede la modalità,
// oppure parte subito con quella di «Esecuzione Assistente PM».
// Risposta: { attiva:false } oppure { attiva, ai, modalita: 'testo' | 'audio' | null }.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const x = await aiUtente(req.user);
    // Projexa (Ollama) lavora solo sul testo: la finestra non chiede la modalità.
    res.json(x ? { attiva: true, ai: x.ai.provider, modalita: x.ai.locale ? 'testo' : await modalitaImpostata(req.user) } : { attiva: false });
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
    const x = await aiUtente(req.user);
    if (!x) return res.json({ attiva: false });
    const { ai, apiKey } = x;
    // Projexa (Ollama) non ascolta l'audio: sempre testo.
    const modalita = b.modalita === 'audio' && !ai.locale ? 'audio' : 'testo';

    const k = chiave(req.user, idCalendar);
    // Istruzioni lette PRIMA di guardare la sessione esistente: tra controllo e scrittura non
    // ci sono più attese, quindi due /avvia insieme non lasciano una sessione orfana aperta
    // verso Gemini (la seconda chiude sempre la prima). 2026-10-17
    const testoIstruzioni = await istruzioni(req.user, idCalendar, String(b.titolo || '').slice(0, 200), modalita, ai);
    // Pm projexa: istruzioni del filtro veloce (vuote = lavora solo il modello grande).
    let istruzioniFiltro = '';
    if (ai.locale && OLLAMA_PM_FILTRO_MODEL) {
      try { istruzioniFiltro = (await getPromptFor('PM_PROJEXA_FILTRO', req.user)).testo; } catch (e) { console.warn(`[ASSISTENTE PM] ${idCalendar}: prompt del filtro non letto (${e.message}): lavorerà solo il modello grande`); }
    }
    const vecchia = sessioni.get(k);
    if (vecchia) chiudi(vecchia); // registrazione ripresa: sessione nuova
    // Al massimo MAX_SESSIONI_UTENTE sessioni aperte per utente (ognuna è un WebSocket Gemini
    // Live fino a 4 ore): oltre, si chiudono le più vecchie.
    const prefisso = chiave(req.user, '');
    const mie = [...sessioni.values()].filter((x) => !x.chiusa && x.chiave !== k && String(x.chiave).startsWith(prefisso))
      .sort((a, b2) => a.creataIl - b2.creataIl);
    while (mie.length >= MAX_SESSIONI_UTENTE) chiudi(mie.shift());
    const s = {
      chiave: k, idCalendar, apiKey, modalita, handle: null, ws: null, pronta: false, avviata: false, chiusa: false,
      titolo: String(b.titolo || '').trim().slice(0, 200) || 'Riunione', creataIl: Date.now(), chiusaIl: 0,
      istruzioni: ai.locale ? testoIstruzioni.sistema : testoIstruzioni, bloccoInCoda: 0,
      coda: [], inTurno: false, risposta: '', ascoltato: '', attesaAudio: [], timerTurno: null, riconnessioni: 0,
      timerAudio: null, attivitaAperta: false, audioNuovo: false, valutazioni: 0, silenzi: 0, rispostaLibera: false,
      attesaRisposta: false, timerRisposta: null, turniChiesti: 0, senzaRisposta: 0, senzaRispostaDiFila: 0, sblocchi: 0,
      diag: { connessioni: 0, connessaIl: 0, ultimoMsg: 0, token: null, tipi: {} },
      modelloIdx: 0, contestoRipresa: '',
      messaggi: [], seq: 0, ultimoUso: Date.now(), blocchi: Promise.resolve(),
      // Pm projexa (Ollama): conversazione, suggerimenti già dati, attesa del tratto completo.
      motore: ai.locale ? 'projexa' : 'gemini', aiNome: ai.provider, modelloOllama: OLLAMA_PM_MODEL,
      // Pm projexa: la conversazione parte dal contesto della riunione (dopo le istruzioni fisse).
      storia: ai.locale ? [{ role: 'user', content: testoIstruzioni.contesto }, { role: 'assistant', content: 'Nessun suggerimento.' }] : [],
      giaDetti: [], timerTratto: null, errori: 0,
      istruzioniFiltro, trattoPrec: '', filtrati: 0
    };
    sessioni.set(k, s);
    if (s.motore === 'projexa') {
      // Nessuna connessione da aprire: la sessione è subito pronta, Ollama legge intanto le istruzioni.
      s.pronta = true;
      s.avviata = true;
      aggiungi(s, 'info', 'Pm projexa sta leggendo le istruzioni e i dati del progetto (sulla VM può richiedere qualche minuto): intanto la riunione viene trascritta.');
      preriscaldaOllama(s);
      return res.json({ attiva: true, ai: ai.provider, modello: s.modelloOllama, modalita });
    }
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
  // Coda limitata: ogni blocco tiene in memoria fino a ~4 MB di audio finché non è trascritto.
  // Se la trascrizione è più lenta dell'arrivo dei blocchi, i nuovi si scartano. 2026-10-17
  if (s.bloccoInCoda >= MAX_BLOCCHI_IN_CODA) return res.status(429).json({ error: 'Assistente PM in ritardo: blocco scartato' });
  s.bloccoInCoda += 1;
  const user = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, email: req.user.email };
  s.ultimoUso = Date.now();
  s.blocchi = s.blocchi.then(async () => {
    if (s.chiusa) { s.bloccoInCoda -= 1; return; }
    try {
      const testo = await trascriviBloccoBreve(user, s.idCalendar, { audioB64: audio, energy, offset });
      if (!testo || s.chiusa) return;
      aggiungi(s, 'trascrizione', testo);
      // Pm projexa unisce più blocchi in un tratto e mette lui l'intestazione.
      accoda(s, s.motore === 'projexa' ? testo : `TRASCRIZIONE (nuovo pezzo della riunione):\n${testo}`);
    } catch (e) {
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: blocco non trascritto (${e.message})`);
      aggiungi(s, 'avviso', `Un pezzo di riunione non è stato trascritto per l'assistente (${e.message}).`);
    } finally {
      s.bloccoInCoda -= 1;
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
  accoda(s, s.motore === 'projexa' ? testo : `DOMANDA SCRITTA DA CHI TI USA (rispondi in modo diretto e breve):\n${testo}`, { domanda: true });
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
    ai: s.aiNome || 'Gemini',
    titolo: s.titolo,
    collegata: s.pronta,
    // Pm projexa tiene in coda i blocchi finché il tratto non è completo: «sta leggendo» solo
    // mentre Ollama lavora davvero.
    inAttesa: s.inTurno || (s.motore !== 'projexa' && s.coda.length > 0),
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
// Risposta: { ok, scaricaWord } — scaricaWord = campo booleano «Download automatico file Ass PM
// AI» acceso (valore1): la finestra avvia da sola l'export in Word a fine registrazione.
router.post('/ferma', requireAuth, async (req, res) => {
  const s = sessioneDi(req, idDa((req.body || {}).id_calendar));
  if (s && !s.chiusa) chiudi(s, false);
  let scaricaWord = false;
  try {
    const r = (await db.query(
      `SELECT valore1 FROM settings
        WHERE tenant_id = $1 AND user_id = $2
          AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        ORDER BY id LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, CAMPO_DOWNLOAD]
    )).rows[0];
    scaricaWord = !!(r && vero(r.valore1));
  } catch (e) { console.warn('[ASSISTENTE PM] impostazione download automatico non letta:', e.message); }
  res.json({ ok: true, scaricaWord });
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
        text: `Riunione del ${giorno} · ${s.modalita === 'audio' ? 'Audio live' : 'Testo'} · ${s.motore === 'projexa' ? `Pm projexa (${s.modelloOllama})` : MODELLI[s.modelloIdx]}`, color: '6B7280' })] }),
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
