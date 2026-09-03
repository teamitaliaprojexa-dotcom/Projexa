// ============================================================================
// PROGRAMMA: AGGIORNA TASK DA JIRA
// ----------------------------------------------------------------------------
// Nome del programma:  aggiornaJiraTask
// Sorgente:            filtro Jira indicato in jira_task ('Nome_Filtro')
// Destinazione:        task_app
//
// Gemello di aggiornaJiraQuotazioni: stessa logica, tabelle diverse. L'unica
// differenza di comportamento è l'abbinamento del cliente, che qui NON è per
// uguaglianza: il nome configurato (clients.valore2 del campo "Nome Cliente Jira
// task", es. "L2-C-MIROGLIO") deve essere CONTENUTO nel valore della colonna Jira
// (es. l'elenco delle etichette dell'issue).
//
// Lanciabile da riga di comando — quindi, in futuro, da uno schedulatore:
//
//     cd backend && node jobs/aggiornaJiraTask.js <tenant_id> <user_id>
//
// (da lanciare dalla cartella "backend": è lì che config/database.js cerca il .env)
// ============================================================================
import path from 'path';
import { fileURLToPath } from 'url';
import { runJiraSync } from './jiraSyncEngine.js';

export const NOME_PROGRAMMA = 'aggiornaJiraTask';

const CONFIG = {
  nome: NOME_PROGRAMMA,
  etichetta: 'Task Jira',
  tabellaMappatura: 'jira_task',
  tabellaDestinazione: 'task_app',
  // Colonna che identifica la riga: se il codice non c'è si inserisce, se c'è
  // (ed è ancora valido) si aggiorna.
  colonnaCodice: 'cod_task',
  // Riga di jira_task che indica la colonna Jira con il nome del cliente.
  campoCliente: 'Nome_cliente',
  campoClienteAlt: 'cliente',
  campoClients: 'Nome Cliente Jira task',
  // Abbinamento "contenuto in": il nome configurato è una porzione del testo Jira.
  confrontoCliente: 'contains',
  // link_task è mappato sulla chiave dell'issue ma deve contenere il link completo.
  colonneUrl: ['link_task']
};

export function aggiornaJiraTask(ctx) {
  return runJiraSync(CONFIG, ctx);
}

export default aggiornaJiraTask;

// --- Avvio da riga di comando ------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argomenti = process.argv.slice(2);
  const dryRun = argomenti.includes('--dry');
  const [tenantId, userId] = argomenti.filter((a) => !a.startsWith('--'));
  if (!tenantId || !userId) {
    console.error('Uso (dalla cartella backend): node jobs/aggiornaJiraTask.js <tenant_id> <user_id> [--dry]');
    console.error('  --dry = prova a vuoto: elabora e stampa il report senza scrivere sul database');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await aggiornaJiraTask({ tenantId, userId, dryRun }), null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${NOME_PROGRAMMA}: ${e.message}`);
    process.exit(1);
  }
}
