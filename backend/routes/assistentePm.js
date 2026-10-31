// ============================================================================
// «AI ASSISTENTE PM» DURANTE LA REGISTRAZIONE DI UNA RIUNIONE (2026-10-13)
// ----------------------------------------------------------------------------
// Campo di settings «Ai Assistente PM» (tipo 23: interruttore valore1 + elenco valore2: «Gemini»
// oppure «ChatGPT»). Con l'interruttore acceso, quando si avvia una registrazione (pulsante
// Registra della riga o «Registra» della barra laterale) la dashboard apre la finestra
// «Assistente PM» (sito/js/assistente-pm.js). Fermando la registrazione la sessione si chiude.
//
// 2026-10-31 (scelta utente): SOLO AUDIO, NIENTE TRASCRIZIONE. Tolte la modalità Testo (blocchi
// brevi trascritti dal Whisper della VM) e la «Trascrizione live» (testo di ciò che l'AI sentiva):
// l'AI riceve l'audio della riunione e restituisce soltanto i suggerimenti.
//
// Collegamenti, tutti WebSocket:
//   browser ──(WS /api/assistente-pm/live: audio PCM 16 bit mono 16 kHz in frame binari;
//              il server spinge suggerimenti e stato in JSON)──> server Projexa
//   server  ──(WS)──> Gemini Live (BidiGenerateContent)  oppure  ChatGPT Realtime (OpenAI).
// La sessione con l'AI la apre il server con la chiave dell'utente, che non va mai al browser.
// L'AI fa da project manager senior e risponde in testo. L'utente può anche scrivere una domanda.
//
// Turni: li decide il server. Ogni AUDIO_TURNO_MS l'AI valuta l'audio ascoltato dall'ultimo
// turno; fino alla sua risposta non se ne chiede un altro. Il rilevamento automatico delle pause
// non va bene per una riunione: si parla quasi di continuo e ogni voce interromperebbe la risposta.
//
// Sessioni in memoria (un solo processo Node, PM2 fork): un riavvio del server le chiude e la
// finestra lo segnala. Gemini chiude la connessione ogni ~10 minuti con «goAway»: si riapre con
// l'handle di ripresa (sessionResumption), il contesto non si perde. ChatGPT Realtime chiude la
// sessione dopo ~60 minuti: se ne apre una nuova con i suggerimenti già dati come contesto.
//
// Istruzioni: prompt ASSISTENTE_PM (app_prompts, file backend/prompts/assistente_pm.txt) con
// i dati del progetto della riunione (gli stessi del Briefing pre-riunione) se ce n'è uno.
// Modelli (.env): GEMINI_LIVE_MODEL / GEMINI_LIVE_FALLBACK_MODEL e OPENAI_REALTIME_MODEL /
// OPENAI_REALTIME_FALLBACK_MODEL: se l'AI chiude per quota esaurita, sovraccarico o modello non
// disponibile si passa al modello di riserva, con avviso nella finestra. I modelli Gemini Live
// «native audio» rispondono solo in AUDIO: si chiede AUDIO + trascrizione della RISPOSTA
// (outputAudioTranscription) e si usa solo il testo. GEMINI_LIVE_MODALITY=TEXT per i modelli
// che rispondono direttamente in testo. ChatGPT Realtime risponde direttamente in testo.
//
// ANONYMIZATION LAYER (2026-10-22, config/pii.js): istruzioni, dati del progetto e domande
// scritte partono con i segnaposto ([PERSONA_1]...), una tabella per sessione; i suggerimenti
// tornano con i nomi veri. L'AUDIO non si può anonimizzare e parte così com'è.
// ============================================================================
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegration } from '../config/integrations.js';
import { getPromptFor } from '../config/prompts.js';
import { speakerName } from '../jobs/meetingTranscription.js';
import { contestoProgetto, dataIt, oggiIso } from '../config/pmCore.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { Anonimizzatore, NOTA_SEGNAPOSTO, piiAttivo } from '../config/pii.js';
import { readSessionCookie, verifySessionToken } from '../config/session.js';
import { allowedOrigins } from '../config/origins.js';

const router = express.Router();

