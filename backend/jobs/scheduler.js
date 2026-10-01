// ============================================================================
// SCHEDULATORE DEI JOB (tabella job_schedules, vedi Supporto/CreaDB/job_schedules.sql)
// ----------------------------------------------------------------------------
// Gira dentro il backend, quindi sul SERVER: i job partono anche a computer spento.
// Si attiva SOLO con JOB_SCHEDULER_ENABLED=true nel .env (da impostare solo sulla VM):
// il backend locale usa lo stesso database di produzione e, senza questa variabile,
// lancerebbe gli stessi job una seconda volta.
//
// Ogni minuto:
//   1. alle righe attive senza prossima_esecuzione calcola la prossima;
//   2. "prenota" sul database le righe con prossima_esecuzione <= adesso
//      (in_esecuzione_dal = now(), con FOR UPDATE SKIP LOCKED: anche con due backend
//      accesi una stessa esecuzione parte una volta sola) e le esegue;
//   3. salva esito e report in ultima_* e calcola la prossima esecuzione.
// Se il server era spento all'ora prevista, al riavvio l'esecuzione persa viene fatta
// una volta sola e poi si riprende dal calendario.
// Il riepilogo resta solo in job_schedules.ultimo_report: nessuna notifica all'utente.
// ============================================================================
import db from '../config/database.js';
import { eseguiAggiornaIntegrazioni } from './aggiornaIntegrazioni.js';
import { eseguiBackupDb, eseguiCopiaStaging } from './scriptVm.js';

// Job schedulabili: la chiave è il valore di job_schedules.job.
const JOBS = {
  // utente_config (colonna) = utente di cui usare la configurazione Jira (mappatura,
  // filtri, token); NULL = il primo utente del tenant configurato. I dati aggiornati
  // sono comunque quelli di tutto il tenant. parametri.programmi (facoltativo) =
  // eseguire solo alcuni programmi.
  aggiorna_integrazioni: (riga) =>
    eseguiAggiornaIntegrazioni(riga.tenant_id, {
      programmi: riga.parametri && riga.parametri.programmi,
      utentePreferito: riga.utente_config || (riga.parametri && riga.parametri.utente_config) || null
    }),
  // Job di sistema (script della VM, vedi scriptVm.js): riguardano tutti i database,
  // tenant e utente_config della riga servono solo a indicare chi li "possiede".
  backup_db: () => eseguiBackupDb(),
  copia_staging_neon: () => eseguiCopiaStaging()
};

// Nomi dei job schedulabili (usati dalla pagina di gestione per l'elenco a discesa).
export const NOMI_JOB = Object.keys(JOBS);

// Descrizione dei job per la pagina; jira = utente_config è la configurazione Jira da usare.
export const INFO_JOB = {
  aggiorna_integrazioni: { etichetta: 'Aggiorna Integrazioni (Jira)', jira: true },
  backup_db: { etichetta: 'Backup database VM su Object Storage', jira: false },
  copia_staging_neon: { etichetta: 'Copia database VM su staging Neon', jira: false }
};

export function schedulerAttivo() {
  return String(process.env.JOB_SCHEDULER_ENABLED || '').toLowerCase() === 'true';
}

const TICK_MS = 60 * 1000;
// Una riga rimasta "in esecuzione" oltre questo tempo (backend riavviato a metà) torna eseguibile.
const BLOCCO_SCADUTO = '3 hours';

// ----------------------------------------------------------------------------
// CALENDARIO (ore locali del fuso orario della riga, es. Europe/Rome con ora legale)
// ----------------------------------------------------------------------------

// Parti di data/ora di un istante nel fuso orario indicato.
function partiLocali(date, tz) {
  const parti = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date);
  const v = Object.fromEntries(parti.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return { y: v.year, m: v.month, d: v.day, h: v.hour, mi: v.minute, s: v.second };
}

