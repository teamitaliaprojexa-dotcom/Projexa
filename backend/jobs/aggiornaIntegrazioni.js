// ============================================================================
// AGGIORNA INTEGRAZIONI
// ----------------------------------------------------------------------------
// Esegue, uno dopo l'altro, i programmi di sincronizzazione (oggi Jira quotazioni
// e task) per un intero TENANT: un solo passaggio aggiorna i dati di tutti gli
// utenti, usando la configurazione Jira di chi lancia (o, se non ce l'ha, di un
// altro utente del tenant configurato). È usato sia dal pulsante «Aggiorna Integrazioni»
// della pagina Jira (routes/integrazioni.js) sia dallo schedulatore
// (jobs/scheduler.js): condividono l'elenco dei programmi e il blocco per tenant,
// così un lancio manuale e uno schedulato non possono sovrapporsi.
//
// Ogni programma è un file a sé, richiamabile anche da riga di comando: per
// aggiungerne uno basta importarlo e metterlo nell'elenco PROGRAMMI.
// ============================================================================
import { aggiornaJiraQuotazioni, NOME_PROGRAMMA as NOME_QUOTAZIONI } from './aggiornaJiraQuotazioni.js';
import { aggiornaJiraTask, NOME_PROGRAMMA as NOME_TASK } from './aggiornaJiraTask.js';
import { aggiornaIssueTicketJira, NOME_PROGRAMMA as NOME_ISSUE_TICKET } from './issueTicketJira.js';

export const PROGRAMMI = [
  { nome: NOME_QUOTAZIONI, etichetta: 'Quotazioni Jira', esegui: aggiornaJiraQuotazioni },
  { nome: NOME_TASK, etichetta: 'Task Jira', esegui: aggiornaJiraTask },
  // Dopo i Task Jira: Ticket Jira delle issue dai codici MySupport (solo se vuoto).
  { nome: NOME_ISSUE_TICKET, etichetta: 'Ticket Jira delle Issue (da MySupport)', esegui: aggiornaIssueTicketJira }
];

// Tenant con un aggiornamento in corso: due lanci contemporanei sullo stesso
// tenant (anche da utenti diversi, o manuale + schedulato) inserirebbero le
// stesse righe due volte.
const tenantInCorso = new Set();

export function aggiornamentoInCorso(tenantId) {
  return tenantInCorso.has(String(tenantId));
}

/**
 * Esegue i programmi per tutto il tenant.
 * @param {string} tenantId
 * @param {object} [opzioni]  { programmi: [nomi] } per eseguirne solo alcuni;
 *                            { utentePreferito } = utente di cui usare per primo la
 *                            configurazione Jira (chi preme il pulsante)
 * @returns {Promise<{ ok: boolean, risultati: object[] }>}
 *   Un programma che fallisce NON blocca gli altri: l'errore finisce nel suo report.
 *   Se sul tenant c'è già un aggiornamento in corso lancia un errore con
 *   code = 'IN_CORSO'.
 */
export async function eseguiAggiornaIntegrazioni(tenantId, opzioni = {}) {
  const richiesti = Array.isArray(opzioni.programmi) ? opzioni.programmi : null;
  const daEseguire = richiesti ? PROGRAMMI.filter((p) => richiesti.includes(p.nome)) : PROGRAMMI;
  if (daEseguire.length === 0) {
    throw Object.assign(new Error('Nessun programma da eseguire'), { code: 'NESSUN_PROGRAMMA' });
  }

  const chiave = String(tenantId);
  if (tenantInCorso.has(chiave)) {
    throw Object.assign(new Error('Aggiornamento già in corso per questo tenant: riprova tra qualche minuto'), { code: 'IN_CORSO' });
  }
  tenantInCorso.add(chiave);

  // Nessun userId: i programmi aggiornano tutto il tenant in un solo passaggio.
  const ctx = { tenantId, utentePreferito: opzioni.utentePreferito || null };
  const risultati = [];
  try {
    for (const programma of daEseguire) {
      const avvio = Date.now();
      try {
        const report = await programma.esegui(ctx);
        risultati.push({ ...report, etichetta: programma.etichetta, ok: true, durataMs: Date.now() - avvio });
      } catch (error) {
        console.error(`❌ ${programma.nome}:`, error.message);
        risultati.push({
          programma: programma.nome,
          etichetta: programma.etichetta,
          ok: false,
          errore: error.message,
          code: error.code || null,
          durataMs: Date.now() - avvio
        });
      }
    }
  } finally {
    tenantInCorso.delete(chiave);
  }

  return { ok: risultati.every((r) => r.ok), risultati };
}
