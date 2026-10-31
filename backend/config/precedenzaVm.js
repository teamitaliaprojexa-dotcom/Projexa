// ============================================================================
// ATTIVITÀ IN CORSO SULLA CPU DELLA VM (2026-10-20, ridotto il 2026-10-29)
// ----------------------------------------------------------------------------
// La VM ha pochi core: meglio una cosa alla volta a piena potenza che tre insieme a rilento.
// Registrazioni e trascrizioni in corso fermano il riavvio della domenica
// (jobs/aggiornamentiVm.js, vmOccupata).
// 2026-10-29: tolta l'AI interna (Ollama): niente più recap locali che aspettano la VM.
// 2026-10-31: tolta la precedenza dell'Assistente PM in modalità Testo (l'assistente ora manda
// solo audio all'AI esterna e non usa più il Whisper della VM).
// Modulo senza dipendenze: lo usa jobs/meetingTranscription.js (segna le attività) e
// jobs/aggiornamentiVm.js (controlla).
// ============================================================================

const attive = new Map(); // chiave -> scadenza (ms; Infinity = finché non si toglie)

function pulisci() {
  const ora = Date.now();
  for (const [k, fino] of attive) if (fino <= ora) attive.delete(k);
}

// ttlMs: l'attività si considera finita da sola dopo questo tempo senza rinnovi (es.
// registrazione chiusa male).
function segna(chiave, attiva, ttlMs = Infinity) {
  pulisci();
  if (!attiva) { attive.delete(chiave); return; }
  attive.set(chiave, ttlMs === Infinity ? Infinity : Date.now() + ttlMs);
}

// Registrazione in corso (un pezzo audio arrivato da poco, finché non arriva la fine) e pezzi in
// trascrizione con Whisper (jobs/meetingTranscription.js).
export const segnaRegistrazione = (chiave, attiva, ttlMs) => segna(`reg:${chiave}`, attiva, ttlMs);
export const segnaTrascrizione = (chiave, attiva) => segna(`whisper:${chiave}`, attiva, 30 * 60000);

export const vmOccupata = () => { pulisci(); return attive.size > 0; };