const CAMPO = 'ai assistente pm';
// Campo booleano (creato dall'utente 2026-10-13): export Word automatico a «Ferma». Nome nuovo
// dal 2026-10-26 (Supporto/CreaDB/uniforma_nomi_e_stati.sql); il vecchio vale ancora.
const CAMPI_DOWNLOAD = ['download automatico file assistente pm', 'download automatico file ass pm ai'];
// Modello principale e, in ordine, quelli di riserva (variabile *_FALLBACK_MODEL, separati da
// virgola; vuota = nessuna riserva).
const elencoModelli = (principale, riserva) => [...new Set([principale, ...String(riserva).split(',')]
  .map((m) => String(m || '').trim().replace(/^models\//, '')).filter(Boolean))];
const RISERVA_RE = /quota|resource[_ ]?exhausted|rate.?limit|too many|exceeded|overload|unavailable|not found|not supported|does not exist|model_not_found|busy|capacity|429|404/i;
const CHIAVE_RE = /api key|api_key|invalid_api_key|unauthori[sz]ed|incorrect.*key|401|403/i;

// AI gestite dall'Assistente PM (voci dell'elenco del campo).
const AI_SUPPORTATE = {
  gemini: {
    provider: 'Gemini', prefix: 'gemini', nome: 'Gemini Live',
    modelli: elencoModelli(process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
      process.env.GEMINI_LIVE_FALLBACK_MODEL ?? 'gemini-3.1-flash-live-preview')
  },
  chatgpt: {
    provider: 'ChatGPT', prefix: 'chatgpt', nome: 'ChatGPT Realtime',
    modelli: elencoModelli(process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
      process.env.OPENAI_REALTIME_FALLBACK_MODEL ?? 'gpt-realtime-mini')
  }
};
// Voce del campo -> chiave di AI_SUPPORTATE («Gemini», «Gemini Live» -> 'gemini';
// «ChatGPT», «OpenAI», «ChatGPT Realtime» -> 'chatgpt').
function chiaveAi(v) {
  const t = String(v || '').toLowerCase();
  if (/gemini/.test(t)) return 'gemini';
  if (/chat\s*gpt|openai|gpt/.test(t)) return 'chatgpt';
  return '';
}

const GEMINI_MODALITA = String(process.env.GEMINI_LIVE_MODALITY || 'AUDIO').toUpperCase() === 'TEXT' ? 'TEXT' : 'AUDIO';
const GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const OPENAI_WS = 'wss://api.openai.com/v1/realtime';
// Dati del progetto nelle istruzioni: restano nel contesto e si pagano a OGNI turno, quindi
// ~4-5.000 token al massimo.
const MAX_DATI = 16000;
// Gemini, compressione del contesto (token): oltre COMPRESSIONE_DA si torna a COMPRESSIONE_A.
// Soglia bassa anche per il COSTO: Gemini Live fattura a ogni risposta tutto il contesto della
// sessione (con l'audio cresce di ~25 token al secondo). Le istruzioni restano.
const COMPRESSIONE_DA = Number(process.env.GEMINI_LIVE_TRIGGER_TOKENS) || 24000;
const COMPRESSIONE_A = Number(process.env.GEMINI_LIVE_TARGET_TOKENS) || 12000;
// ChatGPT, stesso scopo: nella conversazione restano solo gli ultimi turni di audio (i più vecchi
// si cancellano, conversation.item.delete); le risposte già date restano.
const OPENAI_TURNI_AUDIO = Math.max(2, Number(process.env.OPENAI_REALTIME_TURNI_AUDIO) || 10);
const OPENAI_MAX_TOKEN_RISPOSTA = 600;
const OPENAI_RATE = 24000;                // ChatGPT Realtime vuole PCM a 24 kHz (il browser manda 16 kHz)
const MAX_AUDIO_LIVE_BYTES = 256 * 1024;  // frame di audio dal browser: ~0,5 s = 16 KB
const MAX_ATTESA_AUDIO = 80;              // pezzi tenuti mentre l'AI si ricollega o risponde (~40 s)
const ATTESA_RISPOSTA_MS = 25000;         // attesa massima della risposta a un turno
const ATTESA_DOMANDA_MS = 60000;          // ... e a una domanda scritta
const ATTESA_PRONTA_MS = 20000;           // connessione aperta ma sessione non pronta: si riapre
const MAX_MESSAGGI = 400;                 // messaggi tenuti per la finestra
const MAX_RICONNESSIONI = 5;              // di fila, senza una risposta riuscita in mezzo
// Ogni quanti ms si chiude il «turno» e l'AI valuta l'audio ascoltato. 30 s (era 15, scelta
// utente 2026-10-13): con tratti più lunghi l'AI capisce se un punto è già stato chiarito e
// interviene meno e meglio.
const AUDIO_TURNO_MS = Math.max(5000, Number(process.env.ASSISTENTE_PM_TURNO_AUDIO_MS) || 30000);
// Pezzo di audio senza voce (RMS sotto la soglia, campioni già portati a volume dalla dashboard):
// non si manda all'AI, che fattura anche il silenzio. Un turno di solo silenzio non si chiede.
const SOGLIA_SILENZIO = Number(process.env.ASSISTENTE_PM_SOGLIA_SILENZIO) || 0.004;
const INATTIVA_MS = 4 * 3600000;          // sessione dimenticata aperta: chiusa dopo 4 ore
const CONSERVA_MS = 2 * 3600000;          // messaggi tenuti dopo «Ferma» per l'export in Word
const RIVERIFICA_MS = 10 * 60000;         // WebSocket del browser: sessione di login ricontrollata
const vero = (v) => v === true || v === 'true' || v === 't' || v === 1 || v === '1';
const errore = (status, msg) => Object.assign(new Error(msg), { status });
// Risposta «niente da dire» (il prompt chiede «Nessun suggerimento.»): non si mostra.
const SILENZIO_RE = /^[\s.…\-–—]*(ok|nessun suggerimento)?[\s.…\-–—]*$/i;
// Si mostrano solo i suggerimenti che iniziano con una parola chiave del prompt: il resto
// (es. «Io vi sento. C'è altro che posso fare?», il modello che parla alla riunione) si scarta.
// Le risposte alle domande scritte dall'utente si mostrano sempre.
const SUGGERIMENTO_RE = /^\W*(DOMANDA|RISCHIO|CR|ATTENZIONE|AGENDA)\s*:/i;

// Voti 👍/👎 (tabella pm_assistente_voti, Supporto/CreaDB/assistente_pm_voti.sql).
const VOTO_TRATTO_CHARS = 1200;  // domanda scritta salvata col voto della risposta
const ESEMPI_UTILI = 6;          // suggerimenti 👍 messi nelle istruzioni come esempi
const ESEMPI_INUTILI = 4;        // suggerimenti 👎 messi nelle istruzioni come da evitare

// "tenant|utente|id_calendar" -> sessione
const sessioni = new Map();
const MAX_SESSIONI_UTENTE = 2;   // sessioni live aperte contemporaneamente per utente
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
  let dati = 'Nessun progetto collegato alla riunione: basati solo su quanto senti.';
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

// Esempi dai voti 👍/👎 dell'utente (fino a ieri: durante la giornata le istruzioni restano
// identiche). Il numero del segnale («DOMANDA [4]: ...») si toglie. Tabella assente o errore:
// nessun esempio.
async function esempiDaiVoti(user) {
  let righe = [];
  try {
    righe = (await db.query(
      `(SELECT voto, suggerimento, tratto FROM pm_assistente_voti
         WHERE tenant_id = $1 AND user_id = $2 AND voto = 1 AND segnale <> 'RISPOSTA' AND updated_at < CURRENT_DATE
         ORDER BY updated_at DESC LIMIT ${ESEMPI_UTILI * 3})
       UNION ALL
       (SELECT voto, suggerimento, tratto FROM pm_assistente_voti
         WHERE tenant_id = $1 AND user_id = $2 AND voto = -1 AND segnale <> 'RISPOSTA' AND updated_at < CURRENT_DATE
         ORDER BY updated_at DESC LIMIT ${ESEMPI_INUTILI * 3})`,
      [user.tenant_id, user.user_id])).rows;
  } catch (e) {
    if (e.code !== '42P01') console.warn(`[ASSISTENTE PM] esempi dai voti non letti (${e.message})`);
    return '';
  }
  const riga = (r) => {
    const sugg = String(r.suggerimento || '').replace(/\s+/g, ' ').trim().replace(/^(\w+)\s*\[\s*\d{1,2}\s*\]\s*:/, '$1:');
    // Voti fino al 2026-10-31: col suggerimento c'è il pezzo di trascrizione da cui è nato.
    const tratto = String(r.tratto || '').replace(/\s+/g, ' ').trim().slice(-220);
    return tratto ? `Testo: "…${tratto}" -> ${sugg}` : `-> ${sugg}`;
  };
  const utili = righe.filter((r) => r.voto === 1).map(riga).filter(Boolean).slice(0, ESEMPI_UTILI);
  const inutili = righe.filter((r) => r.voto === -1).map(riga).filter(Boolean).slice(0, ESEMPI_INUTILI);
  if (!utili.length && !inutili.length) return '';
  const L = ['', 'ESEMPI VALUTATI DA CHI TI USA (riunioni passate)'];
  if (utili.length) L.push('Suggerimenti giudicati UTILI: scrivine di questo tipo quando ritrovi un segnale simile.', ...utili);
  if (inutili.length) L.push('Suggerimenti giudicati INUTILI: in casi come questi rispondi "Nessun suggerimento." oppure scrivi qualcosa di davvero diverso.', ...inutili);
  return L.join('\n');
}

// {{INGRESSO}} del prompt: cosa riceve l'AI.
const INGRESSO = 'Ascolti in tempo reale l\'audio della riunione: la voce di chi ti usa (dal suo microfono) e quella degli altri partecipanti. Non ricevi nessuna trascrizione: ti basi solo su quello che senti.';

async function istruzioni(user, idCalendar, titolo) {
  const { riunione, dati } = await datiRiunione(user, idCalendar, titolo);
  const utente = String(await speakerName(user) || '').trim() || user.email || '';
  const vars = { UTENTE: utente, RIUNIONE: riunione, DATA: dataIt(oggiIso()), DATI: dati, INGRESSO };
  let tpl = (await getPromptFor('ASSISTENTE_PM', user)).testo;
  if (!tpl.includes('{{INGRESSO}}')) tpl = `{{INGRESSO}}\n${tpl}`;
  // Esempi dai voti 👍/👎 in fondo alle istruzioni, dopo i dati.
  const esempi = await esempiDaiVoti(user);
  if (!tpl.includes('{{DATI}}')) tpl += '\n\nDATI\n{{DATI}}';
  return tpl.replace(/\{\{(UTENTE|RIUNIONE|DATA|DATI|INGRESSO)\}\}/g, (x, k) => vars[k]) + esempi;
}

// ----------------------------------------------------------------------------
// MESSAGGI DELLA FINESTRA (spinti ai browser collegati via WebSocket)
// ----------------------------------------------------------------------------

const perFinestra = (s, m) => (m.tipo === 'ai' && s.origini.has(m.n) ? { ...m, votabile: true, voto: s.voti.get(m.n) || 0 } : m);

function statoSessione(s) {
  return {
    attiva: !s.chiusa,
    ai: s.ai.provider,
    titolo: s.titolo,
    collegata: s.pronta,
    inAttesa: s.inRisposta || s.richieste.length > 0,
    // Quante volte l'AI ha valutato la riunione e quante senza suggerimenti (per la finestra).
    valutazioni: s.valutazioni,
    silenzi: s.silenzi,
    turniChiesti: s.turniChiesti,
    senzaRisposta: s.senzaRisposta
  };
}

function spingi(s, obj) {
  if (!s.client.size) return;
  const txt = JSON.stringify(obj);
  for (const c of s.client) {
    if (c.readyState === WebSocket.OPEN) { try { c.send(txt); } catch { /* browser scollegato */ } }
  }
}
const notifica = (s) => spingi(s, { tipo: 'stato', stato: statoSessione(s) });

function aggiungi(s, tipo, testo) {
  const m = { n: ++s.seq, tipo, testo: String(testo || ''), ora: new Date().toISOString() };
  s.messaggi.push(m);
  if (s.messaggi.length > MAX_MESSAGGI) s.messaggi.splice(0, s.messaggi.length - MAX_MESSAGGI);
  s.ultimoUso = Date.now();
  // Suggerimento: si ricorda se risponde a una domanda scritta (e quale), per il voto 👍/👎.
  if (tipo === 'ai') {
    s.origini.set(m.n, { tratto: String(s.domandaCorrente || '').slice(-VOTO_TRATTO_CHARS), domanda: !!s.rispostaLibera });
    if (s.origini.size > MAX_MESSAGGI) s.origini.delete(s.origini.keys().next().value);
  }
  spingi(s, { tipo: 'messaggi', messaggi: [perFinestra(s, m)], stato: statoSessione(s) });
}

const secondiDa = (t) => (t ? Math.round((Date.now() - t) / 1000) : '?');

// --- Diagnostica (2026-10-15) ---
// L'AI a volte smette di rispondere senza chiudere la connessione e senza errori. Per capire
// quando succede si annota cosa arriva (tipi di messaggio, token del contesto, ora dell'ultimo
// messaggio) e lo si scrive nel log a ogni turno senza risposta e a ogni risposta.
function notaDiagnostica(s, tipi, token) {
  const d = s.diag;
  d.ultimoMsg = Date.now();
  for (const t of tipi) d.tipi[t] = (d.tipi[t] || 0) + 1;
  if (Number.isFinite(Number(token)) && token !== null) d.token = Number(token);
}
function rigaDiagnostica(s) {
  const d = s.diag;
  const tipi = Object.entries(d.tipi).map(([k, n]) => `${k}×${n}`).join(', ') || 'nessuno';
  d.tipi = {};
  return `connessione n.${d.connessioni} aperta da ${secondiDa(d.connessaIl)} s · ultimo messaggio dall'AI ${secondiDa(d.ultimoMsg)} s fa · token contesto ${d.token ?? '?'} · ws ${s.ws ? s.ws.readyState : '-'} · ricevuti dal turno prima: ${tipi}`;
}

// ----------------------------------------------------------------------------
// AUDIO
// ----------------------------------------------------------------------------

// RMS (0-1) di un pezzo PCM 16 bit little-endian.
function rms(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
}

// 16 kHz -> 24 kHz (ChatGPT Realtime), interpolazione lineare. Il pezzo successivo continua dalla
// posizione frazionaria lasciata da questo (s.ricampiona), così tra un pezzo e l'altro non ci
// sono salti.
function a24k(s, buf) {
  const n = buf.length >> 1;
  const st = s.ricampiona || (s.ricampiona = { pos: 0, ultimo: 0 });
  const passo = 16000 / OPENAI_RATE;
  const out = [];
  const camp = (i) => (i < 0 ? st.ultimo : buf.readInt16LE(Math.min(i, n - 1) * 2));
  let pos = st.pos;
  while (pos < n - 1) {
    const i = Math.floor(pos);
    const f = pos - i;
    out.push(Math.round(camp(i) * (1 - f) + camp(i + 1) * f));
    pos += passo;
  }
  st.ultimo = camp(n - 1);
  st.pos = pos - n; // tra -1 e 0: il primo campione del pezzo dopo si interpola con st.ultimo
  const b = Buffer.alloc(out.length * 2);
  out.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2));
  return b;
}

// ----------------------------------------------------------------------------
// ADATTATORI: Gemini Live e ChatGPT Realtime
// ----------------------------------------------------------------------------
// url(s), opzioni(s)      -> connessione WebSocket
// apri(s, ws)             -> configurazione della sessione appena connessi
// messaggio(s, ws, msg)   -> eventi dell'AI
// audio(s, pcm16k)        -> invio di un pezzo di audio
// richiesta(s, r)         -> chiede una risposta: r = { domanda, testo } (domanda scritta) o
//                            {} (valutazione dell'audio). false = niente da chiedere.
// contesto(s, testo)      -> testo di contesto, senza chiedere una risposta (ripresa)
// ripresaConHandle        -> true = la riconnessione riprende la stessa sessione

const GEMINI = {
  ripresaConHandle: true,
  url: (s) => `${GEMINI_WS}?key=${encodeURIComponent(s.apiKey)}`,
  opzioni: () => ({}),
  apri(s, ws) {
    const setup = {
      model: `models/${s.ai.modelli[s.modelloIdx]}`,
      generationConfig: { responseModalities: [GEMINI_MODALITA] },
      systemInstruction: { parts: [{ text: s.istruzioni }] },
      // Riunioni lunghe: il contesto più vecchio si scarta invece di chiudere la sessione.
      contextWindowCompression: { triggerTokens: COMPRESSIONE_DA, slidingWindow: { targetTokens: COMPRESSIONE_A } },
      sessionResumption: s.handle ? { handle: s.handle } : {},
      // Turni decisi dal server (activityStart/activityEnd ogni AUDIO_TURNO_MS): chi parla non
      // interrompe la risposta. Nessuna trascrizione dell'audio ascoltato.
      realtimeInputConfig: { automaticActivityDetection: { disabled: true }, activityHandling: 'NO_INTERRUPTION' }
    };
    if (GEMINI_MODALITA === 'AUDIO') setup.outputAudioTranscription = {};
    ws.send(JSON.stringify({ setup }));
  },
  messaggio(s, ws, msg) {
    const tipi = Object.keys(msg);
    if (msg.serverContent) tipi.push(...Object.keys(msg.serverContent).map((k) => `serverContent.${k}`));
    notaDiagnostica(s, tipi, msg.usageMetadata && msg.usageMetadata.totalTokenCount);
    if (msg.setupComplete) { sessionePronta(s); return; }
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) s.handle = u.newHandle;
      return;
    }
    if (msg.goAway) {
      // Gemini sta per chiudere: si riapre subito con l'handle (close -> connetti).
      console.warn(`[ASSISTENTE PM] ${s.idCalendar}: goAway da Gemini (timeLeft ${msg.goAway.timeLeft || '?'}) dopo ${secondiDa(s.diag.connessaIl)} s di connessione`);
      try { ws.close(); } catch { /* già chiusa */ }
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (GEMINI_MODALITA === 'TEXT' && sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
      for (const p of sc.modelTurn.parts) if (p && p.text && !p.thought) s.risposta += p.text;
    }
    if (sc.outputTranscription && sc.outputTranscription.text) s.risposta += sc.outputTranscription.text;
    if (sc.turnComplete || sc.interrupted) rispostaCompleta(s, s.risposta, !!sc.interrupted);
  },
  audio(s, pcm) {
    if (!s.attivitaAperta) {
      s.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      s.attivitaAperta = true;
    }
    s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
  },
  richiesta(s, r) {
    if (r.domanda) {
      s.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: r.testo }] }], turnComplete: true } }));
      return true;
    }
    if (!s.attivitaAperta) return false;
    s.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    s.attivitaAperta = false;
    return true;
  },
  contesto(s, testo) {
    s.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: testo }] }], turnComplete: false } }));
  }
};

