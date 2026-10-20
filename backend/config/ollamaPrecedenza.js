// ============================================================================
// PRECEDENZA DELL'ASSISTENTE PM SU OLLAMA DELLA VM (2026-10-20)
// ----------------------------------------------------------------------------
// Sulla VM Ollama tiene in memoria al massimo 2 modelli (OLLAMA_MAX_LOADED_MODELS=2: pm-projexa
// e il filtro 3B dell'Assistente PM) e lavora una richiesta alla volta. I recap con «Projexa»
// (recap-projexa) possono aspettare qualche minuto, l'Assistente PM durante una call no:
//   - un recap non parte finché c'è una sessione Pm projexa aperta (attendiPmLibero);
//   - se una sessione si apre mentre un recap è in corso, la richiesta del recap si interrompe
//     (suAvvioPm) e il recap riprende dallo stesso pezzo a call finita.
// Modulo senza dipendenze: lo usano routes/assistentePm.js (segna) e routes/ai.js (aspetta).
// ============================================================================

const attive = new Set();      // chiavi delle sessioni Pm projexa aperte
const ascoltatori = new Set(); // funzioni chiamate all'apertura di una sessione

export function segnaPmProjexa(chiave, aperta) {
  if (!aperta) { attive.delete(chiave); return; }
  if (attive.has(chiave)) return;
  attive.add(chiave);
  for (const fn of ascoltatori) {
    try { fn(); } catch { /* l'ascoltatore gestisce da sé i suoi errori */ }
  }
}

export const pmProjexaInCorso = () => attive.size > 0;

// Registra fn, chiamata quando si apre una sessione Pm projexa. Restituisce la funzione per toglierla.
export function suAvvioPm(fn) {
  ascoltatori.add(fn);
  return () => ascoltatori.delete(fn);
}

// Aspetta che non ci siano sessioni Pm projexa aperte (al massimo maxMs: una sessione
// dimenticata aperta si chiude da sola dopo 4 ore di inattività). true = VM libera.
export async function attendiPmLibero({ maxMs = 5 * 3600000, ogniMs = 30000, avviso = null } = {}) {
  if (!attive.size) return true;
  if (avviso) avviso();
  const fine = Date.now() + maxMs;
  while (attive.size && Date.now() < fine) await new Promise((r) => setTimeout(r, ogniMs));
  return !attive.size;
}
