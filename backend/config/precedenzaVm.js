// ============================================================================
// ATTIVITÀ IN CORSO SULLA CPU DELLA VM (2026-10-20, ridotto il 2026-10-29)
// ----------------------------------------------------------------------------
// La VM ha pochi core: meglio una cosa alla volta a piena potenza che tre insieme a rilento.
// 2026-10-21 (scelta utente, dopo la call Miroglio): l'Assistente PM in modalità Testo ha la
// precedenza sulla trascrizione delle riunioni con Whisper. Finché è aperto, i blocchi della
// riunione restano in coda (jobs/meetingTranscription.js, assistenteInCorso) e ripartono a
// piena potenza quando l'assistente si chiude.
// Registrazioni e trascrizioni in corso fermano anche il riavvio della domenica
// (jobs/aggiornamentiVm.js, vmOccupata).
// 2026-10-29: tolta l'AI interna (Ollama): niente più recap locali che aspettano la VM.
// Modulo senza dipendenze: lo usano routes/assistentePm.js e jobs/meetingTranscription.js
// (segnano le attività) e jobs/aggiornamentiVm.js (controlla).
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

// Assistente PM in modalità Testo, con qualsiasi AI: trascrive i suoi blocchi con il Whisper
// dedicato della VM (routes/assistentePm.js).
export const segnaAssistente = (chiave, aperto) => segna(`ass:${chiave}`, aperto);
export const assistenteInCorso = () => { pulisci(); return [...attive.keys()].some((k) => k.startsWith('ass:')); };

// Registrazione in corso (un pezzo audio arrivato da poco, finché non arriva la fine) e pezzi in
// trascrizione con Whisper (jobs/meetingTranscription.js).
export const segnaRegistrazione = (chiave, attiva, ttlMs) => segna(`reg:${chiave}`, attiva, ttlMs);
export const segnaTrascrizione = (chiave, attiva) => segna(`whisper:${chiave}`, attiva, 30 * 60000);

export const vmOccupata = () => { pulisci(); return attive.size > 0; };