const CHATGPT = {
  ripresaConHandle: false,
  url: (s) => `${OPENAI_WS}?model=${encodeURIComponent(s.ai.modelli[s.modelloIdx])}`,
  opzioni: (s) => ({ headers: { Authorization: `Bearer ${s.apiKey}` } }),
  apri(s, ws) {
    s.itemAudio = [];
    s.ricampiona = null;
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: s.istruzioni,
        output_modalities: ['text'],
        max_output_tokens: OPENAI_MAX_TOKEN_RISPOSTA,
        // Nessun rilevamento delle pause (turni decisi dal server) e nessuna trascrizione.
        audio: { input: { format: { type: 'audio/pcm', rate: OPENAI_RATE }, turn_detection: null } }
      }
    }));
  },
  messaggio(s, ws, msg) {
    const usage = msg.response && msg.response.usage;
    notaDiagnostica(s, [msg.type || '?'], usage && usage.input_tokens);
    switch (msg.type) {
      case 'session.updated':
        if (!s.pronta) sessionePronta(s);
        return;
      case 'input_audio_buffer.committed':
        // Turni di audio nel contesto: oltre OPENAI_TURNI_AUDIO si cancellano i più vecchi.
        if (msg.item_id) s.itemAudio.push(msg.item_id);
        while (s.itemAudio.length > OPENAI_TURNI_AUDIO) {
          try { ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: s.itemAudio.shift() })); } catch { /* connessione in chiusura */ }
        }
        return;
      case 'response.output_text.delta':
      case 'response.text.delta':
        s.risposta += msg.delta || '';
        return;
      case 'response.done': {
        const r = msg.response || {};
        let testo = s.risposta;
        if (!testo.trim()) {
          // Testo non arrivato a pezzi: si prende dalla risposta completa.
          testo = (r.output || []).flatMap((o) => o.content || []).map((c) => c.text || c.transcript || '').join('');
        }
        if (r.status === 'failed') console.warn(`[ASSISTENTE PM] ${s.idCalendar}: risposta di ChatGPT non riuscita (${JSON.stringify(r.status_details || {}).slice(0, 300)})`);
        rispostaCompleta(s, testo, r.status !== 'completed');
        return;
      }
      case 'error': {
        const e = msg.error || {};
        const testo = `${e.code || e.type || 'errore'}: ${e.message || ''}`.slice(0, 300);
        console.warn(`[ASSISTENTE PM] ${s.idCalendar}: errore da ChatGPT (${testo})`);
        s.ultimoErrore = testo;
        // Configurazione rifiutata o chiave non valida: la connessione non serve, si chiude
        // (il «close» decide se passare al modello di riserva o fermarsi).
        if (!s.pronta || CHIAVE_RE.test(testo)) { try { ws.close(4000, testo.slice(0, 120)); } catch { /* già chiusa */ } return; }
        // Turno non partito (es. buffer audio vuoto, risposta già in corso): si passa al prossimo.
        if (s.inRisposta && /buffer|response|conversation_already/i.test(testo)) fineRisposta(s);
        return;
      }
      default:
    }
  },
  audio(s, pcm) {
    s.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: a24k(s, pcm).toString('base64') }));
    s.audioNelBuffer = true;
  },
  richiesta(s, r) {
    const audio = s.audioNelBuffer;
    if (!r.domanda && !audio) return false;
    if (audio) { s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); s.audioNelBuffer = false; }
    if (r.domanda) {
      s.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: r.testo }] } }));
    }
    s.ws.send(JSON.stringify({ type: 'response.create' }));
    return true;
  },
  contesto(s, testo) {
    s.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: testo }] } }));
  }
};

