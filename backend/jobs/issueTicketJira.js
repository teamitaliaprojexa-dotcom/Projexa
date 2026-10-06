// ============================================================================
// PROGRAMMA: TICKET JIRA DELLE ISSUE DA MYSUPPORT
// ----------------------------------------------------------------------------
// Nome del programma:  issueTicketJira
// Per ogni issue del tenant con il campo MySupport (issue.mysupport) compilato e il campo
// Ticket Jira (issue.tkt_jira) VUOTO, cerca i ticket Jira che citano quel codice MySupport:
//   - Task Jira:       task_app.ticket_correlati contiene il codice  -> task_app.cod_task
//   - Quotazioni Jira: cl_quotazioni.tkt_apertura contiene il codice -> cl_quotazioni.codice
// e scrive in issue.tkt_jira i codici trovati (più ticket separati da "/", es.
// ADFPE-299/ADFPE-300).
// Un Ticket Jira già compilato non viene mai toccato (scelta dell'utente, 2026-10-06).
//
// Gira dentro «Aggiorna Integrazioni» (jobs/aggiornaIntegrazioni.js), dopo i Task Jira:
// così usa i ticket appena sincronizzati. Si può lanciare anche da riga di comando:
//
//     cd backend && node jobs/issueTicketJira.js <tenant_id> [--dry]
//
// Confronto "contenuto in" fatto per PAROLE (lettere/cifre): il codice 1234 non viene
// trovato dentro 12345; funzionano elenchi come "16768963, 16769021" o "MS-16768963".
// I valori possono essere cifrati: si leggono dal pool (che decifra) e si confrontano qui;
// la scrittura passa da encryptRowForWrite (cifra se la riga lo prevede).
// ============================================================================
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';

export const NOME_PROGRAMMA = 'issueTicketJira';

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const parole = (testo) => String(testo == null ? '' : testo).split(/[^0-9A-Za-z_-]+/).map(norm).filter(Boolean);

/**
 * ctx = { tenantId, dryRun? }. Restituisce il report per il riepilogo di Aggiorna Integrazioni.
 */
export async function aggiornaIssueTicketJira(ctx) {
  const tenantId = ctx && ctx.tenantId;
  if (!tenantId) throw new Error('Contesto mancante: tenant_id');
  const dryRun = !!(ctx && ctx.dryRun);
  const report = {
    programma: NOME_PROGRAMMA,
    tipo: 'issue-mysupport',
    dryRun,
    issueConMySupport: 0,
    aggiornate: 0,
    giaCompilate: 0,
    senzaTicket: 0,
    errori: []
  };

  // 1) Ticket Jira che citano codici MySupport: parola (codice) -> codici Jira.
  //    Fonti: Task Jira (task_app.ticket_correlati -> cod_task) e Quotazioni Jira
  //    (cl_quotazioni.tkt_apertura -> codice). Una colonna mancante si segnala e si salta.
  const FONTI = [
    { tabella: 'task_app', testo: 'ticket_correlati', codice: 'cod_task', nome: 'Task Jira' },
    { tabella: 'cl_quotazioni', testo: 'tkt_apertura', codice: 'codice', nome: 'Quotazioni Jira' }
  ];
  const ticketPerCodice = new Map();
  for (const f of FONTI) {
    let righe;
    try {
      righe = (await db.query(
        `SELECT "${f.codice}" AS cod, "${f.testo}" AS testo FROM "${f.tabella}"
          WHERE tenant_id = $1 AND "${f.testo}" IS NOT NULL AND "${f.codice}" IS NOT NULL`,
        [tenantId]
      )).rows;
    } catch (e) {
      if (e.code === '42703' || e.code === '42P01') {
        report.errori.push(`${f.nome}: colonna ${f.tabella}.${f.testo} non trovata, fonte saltata`);
        continue;
      }
      throw e;
    }
    for (const t of righe) {
      const cod = String(t.cod || '').trim();
      if (!cod) continue;
      for (const p of new Set(parole(t.testo))) {
        if (!ticketPerCodice.has(p)) ticketPerCodice.set(p, new Set());
        ticketPerCodice.get(p).add(cod);
      }
    }
  }

  // 2) Issue del tenant con MySupport compilato.
  const issues = (await db.query(
    'SELECT id, mysupport, tkt_jira FROM issue WHERE tenant_id = $1 AND mysupport IS NOT NULL',
    [tenantId]
  )).rows.filter((r) => String(r.mysupport || '').trim());
  report.issueConMySupport = issues.length;

  for (const issue of issues) {
    if (String(issue.tkt_jira || '').trim()) { report.giaCompilate += 1; continue; }
    const trovati = new Set();
    for (const p of parole(issue.mysupport)) {
      for (const cod of ticketPerCodice.get(p) || []) trovati.add(cod);
    }
    if (!trovati.size) { report.senzaTicket += 1; continue; }
    const valore = [...trovati].sort().join('/');
    try {
      if (!dryRun) {
        const { data: dati } = await encryptRowForWrite(db, 'issue', { tkt_jira: valore }, { id: issue.id });
        const cols = Object.keys(dati);
        // Condizione ripetuta in UPDATE: se nel frattempo qualcuno l'ha compilato, non si tocca.
        await db.query(
          `UPDATE issue SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
            WHERE id = $${cols.length + 1} AND tenant_id = $${cols.length + 2}
              AND (tkt_jira IS NULL OR BTRIM(tkt_jira::text) = '')`,
          [...cols.map((c) => dati[c]), issue.id, tenantId]
        );
      }
      report.aggiornate += 1;
    } catch (e) {
      report.errori.push(`Issue ${issue.id}: ${e.message}`);
      if (report.errori.length >= 20) { report.errori.push('… ulteriori errori non elencati'); break; }
    }
  }
  if (report.aggiornate) console.log(`[${NOME_PROGRAMMA}] ${report.aggiornate} issue con Ticket Jira da MySupport`);
  return report;
}

export default aggiornaIssueTicketJira;

// --- Avvio da riga di comando ------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argomenti = process.argv.slice(2);
  const [tenantId] = argomenti.filter((a) => !a.startsWith('--'));
  if (!tenantId) {
    console.error('Uso (dalla cartella backend): node jobs/issueTicketJira.js <tenant_id> [--dry]');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await aggiornaIssueTicketJira({ tenantId, dryRun: argomenti.includes('--dry') }), null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${NOME_PROGRAMMA}: ${e.message}`);
    process.exit(1);
  }
}
