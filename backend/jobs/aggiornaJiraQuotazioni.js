// ============================================================================
// PROGRAMMA: AGGIORNA QUOTAZIONI DA JIRA
// ----------------------------------------------------------------------------
// Nome del programma:  aggiornaJiraQuotazioni
// Sorgente:            filtro Jira indicato in jira_quotazioni ('Nome_Filtro')
// Destinazione:        cl_quotazioni
//
// È un programma a sé stante: lo richiama il pulsante «Aggiorna Integrazioni»
// della dashboard (routes/integrazioni.js) e può essere lanciato da riga di
// comando — quindi, in futuro, da uno schedulatore:
//
//     cd backend && node jobs/aggiornaJiraQuotazioni.js <tenant_id> <user_id>
//
// (da lanciare dalla cartella "backend": è lì che config/database.js cerca il .env)
//
// La logica di dettaglio (mappatura, abbinamento cliente, insert/update,
// cifratura) sta in jobs/jiraSyncEngine.js: qui c'è solo la configurazione.
// ============================================================================
import path from 'path';
import { fileURLToPath } from 'url';
import { runJiraSync } from './jiraSyncEngine.js';

export const NOME_PROGRAMMA = 'aggiornaJiraQuotazioni';

const CONFIG = {
  nome: NOME_PROGRAMMA,
  etichetta: 'Quotazioni Jira',
  tabellaMappatura: 'jira_quotazioni',
  tabellaDestinazione: 'cl_quotazioni',
  // Colonna che identifica la riga: se il codice non c'è si inserisce, se c'è
  // (ed è ancora valido) si aggiorna.
  colonnaCodice: 'codice',
  // Riga di jira_quotazioni che indica la colonna Jira con il nome del cliente.
  // In configurazione la riga si chiama 'cliente'; 'Nome_cliente' resta accettato
  // come alternativa, così la stessa impostazione vale anche per i task.
  campoCliente: 'cliente',
  campoClienteAlt: 'Nome_cliente',
  // Il nome del cliente su Jira è scritto in clients.valore2 di questo campo.
  campoClients: 'Nome Cliente Jira Quot',
  // Abbinamento per uguaglianza: il valore Jira è esattamente il nome configurato.
  confrontoCliente: 'exact',
  colonneUrl: ['url'],
  // Impostazioni -> Integrazioni: secondo filtro Jira usato SOLO per aggiornare
  // quotazioni già presenti (tipicamente quelle che il filtro principale non estrae
  // più). Se il campo è vuoto, il passaggio non viene eseguito.
  campoFiltroAggiuntivo: 'Filtro aggiuntivo Quotazioni (solo agg)'
};

export function aggiornaJiraQuotazioni(ctx) {
  return runJiraSync(CONFIG, ctx);
}

export default aggiornaJiraQuotazioni;

// --- Avvio da riga di comando ------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argomenti = process.argv.slice(2);
  const dryRun = argomenti.includes('--dry');
  const [tenantId, userId] = argomenti.filter((a) => !a.startsWith('--'));
  if (!tenantId || !userId) {
    console.error('Uso (dalla cartella backend): node jobs/aggiornaJiraQuotazioni.js <tenant_id> <user_id> [--dry]');
    console.error('  --dry = prova a vuoto: elabora e stampa il report senza scrivere sul database');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await aggiornaJiraQuotazioni({ tenantId, userId, dryRun }), null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${NOME_PROGRAMMA}: ${e.message}`);
    process.exit(1);
  }
}