const ADATTATORI = { gemini: GEMINI, chatgpt: CHATGPT };

// ----------------------------------------------------------------------------
// SESSIONE CON L'AI (lato server)
// ----------------------------------------------------------------------------

function connetti(s) {
  if (s.chiusa) return;
  const ad = ADATTATORI[s.aiKey];
  s.pronta = false;
  s.attivitaAperta = false;
  s.audioNelBuffer = false;
  s.ultimoErrore = '';
  const ws = new WebSocket(ad.url(s), ad.opzioni(s));
  s.ws = ws;
  s.diag.connessioni++;
  s.diag.connessaIl = Date.now();
  clearTimeout(s.timerPronta);
  s.timerPronta = setTimeout(() => {
    if (s.ws !== ws || s.pronta) return;
    s.ultimoErrore = s.ultimoErrore || 'sessione non pronta';
    try { ws.terminate(); } catch { /* già chiusa */ }
  }, ATTESA_PRONTA_MS);
  ws.on('open', () => { if (s.ws === ws) ad.apri(s, ws); });
  ws.on('message', (data) => {
    if (s.ws !== ws) return; // connessione abbandonata (sblocca): risposte in ritardo ignorate
    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
    ad.messaggio(s, ws, msg);
  });
  ws.on('error', (e) => {
    // Es. «Unexpected server response: 401» (chiave rifiutata) o 429 (quota): il motivo serve al
    // «close» che arriva subito dopo.
    s.ultimoErrore = s.ultimoErrore || String((e && e.message) || 'connessione');
    console.warn(`[ASSISTENTE PM] ${s.idCalendar}: errore WebSocket ${s.ai.provider} (${(e && e.message) || 'connessione'})`);
  });
  ws.on('close', (code, reasonBuf) => {
    if (s.ws !== ws) return; // connessione già sostituita
    clearTimeout(s.timerPronta);
    s.pronta = false;
    s.ws = null;
    s.attivitaAperta = false;
    // Risposta persa con la connessione: la richiesta in corso si abbandona; l'audio messo da
    // parte resta in attesaAudio e parte con la nuova connessione.
    if (s.inRisposta) { s.inRisposta = false; clearTimeout(s.timerRisposta); }
    if (s.chiusa) return;
    notifica(s);
    const reason = String(reasonBuf || '');
    const motivo = [reason, s.ultimoErrore].filter(Boolean).join(' · ') || `codice ${code}`;
    console.warn(`[ASSISTENTE PM] ${s.idCalendar}: ${s.ai.provider} ${s.ai.modelli[s.modelloIdx]} ha chiuso la connessione (${motivo})`);
    // Chiave non valida: nessun modello può funzionare.
    if (CHIAVE_RE.test(motivo)) {
      aggiungi(s, 'errore', `${s.ai.provider} ha rifiutato la sessione (${motivo}): controlla la chiave API in Impostazioni › AI.`);
      chiudi(s, false);
      return;
    }
    // Quota esaurita, sovraccarico o modello non disponibile: si passa al modello di riserva.
    s.riconnessioni++;
    if (RISERVA_RE.test(motivo) || code === 1007 || code === 1008 || s.riconnessioni > MAX_RICONNESSIONI) {
      if (passaAlModelloSuccessivo(s, motivo)) return;
      aggiungi(s, 'errore', `${s.ai.provider} ha chiuso la sessione: ${motivo}. Nessun altro modello di riserva: assistente fermato.`);
      chiudi(s, false);
      return;
    }
    // ChatGPT (sessione scaduta dopo ~60 minuti) o Gemini senza handle: sessione nuova con i
    // suggerimenti già dati come contesto.
    if (!ADATTATORI[s.aiKey].ripresaConHandle || !s.handle) s.contestoRipresa = contestoRipresa(s);
    setTimeout(() => connetti(s), Math.min(1000 * s.riconnessioni, 5000));
  });
}