// Scarto (ms) fra l'ora locale del fuso e UTC in un dato istante.
function scartoFuso(date, tz) {
  const p = partiLocali(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

// Istante corrispondente a una data/ora locale del fuso (due passaggi per il cambio d'ora).
function daOraLocale(y, m, d, h, mi, tz) {
  const ipotesi = Date.UTC(y, m - 1, d, h, mi);
  let t = ipotesi - scartoFuso(new Date(ipotesi), tz);
  t = ipotesi - scartoFuso(new Date(t), tz);
  return new Date(t);
}

function minutiDa(ora) {
  const [h, mi] = String(ora || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (mi || 0);
}

/**
 * Prima esecuzione prevista dalla riga successiva all'istante "dopo" (o null).
 * Slot = ora_inizio, ora_inizio + intervallo, ... finché <= ora_fine, nei giorni ammessi.
 */
export function calcolaProssima(riga, dopo = new Date()) {
  const tz = riga.fuso_orario || 'Europe/Rome';
  const giorni = new Set((riga.giorni_settimana || []).map(Number));
  const inizio = minutiDa(riga.ora_inizio);
  const fine = minutiDa(riga.ora_fine);
  const passo = Math.max(5, Number(riga.intervallo_minuti) || 60);
  if (giorni.size === 0) return null;

  const oggi = partiLocali(dopo, tz);
  for (let offset = 0; offset <= 14; offset++) {
    const giorno = new Date(Date.UTC(oggi.y, oggi.m - 1, oggi.d + offset));
    const y = giorno.getUTCFullYear();
    const m = giorno.getUTCMonth() + 1;
    const d = giorno.getUTCDate();
    const settimana = giorno.getUTCDay() || 7; // 1 = lunedì ... 7 = domenica
    if (!giorni.has(settimana)) continue;
    for (let t = inizio; t <= fine; t += passo) {
      const istante = daOraLocale(y, m, d, Math.floor(t / 60), t % 60, tz);
      if (istante.getTime() > dopo.getTime()) return istante;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// ESECUZIONE
// ----------------------------------------------------------------------------

let giroInCorso = false;
let tabellaMancanteSegnalata = false;

async function impostaProssimeMancanti() {
  const { rows } = await db.query(
    'SELECT * FROM job_schedules WHERE attivo AND prossima_esecuzione IS NULL AND in_esecuzione_dal IS NULL'
  );
  for (const riga of rows) {
    const prossima = calcolaProssima(riga);
    await db.query('UPDATE job_schedules SET prossima_esecuzione = $2, updated_at = now() WHERE id = $1',
      [riga.id, prossima]);
    console.log(`[SCHEDULER] ${riga.job} (${riga.descrizione || riga.id}): prossima esecuzione ${prossima ? prossima.toISOString() : 'nessuna'}`);
  }
}

// Prenota una riga da eseguire (o null se non ce ne sono).
async function prenotaProssima() {
  const { rows } = await db.query(
    `UPDATE job_schedules SET in_esecuzione_dal = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM job_schedules
         WHERE attivo AND prossima_esecuzione <= now()
           AND (in_esecuzione_dal IS NULL OR in_esecuzione_dal < now() - interval '${BLOCCO_SCADUTO}')
         ORDER BY prossima_esecuzione
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`
  );
  return rows[0] || null;
}

// Problemi contenuti nel report di «Aggiorna Integrazioni»: programmi non eseguiti e
// utenti non aggiornati (es. Jira scollegato o autorizzazione scaduta). Senza questo
// controllo un giro in cui nessuno è stato aggiornato risulterebbe comunque "ok".
function problemiDelReport(report) {
  const problemi = [];
  for (const p of (report && Array.isArray(report.risultati)) ? report.risultati : []) {
    const nome = p.etichetta || p.programma;
    if (!p.ok) { problemi.push(`${nome}: ${p.errore || 'non eseguito'}`); continue; }
    for (const u of Array.isArray(p.utenti) ? p.utenti : []) {
      if (!u.ok) problemi.push(`${nome} - ${u.nome || u.userId}: ${u.errore || 'non aggiornato'}`);
      const righe = u.report && Array.isArray(u.report.errori) ? u.report.errori.length : 0;
      if (u.ok && righe) problemi.push(`${nome} - ${u.nome || u.userId}: ${righe} avvisi/righe non elaborate (vedi report)`);
    }
  }
  return problemi;
}

async function esegui(riga) {
  const avvio = new Date();
  let esito = 'ok';
  let errore = null;
  let report = null;

  const job = JOBS[riga.job];
  if (!job) {
    esito = 'fallito';
    errore = `Job sconosciuto: ${riga.job}`;
  } else {
    try {
      report = await job(riga);
      const problemi = problemiDelReport(report);
      if ((report && report.ok === false) || problemi.length) esito = 'errori';
      if (problemi.length) errore = problemi.join('\n');
    } catch (e) {
      // Un lancio manuale sullo stesso tenant è già in corso: questo giro si salta.
      esito = e.code === 'IN_CORSO' ? 'saltato' : 'fallito';
      errore = e.message;
      report = e.report || null;
    }
  }

  const durata = Date.now() - avvio.getTime();
  const prossima = calcolaProssima(riga, new Date());
  await db.query(
    `UPDATE job_schedules
        SET ultima_esecuzione = $2, ultimo_esito = $3, ultimo_errore = $4, ultima_durata_ms = $5,
            ultimo_report = $6, prossima_esecuzione = $7, in_esecuzione_dal = NULL, updated_at = now()
      WHERE id = $1`,
    [riga.id, avvio, esito, errore, durata, report ? JSON.stringify(report) : null, prossima]
  );
  console.log(`[SCHEDULER] ${riga.job} (${riga.descrizione || riga.id}): ${esito} in ${Math.round(durata / 1000)} s` +
    `${errore ? ` - ${errore}` : ''}; prossima ${prossima ? prossima.toISOString() : 'nessuna'}`);
}

// Interruttore generale (tabella job_scheduler_stato, pulsante «Sospendi» della pagina
// Schedulazioni): false = nessun job parte. Tabella assente = non sospeso.
export async function schedulerSospeso() {
  try {
    const r = await db.query('SELECT attivo FROM job_scheduler_stato WHERE id = 1');
    return r.rows.length > 0 && r.rows[0].attivo === false;
  } catch (e) {
    if (e.code === '42P01') return false;
    throw e;
  }
}

let sospensioneSegnalata = false;

async function giro() {
  if (giroInCorso) return; // un job lungo non fa partire giri sovrapposti
  giroInCorso = true;
  try {
    if (await schedulerSospeso()) {
      if (!sospensioneSegnalata) console.log('[SCHEDULER] Sospeso dalla pagina Schedulazioni: nessun job viene eseguito');
      sospensioneSegnalata = true;
      return;
    }
    if (sospensioneSegnalata) console.log('[SCHEDULER] Riattivato');
    sospensioneSegnalata = false;
    await impostaProssimeMancanti();
    for (let riga = await prenotaProssima(); riga; riga = await prenotaProssima()) {
      await esegui(riga);
    }
    tabellaMancanteSegnalata = false;
  } catch (e) {
    if (e.code === '42P01') { // tabella job_schedules non ancora creata
      if (!tabellaMancanteSegnalata) console.warn('[SCHEDULER] Tabella job_schedules assente: eseguire Supporto/CreaDB/job_schedules.sql');
      tabellaMancanteSegnalata = true;
    } else {
      console.error('[SCHEDULER] Errore:', e.message);
    }
  } finally {
    giroInCorso = false;
  }
}

export function avviaScheduler() {
  if (!schedulerAttivo()) {
    console.log('[SCHEDULER] Disattivato (JOB_SCHEDULER_ENABLED non è true)');
    return;
  }
  console.log('[SCHEDULER] Attivo: controllo delle schedulazioni ogni minuto');
  // Primo giro poco dopo l'avvio, per non rallentare la partenza del server.
  setTimeout(giro, 15 * 1000);
  setInterval(giro, TICK_MS);
}
