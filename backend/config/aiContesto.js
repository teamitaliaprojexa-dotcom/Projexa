// Contesto delle chiamate AI eseguite in modalità BATCH (jobs/aiLavori.js).
// Mentre un "lavoro AI" rigioca in background la richiesta originale (Kick-off, Offerta,
// Dossier, funzioni PM...), askAiProvider (routes/ai.js) trova qui la funzione attendiBatch e
// manda la richiesta con la Batch API del fornitore invece che "subito".
// Modulo a parte per evitare import circolari tra routes/ai.js e jobs/aiLavori.js.
import { AsyncLocalStorage } from 'async_hooks';

export const contestoAi = new AsyncLocalStorage();