// Sessione pronta (setupComplete di Gemini, session.updated di ChatGPT).
function sessionePronta(s) {
  clearTimeout(s.timerPronta);
  s.pronta = true;
  if (s.contestoRipresa) {
    try { ADATTATORI[s.aiKey].contesto(s, s.contestoRipresa); } catch { /* si riparte senza */ }
    s.contestoRipresa = '';
  }
  if (!s.avviata) {
    s.avviata = true;
    aggiungi(s, 'info', `Assistente collegato a ${s.ai.nome}: ascolta la riunione e ti suggerirà domande e punti da chiarire.`);
  } else notifica(s);
  // Audio arrivato mentre l'AI si collegava (o si ricollegava).
  for (const pcm of s.attesaAudio.splice(0)) inviaAudio(s, pcm);
  if (!s.timerAudio) s.timerAudio = setInterval(() => chiediValutazione(s), AUDIO_TURNO_MS);
  prossimo(s);
}

// Modello di riserva: sessione nuova con le stesse istruzioni. Il contesto della conversazione
// non passa da un modello all'altro: si rimandano i suggerimenti già dati. false = non ci sono
// altri modelli.
function passaAlModelloSuccessivo(s, motivo) {
  if (s.modelloIdx + 1 >= s.ai.modelli.length) return false;
  const prima = s.ai.modelli[s.modelloIdx];
  s.modelloIdx++;
  s.handle = null; // l'handle di ripresa vale solo per il modello che l'ha dato
  s.riconnessioni = 0;
  s.risposta = '';
  s.contestoRipresa = contestoRipresa(s);
  aggiungi(s, 'avviso', `${prima} non disponibile (${String(motivo).slice(0, 200)}): continuo con ${s.ai.modelli[s.modelloIdx]}.`);
  setTimeout(() => connetti(s), 500);
  return true;
}

// Contesto per una sessione nuova: l'audio di prima non c'è più, si rimandano i suggerimenti
// già dati perché non vengano ripetuti.
function contestoRipresa(s) {
  const ultimi = s.messaggi.filter((m) => m.tipo === 'ai').slice(-8)
    .map((m) => `- ${s.anon ? s.anon.mascheraSubito(m.testo) : m.testo}`);
  return ultimi.length
    ? `Riprendi l'assistenza: la sessione precedente si è interrotta e l'audio di prima non è più disponibile. Suggerimenti che hai già dato (non ripeterli; non rispondere a questo messaggio):\n${ultimi.join('\n')}`
    : '';
}

// AI «appesa»: la connessione resta aperta ma non risponde più a nessun turno. Caso reale
// 2026-10-14 (Gemini): dopo 3 risposte, 54 turni di fila senza risposta. Dopo SBLOCCO_TURNI
// turni di fila senza risposta si riapre la connessione: la prima volta riprendendo la stessa
// sessione (Gemini, handle), poi con una sessione nuova; se non basta si prova il modello di riserva.
const SBLOCCO_TURNI = 2;
function sblocca(s) {
  if (s.chiusa) return;
  s.senzaRispostaDiFila = 0;
  s.sblocchi++;
  if (s.sblocchi > 3 && passaAlModelloSuccessivo(s, 'nessuna risposta da diversi minuti')) {
    staccaConnessione(s);
    return;
  }
  const nuova = s.sblocchi > 1 || !ADATTATORI[s.aiKey].ripresaConHandle;
  console.warn(`[ASSISTENTE PM] ${s.idCalendar}: ${s.ai.provider} non risponde da ${SBLOCCO_TURNI} turni, riconnessione ${nuova ? 'con sessione nuova' : 'con ripresa della sessione'} (tentativo ${s.sblocchi})`);
  staccaConnessione(s);
  if (nuova) { s.handle = null; s.contestoRipresa = contestoRipresa(s); }
  aggiungi(s, 'avviso', `${s.ai.provider} non rispondeva più: mi ricollego (l'ascolto continua).`);
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
  clearTimeout(s.timerPronta);
  if (s.inRisposta) { s.inRisposta = false; clearTimeout(s.timerRisposta); }
  try { if (vecchia) vecchia.close(1000, 'riconnessione'); } catch { /* già chiusa */ }
}

