// ============================================================================
// AGGIORNAMENTI AUTOMATICI DELLA VM (job «aggiornamenti_vm», 2026-10-23)
// ----------------------------------------------------------------------------
// Ogni domenica alle 7:00 (dopo le schedulazioni notturne, a VM ferma). Scelte dell'utente:
//   1. in automatico SOLO gli aggiornamenti di sicurezza: sudo dnf upgrade --security, ESCLUSI
//      PostgreSQL, Caddy e Node.js (restano manuali dalla pagina Monitor › Aggiornamenti: se non
//      ripartono, Projexa resta giù fino a lunedì senza che nessuno se ne accorga);
//   2. anche il kernel (kernel-uek*): si installa accanto a quello in uso, vale dal riavvio;
//   3. riavvio della VM SOLO se serve (dnf needs-restarting -r) e la VM è libera: nessuna
//      registrazione, trascrizione, Assistente PM, recap o lavoro di Projexa in corso, nessun
//      altro job in esecuzione. Occupata = riavvio rimandato alla domenica dopo;
//   4. controllo dei servizi (gli stessi della pagina Monitor) dopo l'aggiornamento e, se c'è
//      stato, dopo il riavvio;
//   5. notifica in campanella con l'esito al proprietario della schedulazione (utente_config).
// Il riavvio parte con «shutdown -r +1»: il job finisce e lo schedulatore ne registra l'esito.
// Prima si scrive MARCATORE (in /var/tmp, che sopravvive al riavvio): all'avvio del server
// completaDopoRiavvio() controlla i servizi, manda la seconda notifica e lo cancella.
// ============================================================================
import fs from 'fs';
import { execFile } from 'child_process';
import db from '../config/database.js';
import { sudoDnf, riavvioNecessario, statoInstallazione, serviceUnits, serviceStates } from '../routes/vm-monitor.js';
import { vmOccupata } from '../config/ollamaPrecedenza.js';
import { lavoriProjexaInCorso } from '../config/lavoriProjexa.js';
import { fileRiunioniAttive } from './filaRiunione.js';
import { notificaSistema } from './notifiche.js';

const ESCLUSI = ['postgresql*', 'caddy*', 'nodejs*'];
const MARCATORE = '/var/tmp/projexa-aggiornamenti-auto.json';
const ATTESA_SERVIZI_MS = 3 * 60000; // dopo l'avvio: tempo per far partire Whisper, Ollama...
const RIGHE_LOG = 40;

