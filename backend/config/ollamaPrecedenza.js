// ============================================================================
// PRECEDENZE SULLA CPU DELLA VM (2026-10-20)
// ----------------------------------------------------------------------------
// La VM ha pochi core: meglio una cosa alla volta a piena potenza che tre insieme a rilento.
// Ordine (scelta dell'utente): Assistente PM (Pm projexa) > trascrizione delle riunioni > recap
// con «Projexa» (recap-projexa): il recap può aspettare qualche minuto, le altre due no.
//   - un recap non parte finché c'è una sessione Pm projexa aperta, una registrazione in corso
//     o un pezzo audio in trascrizione con Whisper (attendiVmLibera);
//   - se una di queste parte mentre un recap lavora, la richiesta del recap si interrompe
//     (suPrecedenza) e il recap riprende dallo stesso pezzo appena la VM è libera.
// Modulo senza dipendenze: lo usano routes/assistentePm.js e jobs/meetingTranscription.js
// (segnano le attività) e routes/ai.js (aspetta).
// 2026-10-21 (scelta utente, dopo la call Miroglio): l'Assistente PM in modalità Testo ha la
// precedenza anche sulla trascrizione delle riunioni con Whisper. Finché è aperto, i blocchi
// della riunione restano in coda (jobs/meetingTranscription.js, assistenteInCorso) e ripartono
// a piena potenza quando l'assistente si chiude.
// 2026-10-28: anche l'aggiornamento dei modelli (quantizzazione con imatrix, jobs/quantizzaModelli.js,
// e installazione di un adattatore, routes/analisiPm.js) ferma i lavori con «Projexa»: usa molta
// RAM fuori da Ollama. Vale anche il file LOCK_MODELLI, scritto da
// deploy/oracle/setup-modelli-imatrix.sh: copre il lancio a mano e un riavvio del backend a metà.
// ============================================================================
import fs from 'fs';

export const LOCK_MODELLI = '/var/tmp/projexa-modelli.lock';
const attive = new Map();      // chiave -> scadenza (ms; Infinity = finché non si toglie)
const ascoltatori = new Set(); // funzioni chiamate quando parte un'attività con precedenza

function pulisci() {
  const ora = Date.now();
  for (const [k, fino] of attive) if (fino <= ora) attive.delete(k);
}

// Attività con precedenza sul recap. ttlMs: si considera finita da sola dopo questo tempo senza
// rinnovi (es. registrazione chiusa male). Avvisa gli ascoltatori solo quando è NUOVA.
function segna(chiave, attiva, ttlMs = Infinity) {
  pulisci();
  if (!attiva) { attive.delete(chiave); return; }
  const nuova = !attive.has(chiave);
  attive.set(chiave, ttlMs === Infinity ? Infinity : Date.now() + ttlMs);
  if (!nuova) return;
  for (const fn of ascoltatori) {
    try { fn(chiave); } catch { /* l'ascoltatore gestisce da sé i suoi errori */ }
  }
}

// Sessione dell'Assistente PM con Pm projexa (routes/assistentePm.js).
export const segnaPmProjexa = (chiave, aperta) => segna(`pm:${chiave}`, aperta);
export const pmProjexaInCorso = () => { pulisci(); return [...attive.keys()].some((k) => k.startsWith('pm:')); };

// Assistente PM in modalità Testo, con qualsiasi AI: trascrive i suoi blocchi con il Whisper
// dedicato della VM (routes/assistentePm.js).
export const segnaAssistente = (chiave, aperto) => segna(`ass:${chiave}`, aperto);
export const assistenteInCorso = () => { pulisci(); return [...attive.keys()].some((k) => k.startsWith('ass:')); };

// Registrazione in corso (un pezzo audio arrivato da poco, finché non arriva la fine) e pezzi in
// trascrizione con Whisper (jobs/meetingTranscription.js).
export const segnaRegistrazione = (chiave, attiva, ttlMs) => segna(`reg:${chiave}`, attiva, ttlMs);
export const segnaTrascrizione = (chiave, attiva) => segna(`whisper:${chiave}`, attiva, 30 * 60000);

// Aggiornamento dei modelli di Ollama (quantizzazione o installazione di un adattatore).
export const segnaModelli = (chiave, attivo) => segna(`modelli:${chiave}`, attivo);
// File di blocco dello script: vale solo se il processo che l'ha scritto è ancora vivo.
function lockModelli() {
  try {
    const pid = Number(fs.readFileSync(LOCK_MODELLI, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // processo vivo di un altro utente (es. sudo)
  }
}
export const modelliInAggiornamento = () => { pulisci(); return [...attive.keys()].some((k) => k.startsWith('modelli:')) || lockModelli(); };

export const vmOccupata = () => { pulisci(); return attive.size > 0 || lockModelli(); };
const descrizione = () => {
  const k = [...attive.keys()];
  return [k.some((x) => x.startsWith('pm:') || x.startsWith('ass:')) && 'Assistente PM', k.some((x) => x.startsWith('reg:')) && 'registrazione in corso',
    k.some((x) => x.startsWith('whisper:')) && 'trascrizione',
    (k.some((x) => x.startsWith('modelli:')) || lockModelli()) && 'aggiornamento dei modelli di Projexa'].filter(Boolean).join(', ');
};

// Registra fn, chiamata quando parte un'attività con precedenza. Restituisce la funzione per toglierla.
export function suPrecedenza(fn) {
  ascoltatori.add(fn);
  return () => ascoltatori.delete(fn);
}

// Aspetta che la VM sia libera (al massimo maxMs: le attività dimenticate scadono da sole).
// avviso(motivo) si chiama una volta, se c'è da aspettare. true = VM libera.
export async function attendiVmLibera({ maxMs = 6 * 3600000, ogniMs = 15000, avviso = null } = {}) {
  if (!vmOccupata()) return true;
  if (avviso) avviso(descrizione());
  const fine = Date.now() + maxMs;
  while (vmOccupata() && Date.now() < fine) await new Promise((r) => setTimeout(r, ogniMs));
  return !vmOccupata();
}