// Audio dal browser: PCM 16 bit mono 16 kHz. I pezzi senza voce non si mandano. Se la
// connessione non è pronta (avvio o riconnessione) o, con Gemini, si aspetta la risposta al
// turno appena chiuso (un nuovo activityStart la annullerebbe), si tengono gli ultimi pezzi e
// si inviano appena possibile.
function inviaAudio(s, pcm) {
  if (s.chiusa) return;
  if (!s.pronta || !s.ws || (s.aiKey === 'gemini' && s.inRisposta)) {
    s.attesaAudio.push(pcm);
    if (s.attesaAudio.length > MAX_ATTESA_AUDIO) s.attesaAudio.shift();
    return;
  }
  try {
    ADATTATORI[s.aiKey].audio(s, pcm);
    s.audioNuovo = true;
  } catch { /* connessione in chiusura: il pezzo si perde */ }
}

// Fine del turno audio: l'AI valuta quanto ascoltato dall'ultimo turno, se c'è audio nuovo e
// nessuna richiesta in corso o in coda (una domanda scritta valuta già anche l'audio).
function chiediValutazione(s) {
  if (s.chiusa || !s.audioNuovo || s.inRisposta || s.richieste.length) return;
  s.richieste.push({});
  prossimo(s);
}

// Invia la prossima richiesta in coda, una alla volta: si aspetta la fine della risposta (o
// ATTESA_RISPOSTA_MS) prima della successiva.
function prossimo(s) {
  if (s.chiusa || !s.pronta || s.inRisposta || !s.richieste.length || !s.ws) return;
  const r = s.richieste.shift();
  // Domanda scritta: anonimizzata prima dell'invio (il servizio risponde in millisecondi), poi
  // si rientra qui con il testo già trattato. Con PII_SE_NON_DISPONIBILE=blocca si scarta.
  if (r.domanda && s.anon && !r.anonimo) {
    s.inRisposta = true;
    s.anon.maschera(r.testo).then((t) => { s.richieste.unshift({ ...r, testo: t, anonimo: true }); }, (e) => {
      aggiungi(s, 'avviso', e.message);
    }).finally(() => { s.inRisposta = false; prossimo(s); });
    return;
  }
  s.risposta = '';
  s.rispostaLibera = !!r.domanda;
  s.domandaCorrente = r.domanda ? r.mostra || '' : '';
  let inviata = false;
  try { inviata = ADATTATORI[s.aiKey].richiesta(s, r); } catch { inviata = false; }
  if (!inviata) {
    if (r.domanda) s.richieste.unshift(r); // connessione in chiusura: la domanda riparte dopo
    return;
  }
  s.audioNuovo = false;
  s.inRisposta = true;
  s.turniChiesti++;
  s.timerRisposta = setTimeout(() => {
    if (!s.inRisposta) return;
    s.senzaRisposta++;
    s.senzaRispostaDiFila++;
    console.warn(`[ASSISTENTE PM] ${s.idCalendar}: turno ${s.turniChiesti} senza risposta da ${s.ai.provider} · ${rigaDiagnostica(s)}`);
    if (s.senzaRispostaDiFila >= SBLOCCO_TURNI) { sblocca(s); return; }
    fineRisposta(s);
  }, r.domanda ? ATTESA_DOMANDA_MS : ATTESA_RISPOSTA_MS);
  notifica(s);
}

function fineRisposta(s) {
  s.inRisposta = false;
  clearTimeout(s.timerRisposta);
  for (const pcm of s.attesaAudio.splice(0)) inviaAudio(s, pcm);
  notifica(s);
  prossimo(s);
}

// Risposta completa dell'AI: si mostra se è un suggerimento (o la risposta a una domanda).
function rispostaCompleta(s, grezza, interrotta) {
  const testo = String(grezza || '').replace(/\s+\n/g, '\n').trim();
  s.risposta = '';
  s.valutazioni++;
  const libera = s.rispostaLibera;
  const scartata = !!testo && !SILENZIO_RE.test(testo) && !libera && !SUGGERIMENTO_RE.test(testo);
  const silenzio = !testo || SILENZIO_RE.test(testo) || scartata;
  if (scartata) console.log(`[ASSISTENTE PM] ${s.idCalendar}: risposta senza parola chiave scartata (${testo.length} caratteri)`);
  if (silenzio) s.silenzi++;
  else aggiungi(s, 'ai', s.anon ? s.anon.ripristina(testo) : testo);
  s.rispostaLibera = false;
  s.domandaCorrente = '';
  console.log(`[ASSISTENTE PM] ${s.idCalendar}: risposta ${s.valutazioni} (turni chiesti ${s.turniChiesti}) ${interrotta ? 'interrotta' : 'completa'}, ${silenzio ? 'nessun suggerimento' : `suggerimento di ${testo.length} caratteri`} · token contesto ${s.diag.token ?? '?'} · connessione n.${s.diag.connessioni} da ${secondiDa(s.diag.connessaIl)} s`);
  s.diag.tipi = {};
  s.ultimoErrore = ''; // errori di turni passati: non sono il motivo di una chiusura futura
  s.riconnessioni = 0;
  s.senzaRispostaDiFila = 0;
  s.sblocchi = 0;
  fineRisposta(s);
}

function chiudi(s, rimuovi = true) {
  s.chiusa = true;
  if (!s.chiusaIl) s.chiusaIl = Date.now();
  clearInterval(s.timerAudio);
  clearTimeout(s.timerRisposta);
  clearTimeout(s.timerPronta);
  try { if (s.ws) s.ws.close(1000, 'fine riunione'); } catch { /* già chiusa */ }
  s.ws = null;
  s.attesaAudio = [];
  notifica(s);
  for (const c of s.client) { try { c.close(1000, 'assistente chiuso'); } catch { /* già chiuso */ } }
  s.client.clear();
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
// WEBSOCKET DEL BROWSER: /api/assistente-pm/live?id_calendar=...
// ----------------------------------------------------------------------------
// Autenticazione con il cookie di sessione (stessa origine). Contro il «cross-site WebSocket
// hijacking» l'Origin deve essere Projexa stesso (o in ALLOWED_ORIGINS): il WebSocket non passa
// dal CORS. La sessione dell'assistente la crea prima POST /avvia.
// Browser -> server: frame binari = audio PCM 16 bit mono 16 kHz; testo {"tipo":"dopo","n":N}
//   = mandami i messaggi successivi a N (dopo un ricollegamento).
// Server -> browser: {"tipo":"messaggi","messaggi":[...],"stato":{...}} e {"tipo":"stato",...}.
// Chiusure: 4401 login non valido, 4404 nessuna sessione dell'assistente.
const PERCORSO_LIVE = '/api/assistente-pm/live';
const wssLive = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_LIVE_BYTES });

function origineValida(req) {
  const o = String(req.headers.origin || '');
  if (!o) return false;
  if (allowedOrigins.has(o)) return true;
  try { return new URL(o).host === String(req.headers.host || ''); } catch { return false; }
}