const righe = (r) => `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trimEnd()).filter(Boolean);

// Pacchetti aggiornati, letti dall'output di dnf (sezione «Upgraded:» / «Installed:»).
function pacchettiAggiornati(testo) {
  const out = [];
  let dentro = false;
  for (const l of testo) {
    if (/^(Upgraded|Installed|Aggiornat|Installat)/i.test(l.trim())) { dentro = true; continue; }
    if (/^(Complete!|Completato)/i.test(l.trim())) dentro = false;
    if (dentro) out.push(...l.trim().split(/\s+/).filter((x) => /\.(aarch64|x86_64|noarch)$/.test(x)));
  }
  return [...new Set(out)];
}

// Servizi non attivi tra quelli del Monitor (PM2 compreso: Projexa).
async function serviziFermi() {
  const stati = await serviceStates(serviceUnits());
  return stati.filter((s) => s.state !== 'active' && !(s.unit === 'pm2-opc' && s.state === 'activating'))
    .map((s) => `${s.label} (${s.state})`);
}

// Motivi per cui adesso la VM NON va riavviata (elenco vuoto = libera).
async function motiviVmOccupata(rigaId) {
  const motivi = [];
  if (vmOccupata()) motivi.push('registrazione, trascrizione, Assistente PM o aggiornamento dei modelli in corso');
  const lavori = lavoriProjexaInCorso();
  if (lavori.length) motivi.push(`${lavori.length} lavor${lavori.length === 1 ? 'o' : 'i'} di Projexa in corso (${lavori.map((l) => l.cosa).join(', ')})`);
  if (fileRiunioniAttive()) motivi.push('recap o recap interni in fila');
  const q = async (sql, params = []) => { try { return Number((await db.query(sql, params)).rows[0].n) || 0; } catch { return 0; } };
  const coda = await q(`SELECT count(*) AS n FROM rec_meeting_chunks`);
  if (coda) motivi.push(`${coda} blocchi di riunioni in coda (trascrizione o recap)`);
  const ai = await q(`SELECT count(*) AS n FROM ai_lavori WHERE stato = 'in_corso'`);
  if (ai) motivi.push(`${ai} lavori AI in corso`);
  const job = await q(`SELECT count(*) AS n FROM job_schedules WHERE in_esecuzione_dal IS NOT NULL AND id <> $1`, [rigaId]);
  if (job) motivi.push(`${job} altre schedulazioni in esecuzione`);
  return motivi;
}

function riavvia() {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-n', 'shutdown', '-r', '+1', 'Projexa: riavvio dopo gli aggiornamenti automatici'], { timeout: 30000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
}

const notifica = (riga, titolo, messaggio) =>
  notificaSistema({ tenantId: riga.tenant_id, userId: riga.utente_config, titolo, messaggio });

export async function eseguiAggiornamentiVm(riga) {
  if (process.platform !== 'linux') throw new Error('Aggiornamenti automatici eseguibili solo sulla VM (Oracle Linux)');
  if (statoInstallazione()?.inCorso) {
    return { ok: true, saltato: true, riepilogo: 'Installazione dalla pagina Aggiornamenti già in corso: giro saltato' };
  }
  const log = [];
  const escludi = ESCLUSI.map((p) => `--exclude=${p}`);

  // 1. Sicurezza (senza PostgreSQL, Caddy, Node.js).
  const sic = await sudoDnf(['upgrade', '--security', '-y', ...escludi], 45 * 60000);
  const outSic = righe(sic);
  const aggSic = pacchettiAggiornati(outSic);
  log.push(`dnf upgrade --security: ${sic.codice === 0 ? 'ok' : `errore (codice ${sic.codice})`}, ${aggSic.length} pacchetti`);
  // 2. Kernel (anche le versioni di sole correzioni): affiancato a quello in uso.
  const ker = await sudoDnf(['upgrade', '-y', 'kernel-uek*'], 30 * 60000);
  const outKer = righe(ker);
  const aggKer = pacchettiAggiornati(outKer);
  log.push(`dnf upgrade kernel-uek*: ${ker.codice === 0 ? 'ok' : `errore (codice ${ker.codice})`}, ${aggKer.length} pacchetti`);
  log.push(...[...outSic, ...outKer].slice(-RIGHE_LOG));

  const errori = [];
  if (sic.codice !== 0) errori.push(`aggiornamenti di sicurezza: ${outSic.filter((l) => /error|errore/i.test(l)).slice(-1)[0] || `codice ${sic.codice}`}`);
  if (ker.codice !== 0) errori.push(`kernel: ${outKer.filter((l) => /error|errore/i.test(l)).slice(-1)[0] || `codice ${ker.codice}`}`);
  const aggiornati = [...new Set([...aggSic, ...aggKer])];

  // 3. Servizi dopo l'aggiornamento (es. openssh riavvia sshd da solo).
  const fermi = await serviziFermi();

  // 4. Riavvio: solo se serve e se la VM è libera.
  const r = await riavvioNecessario();
  let riavvio = 'non necessario';
  let motivi = [];
  if (r === null) riavvio = 'non verificabile (dnf needs-restarting non disponibile)';
  else if (r.necessario) {
    motivi = await motiviVmOccupata(riga.id);
    if (motivi.length) riavvio = 'rimandato';
    else if (fermi.length) { riavvio = 'rimandato'; motivi = ['servizi già fermi prima del riavvio: meglio controllarli prima']; }
    else {
      fs.writeFileSync(MARCATORE, JSON.stringify({ creato: new Date().toISOString(), tenantId: riga.tenant_id, userId: riga.utente_config, aggiornati }));
      try {
        await riavvia();
        riavvio = 'programmato tra 1 minuto';
      } catch (e) {
        fs.rmSync(MARCATORE, { force: true });
        riavvio = 'non riuscito';
        errori.push(`riavvio: ${e.message}`);
      }
    }
  }
  log.push(`Riavvio: ${riavvio}${motivi.length ? ` (${motivi.join('; ')})` : ''}`);
  if (fermi.length) log.push(`Servizi non attivi: ${fermi.join(', ')}`);

  // 5. Notifica.
  const parti = [
    aggiornati.length ? `Aggiornati ${aggiornati.length} pacchetti: ${aggiornati.slice(0, 15).join(', ')}${aggiornati.length > 15 ? '…' : ''}.` : 'Nessun aggiornamento di sicurezza o del kernel da installare.',
    `Riavvio della VM: ${riavvio}${motivi.length ? ` (${motivi.join('; ')}): si riprova domenica prossima` : ''}.`,
    fermi.length ? `ATTENZIONE, servizi non attivi: ${fermi.join(', ')}.` : 'Servizi tutti attivi.',
    errori.length ? `Errori: ${errori.join(' | ')}.` : '',
    'PostgreSQL, Caddy e Node.js non sono aggiornati in automatico: vedi Monitor › Aggiornamenti.'
  ].filter(Boolean);
  const problemi = errori.length || fermi.length;
  const titolo = problemi ? 'Aggiornamenti VM: da controllare'
    : riavvio === 'programmato tra 1 minuto' ? 'Aggiornamenti VM installati, riavvio in corso'
      : aggiornati.length ? 'Aggiornamenti VM installati' : 'Aggiornamenti VM: nulla da installare';
  // Senza novità e senza problemi niente notifica (ogni domenica sarebbe rumore).
  if (aggiornati.length || problemi || riavvio !== 'non necessario') await notifica(riga, titolo, parti.join(' '));

  const riepilogo = `${aggiornati.length} pacchetti aggiornati, riavvio ${riavvio}${fermi.length ? `, servizi fermi: ${fermi.length}` : ''}${errori.length ? `, errori: ${errori.length}` : ''}`;
  console.log(`[AGGIORNAMENTI AUTO] ${riepilogo}`);
  return { ok: !problemi, riepilogo, aggiornati, riavvio, motivi, serviziFermi: fermi, errori, log };
}

// All'avvio del server: se il riavvio l'ha fatto questo job, controllo dei servizi e notifica.
export function completaDopoRiavvio() {
  if (process.platform !== 'linux' || !fs.existsSync(MARCATORE)) return;
  setTimeout(async () => {
    let m;
    try { m = JSON.parse(fs.readFileSync(MARCATORE, 'utf8')); } catch { m = null; }
    if (!m || Date.now() - new Date(m.creato).getTime() > 24 * 3600000) { fs.rmSync(MARCATORE, { force: true }); return; } // vecchio
    // Solo un riavvio della VM vero (avvio dopo il marcatore), non un semplice riavvio di Projexa
    // nel minuto prima dello spegnimento: in quel caso il marcatore resta per l'avvio vero.
    let avvioVm = 0;
    try { avvioVm = Date.now() - Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000; } catch { /* sconosciuto */ }
    if (avvioVm && avvioVm < new Date(m.creato).getTime()) return;
    fs.rmSync(MARCATORE, { force: true });
    let kernel = '?';
    try { kernel = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(); } catch { /* resta ? */ }
    const fermi = await serviziFermi().catch((e) => [`controllo non riuscito: ${e.message}`]);
    console.log(`[AGGIORNAMENTI AUTO] VM riavviata (kernel ${kernel}); servizi fermi: ${fermi.length}`);
    await notificaSistema({
      tenantId: m.tenantId, userId: m.userId,
      titolo: fermi.length ? 'VM riavviata: servizi da controllare' : 'VM riavviata dopo gli aggiornamenti',
      messaggio: `${fermi.length ? `ATTENZIONE, servizi non attivi: ${fermi.join(', ')}.` : 'Servizi tutti attivi.'} Kernel in uso: ${kernel}.`
    });
  }, ATTESA_SERVIZI_MS);
}