export function attaccaAssistenteLive(server) {
  server.on('upgrade', async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    if (url.pathname !== PERCORSO_LIVE) { socket.destroy(); return; }
    const rifiuta = (stato, testo) => {
      try { socket.write(`HTTP/1.1 ${stato} ${testo}\r\nConnection: close\r\n\r\n`); } catch { /* già chiuso */ }
      socket.destroy();
    };
    if (!origineValida(req)) { rifiuta(403, 'Forbidden'); return; }
    const token = readSessionCookie(req);
    let user;
    try {
      if (!token) throw new Error('nessun cookie');
      user = await verifySessionToken(token);
    } catch { rifiuta(401, 'Unauthorized'); return; }
    wssLive.handleUpgrade(req, socket, head, (ws) => collegaBrowser(ws, user, token, idDa(url.searchParams.get('id_calendar'))));
  });
}

function collegaBrowser(ws, user, token, idCalendar) {
  const s = sessioni.get(chiave(user, idCalendar));
  if (!s || s.chiusa) { ws.close(4404, 'Assistente PM non attivo per questa riunione'); return; }
  s.client.add(ws);
  s.ultimoUso = Date.now();
  // Login ricontrollato ogni RIVERIFICA_MS (logout o password cambiata nel frattempo).
  const timer = setInterval(() => {
    verifySessionToken(token).catch(() => { try { ws.close(4401, 'Sessione di login scaduta'); } catch { /* già chiuso */ } });
  }, RIVERIFICA_MS);
  ws.on('message', (data, binario) => {
    if (s.chiusa) return;
    s.ultimoUso = Date.now();
    if (binario) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (!buf.length || buf.length % 2) return;
      if (rms(buf) < SOGLIA_SILENZIO) return; // nessuno parla
      inviaAudio(s, buf);
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg && msg.tipo === 'dopo') {
      const dopo = Number(msg.n) || 0;
      try {
        ws.send(JSON.stringify({ tipo: 'messaggi', messaggi: s.messaggi.filter((m) => m.n > dopo).map((m) => perFinestra(s, m)), stato: statoSessione(s) }));
      } catch { /* browser scollegato */ }
    }
  });
  ws.on('close', () => { clearInterval(timer); s.client.delete(ws); });
  ws.on('error', () => { /* il «close» segue */ });
}

// ----------------------------------------------------------------------------
// ROTTE
// ----------------------------------------------------------------------------

// AI e chiave dell'utente; errore comprensibile se manca qualcosa.
async function aiUtente(user) {
  const conf = await leggiImpostazione(user);
  if (!conf.attiva) return null;
  const aiKey = chiaveAi(conf.ai);
  const ai = AI_SUPPORTATE[aiKey];
  if (!ai) throw errore(400, `Assistente PM: «${conf.ai}» non è supportata: scegli «Gemini» o «ChatGPT» in Impostazioni › AI › «AI Assistente PM»`);
  const el = await getIntegration(user.user_id, ai.provider);
  const apiKey = el[`${ai.prefix}_api_key`];
  if (!apiKey) throw errore(428, `Assistente PM: collega la chiave API di ${ai.provider} in Impostazioni › AI`);
  return { aiKey, ai, apiKey };
}

// All'avvio della registrazione: assistente acceso? Risposta: { attiva:false } oppure { attiva, ai }.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const x = await aiUtente(req.user);
    res.json(x ? { attiva: true, ai: x.ai.provider } : { attiva: false });
  } catch (e) {
    if (!e.status) console.error('❌ [ASSISTENTE PM]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Avvio della sessione. Body: { id_calendar, titolo }. Poi il browser apre il WebSocket /live.
// Risposta: { attiva:false } (interruttore spento) oppure { attiva, ai, modello }.
router.post('/avvia', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = idDa(b.id_calendar);
    if (!idCalendar) throw errore(400, 'id_calendar richiesto');
    const x = await aiUtente(req.user);
    if (!x) return res.json({ attiva: false });
    const { aiKey, ai, apiKey } = x;

    const k = chiave(req.user, idCalendar);
    // Istruzioni lette PRIMA di guardare la sessione esistente: tra controllo e scrittura non
    // ci sono più attese, quindi due /avvia insieme non lasciano una sessione orfana aperta
    // verso l'AI (la seconda chiude sempre la prima). 2026-10-17
    const testoIstruzioni = await istruzioni(req.user, idCalendar, String(b.titolo || '').slice(0, 200));
    // Istruzioni e dati del progetto con i segnaposto (stessa tabella per tutta la sessione).
    const anon = piiAttivo() ? new Anonimizzatore(req.user.user_id) : null;
    const istruzioniAi = anon ? NOTA_SEGNAPOSTO + await anon.maschera(testoIstruzioni) : testoIstruzioni;
    const vecchia = sessioni.get(k);
    if (vecchia) chiudi(vecchia); // registrazione ripresa: sessione nuova
    // Al massimo MAX_SESSIONI_UTENTE sessioni aperte per utente (ognuna è un WebSocket verso
    // l'AI fino a 4 ore): oltre, si chiudono le più vecchie.
    const prefisso = chiave(req.user, '');
    const mie = [...sessioni.values()].filter((y) => !y.chiusa && y.chiave !== k && String(y.chiave).startsWith(prefisso))
      .sort((a, b2) => a.creataIl - b2.creataIl);
    while (mie.length >= MAX_SESSIONI_UTENTE) chiudi(mie.shift());
    const s = {
      chiave: k, idCalendar, apiKey, aiKey, ai, modelloIdx: 0, istruzioni: istruzioniAi, anon,
      titolo: String(b.titolo || '').trim().slice(0, 200) || 'Riunione', creataIl: Date.now(), chiusaIl: 0,
      ws: null, pronta: false, avviata: false, chiusa: false, handle: null, contestoRipresa: '', ultimoErrore: '',
      client: new Set(),
      richieste: [], inRisposta: false, risposta: '', rispostaLibera: false, domandaCorrente: '',
      attesaAudio: [], audioNuovo: false, attivitaAperta: false, audioNelBuffer: false, itemAudio: [], ricampiona: null,
      timerAudio: null, timerRisposta: null, timerPronta: null,
      riconnessioni: 0, valutazioni: 0, silenzi: 0, turniChiesti: 0, senzaRisposta: 0, senzaRispostaDiFila: 0, sblocchi: 0,
      diag: { connessioni: 0, connessaIl: 0, ultimoMsg: 0, token: null, tipi: {} },
      messaggi: [], seq: 0, ultimoUso: Date.now(),
      // Voti 👍/👎: origine di ogni suggerimento (n -> { tratto, domanda }) e voto dato.
      origini: new Map(), voti: new Map()
    };
    sessioni.set(k, s);
    aggiungi(s, 'info', `Collegamento a ${ai.nome}…`);
    connetti(s);
    res.json({ attiva: true, ai: ai.provider, modello: ai.modelli[0] });
  } catch (e) {
    if (!e.status) console.error('❌ [ASSISTENTE PM]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Domanda scritta dall'utente nella finestra. Body: { id_calendar, testo, mostra }.
router.post('/chiedi', requireAuth, (req, res) => {
  const b = req.body || {};
  const s = sessioneDi(req, idDa(b.id_calendar));
  if (!s || s.chiusa) return res.status(404).json({ error: 'Assistente PM non attivo per questa riunione' });
  const testo = String(b.testo || '').trim().slice(0, 2000);
  if (!testo) return res.status(400).json({ error: 'Scrivi una domanda' });
  // mostra: testo breve per la finestra (pulsante «Suggerisci»), altrimenti la domanda stessa.
  const mostra = String(b.mostra || '').trim().slice(0, 200) || testo;
  aggiungi(s, 'utente', mostra);
  s.richieste.push({ domanda: true, mostra, testo: `DOMANDA SCRITTA DA CHI TI USA (rispondi in modo diretto e breve, tenendo conto anche dell'audio ascoltato finora):\n${testo}` });
  // Al massimo 3 domande in attesa: le più vecchie si scartano.
  const domande = s.richieste.filter((r) => r.domanda);
  if (domande.length > 3) s.richieste = s.richieste.filter((r) => !r.domanda || domande.slice(-3).includes(r));
  prossimo(s);
  res.json({ ok: true });
});

// Messaggi della sessione (riapertura della finestra, ultimo controllo dopo «Ferma»).
// Query: id_calendar, dopo (ultimo n già mostrato).
router.get('/messaggi', requireAuth, (req, res) => {
  const s = sessioneDi(req, idDa(req.query.id_calendar));
  if (!s) return res.json({ sessione: false, attiva: false, messaggi: [] });
  const dopo = Number(req.query.dopo) || 0;
  s.ultimoUso = Date.now();
  res.json({ sessione: true, ...statoSessione(s), messaggi: s.messaggi.filter((m) => m.n > dopo).map((m) => perFinestra(s, m)) });
});

// Voto a un suggerimento della finestra. Body: { id_calendar, n, voto: 1 | -1 | 0 } (0 = tolto).
// Si salva cifrato: dal giorno dopo diventa un esempio nelle istruzioni dell'Assistente di questo
// utente (esempiDaiVoti).
router.post('/voto', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const s = sessioneDi(req, idDa(b.id_calendar));
    const n = Number(b.n);
    const voto = Number(b.voto);
    if (!s) throw errore(404, 'Sessione dell\'assistente non più disponibile');
    if (![1, -1, 0].includes(voto)) throw errore(400, 'Voto non valido');
    const msg = s.messaggi.find((m) => m.n === n && m.tipo === 'ai');
    const origine = s.origini.get(n);
    if (!msg || !origine) throw errore(404, 'Suggerimento non trovato');
    const chiaveVoto = [req.user.tenant_id, req.user.user_id, s.idCalendar, n];
    if (voto === 0) {
      await db.query('DELETE FROM pm_assistente_voti WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND n = $4', chiaveVoto);
      s.voti.delete(n);
      return res.json({ ok: true, voto: 0 });
    }
    const suggerimento = msg.testo;
    const segnale = origine.domanda ? 'RISPOSTA' : ((/^\W*([A-Z]+)/.exec(suggerimento) || [])[1] || '').slice(0, 20);
    const { data } = await encryptRowForWrite(db, 'pm_assistente_voti', {
      suggerimento: suggerimento.slice(0, 2000), tratto: origine.tratto || null
    });
    await db.query(
      `INSERT INTO pm_assistente_voti (tenant_id, user_id, id_calendar, n, ai, segnale, suggerimento, tratto, voto, crypto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, user_id, id_calendar, n)
       DO UPDATE SET voto = EXCLUDED.voto, updated_at = now()`,
      [...chiaveVoto, s.aiKey, segnale, data.suggerimento, data.tratto, voto, data.crypto ?? 0]
    );
    s.voti.set(n, voto);
    res.json({ ok: true, voto });
  } catch (e) {
    if (e.code === '42P01') return res.status(503).json({ error: 'Voti non ancora attivi: manca la tabella pm_assistente_voti (Supporto/CreaDB/assistente_pm_voti.sql)' });
    if (!e.status) console.error('❌ [ASSISTENTE PM] voto:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Fine registrazione (o chiusura della finestra). Body: { id_calendar }.
// La sessione si chiude con l'AI ma i messaggi restano CONSERVA_MS (export in Word dalla
// finestra rimasta aperta dopo «Ferma»).
// Risposta: { ok, scaricaWord } — scaricaWord = campo booleano «Download automatico file Ass PM
// AI» acceso (valore1): la finestra avvia da sola l'export in Word a fine registrazione.
// definitiva: true = pulsante «Chiudi definitivamente» della finestra (la registrazione e la
// trascrizione della riunione proseguono).
router.post('/ferma', requireAuth, async (req, res) => {
  const s = sessioneDi(req, idDa((req.body || {}).id_calendar));
  if (s && !s.chiusa) chiudi(s, false);
  let scaricaWord = false;
  try {
    const r = (await db.query(
      `SELECT valore1 FROM settings
        WHERE tenant_id = $1 AND user_id = $2
          AND lower(btrim(regexp_replace(campo, '^\\(\\*\\)\\s*', ''))) = ANY($3::text[])
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        ORDER BY id LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, CAMPI_DOWNLOAD]
    )).rows[0];
    scaricaWord = !!(r && vero(r.valore1));
  } catch (e) { console.warn('[ASSISTENTE PM] impostazione download automatico non letta:', e.message); }
  res.json({ ok: true, scaricaWord });
});

// Export in Word dei suggerimenti (con le domande scritte e le risposte). Query: id_calendar.
// Funziona durante la sessione e fino a CONSERVA_MS dopo «Ferma».
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
    const vuoto = (t) => new Paragraph({ children: [new TextRun({ text: t, italics: true, color: '6B7280' })] });
    const giorno = new Date(s.creataIl).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
    // Quanto della riunione l'assistente ha davvero valutato (2026-10-21: alla call Miroglio
    // «Nessun suggerimento» nascondeva che nessun pezzo era stato valutato).
    const numeri = [`Valutazioni: ${s.valutazioni || 0}`, s.silenzi && `senza suggerimenti: ${s.silenzi}`,
      s.senzaRisposta && `senza risposta dall'AI: ${s.senzaRisposta}`].filter(Boolean);
    const children = [
      new Paragraph({ text: `Assistente PM – ${s.titolo}`, heading: HeadingLevel.TITLE }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun({
        text: `Riunione del ${giorno} · ${s.ai.nome} · ${s.ai.modelli[s.modelloIdx]}`, color: '6B7280' })] }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: numeri.join(' · '), color: '6B7280' })] }),
      new Paragraph({ text: 'Suggerimenti dell\'assistente', heading: HeadingLevel.HEADING_1 }),
      ...(suggerimenti.length ? suggerimenti.map((m) => riga(m, m.tipo === 'utente' ? 'Tu' : 'Assistente'))
        : [vuoto(s.valutazioni ? 'Nessun suggerimento.' : 'Nessun suggerimento: la riunione non è stata valutata (vedi i numeri qui sopra).')])
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
