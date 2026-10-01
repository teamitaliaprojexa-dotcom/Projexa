// Gestione delle schedulazioni dei job (pagina job-schedules.html, tabella job_schedules).
// Riservata all'admin (id_roles = 1) del tenant PROJEXA, verificato sul database come per
// il Monitor VM. La tabella NON è in table_structures: l'endpoint generico /api/data non
// la espone, si modifica solo da qui.
//
// Ogni modifica al calendario ricalcola subito prossima_esecuzione. «Esegui ora» non
// lancia il job da qui: mette prossima_esecuzione = adesso e lo esegue lo schedulatore del
// server entro un minuto (così gira sempre sulla VM, anche se la pagina è aperta in locale).
import express from 'express';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjexaAdmin, vmCarico } from './vm-monitor.js';
import { calcolaProssima, NOMI_JOB, INFO_JOB, schedulerAttivo, schedulerSospeso } from '../jobs/scheduler.js';
import { execFile } from 'child_process';
import { statoWorker, kickTranscriptionWorker, enqueueFinalize } from '../jobs/meetingTranscription.js';
import { whisperUrls, whisperCppUrls } from './ai.js';

const router = express.Router();
router.use(requireAuth, requireProjexaAdmin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORA = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function erroreValidazione(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Valida e normalizza i campi modificabili. Restituisce solo quelli presenti nel body.
async function leggiCampi(body, parziale) {
  const c = {};
  const ha = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (ha('tenant_id') || !parziale) {
    const t = String(body.tenant_id || '');
    if (!UUID.test(t)) throw erroreValidazione('Tenant non valido');
    const ok = await db.query('SELECT 1 FROM tenants WHERE id = $1', [t]);
    if (!ok.rows.length) throw erroreValidazione('Tenant inesistente');
    c.tenant_id = t;
  }
  if (ha('job') || !parziale) {
    const j = String(body.job || '');
    if (!NOMI_JOB.includes(j)) throw erroreValidazione(`Job non valido (ammessi: ${NOMI_JOB.join(', ')})`);
    c.job = j;
  }
  if (ha('utente_config')) {
    const u = body.utente_config ? String(body.utente_config) : null;
    if (u && !UUID.test(u)) throw erroreValidazione('Utente non valido');
    c.utente_config = u;
  }
  if (ha('descrizione')) c.descrizione = body.descrizione == null ? null : String(body.descrizione).slice(0, 255);
  if (ha('attivo')) c.attivo = !!body.attivo;
  if (ha('giorni_settimana')) {
    const g = [...new Set((Array.isArray(body.giorni_settimana) ? body.giorni_settimana : []).map(Number))].sort();
    if (!g.length || g.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) throw erroreValidazione('Scegli almeno un giorno');
    c.giorni_settimana = g;
  }
  for (const k of ['ora_inizio', 'ora_fine']) {
    if (ha(k)) {
      if (!ORA.test(String(body[k] || ''))) throw erroreValidazione(`Orario non valido: ${k}`);
      c[k] = String(body[k]);
    }
  }
  if (ha('intervallo_minuti')) {
    const n = Number(body.intervallo_minuti);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw erroreValidazione('Intervallo tra 5 e 1440 minuti');
    c.intervallo_minuti = n;
  }
  if (ha('fuso_orario')) {
    const tz = String(body.fuso_orario || '');
    try { new Intl.DateTimeFormat('it-IT', { timeZone: tz }); } catch { throw erroreValidazione('Fuso orario non valido'); }
    c.fuso_orario = tz;
  }
  if (ha('parametri')) {
    let p = body.parametri;
    if (typeof p === 'string') {
      if (!p.trim()) p = null;
      else { try { p = JSON.parse(p); } catch { throw erroreValidazione('Parametri: JSON non valido'); } }
    }
    if (p != null && (typeof p !== 'object' || Array.isArray(p))) throw erroreValidazione('Parametri: serve un oggetto JSON');
    c.parametri = p == null ? null : JSON.stringify(p);
  }
  return c;
}

// L'utente della configurazione Jira deve appartenere al tenant della schedulazione.
async function verificaUtenteConfig(id) {
  const r = (await db.query(
    `SELECT s.utente_config FROM job_schedules s
      WHERE s.id = $1 AND s.utente_config IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = s.utente_config AND ut.tenant_id = s.tenant_id)`,
    [id]
  )).rows[0];
  if (r) throw erroreValidazione('L\'utente scelto per la configurazione Jira non appartiene al tenant della schedulazione');
}

// Utenti di ogni tenant con lo stato Jira (mappatura presente, account collegato),
// per l'elenco "Configurazione Jira di" della pagina.
async function utentiDeiTenant() {
  const { rows } = await db.query(
    `SELECT ut.tenant_id, ut.user_id, u.name, u.cognome,
            EXISTS (SELECT 1 FROM jira_task j WHERE j.tenant_id = ut.tenant_id AND j.user_id = ut.user_id)
         OR EXISTS (SELECT 1 FROM jira_quotazioni j WHERE j.tenant_id = ut.tenant_id AND j.user_id = ut.user_id) AS mappatura
       FROM user_tenants ut
       LEFT JOIN users u ON u.id = ut.user_id`
  );
  // Account Jira collegato = ha il refresh token su Projexa-Auth (integr_tok_auth).
  let collegati = new Set();
  try {
    const t = await authDb.query(
      `SELECT DISTINCT user_id FROM integr_tok_auth
        WHERE lower(provider_integrazione) = 'jira' AND elemento = 'jira_refresh_token'`
    );
    collegati = new Set(t.rows.map((x) => String(x.user_id)));
  } catch (e) {
    console.warn('[JOB-SCHEDULES] Stato collegamento Jira non disponibile:', e.message);
  }
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    user_id: r.user_id,
    nome: [r.name, r.cognome].filter(Boolean).join(' ') || String(r.user_id),
    mappatura: !!r.mappatura,
    collegato: collegati.has(String(r.user_id))
  })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

// Ricalcola prossima_esecuzione dopo una modifica (null se disattivata).
async function ricalcolaProssima(id) {
  const r = (await db.query('SELECT * FROM job_schedules WHERE id = $1', [id])).rows[0];
  if (!r) return null;
  if (r.ora_fine < r.ora_inizio) throw erroreValidazione('L\'ora di fine deve essere successiva a quella di inizio');
  const prossima = r.attivo ? calcolaProssima(r) : null;
  await db.query('UPDATE job_schedules SET prossima_esecuzione = $2, updated_at = now() WHERE id = $1', [id, prossima]);
  return prossima;
}

async function elenco() {
  const { rows } = await db.query(
    `SELECT s.*, t.name AS tenant_name, uc.name AS config_name, uc.cognome AS config_cognome
       FROM job_schedules s
       LEFT JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN users uc ON uc.id = s.utente_config
      ORDER BY t.name NULLS LAST, s.job, s.created_at`
  );
  return rows;
}

router.get('/', async (req, res) => {
  try {
    const tenants = (await db.query('SELECT id, name FROM tenants ORDER BY name')).rows;
    res.json({
      schedulazioni: await elenco(),
      jobs: NOMI_JOB,
      infoJob: INFO_JOB,
      tenants,
      utenti: await utentiDeiTenant(),
      // Stato dello schedulatore NEL BACKEND CHE RISPONDE: in locale è di norma spento.
      schedulerAttivo: schedulerAttivo(),
      // Interruttore generale (job_scheduler_stato): vale per tutti i server, è nel database.
      schedulerSospeso: await schedulerSospeso(),
      adesso: new Date().toISOString()
    });
  } catch (e) {
    res.status(e.code === '42P01' ? 503 : 500).json({
      error: e.code === '42P01' ? 'Tabella job_schedules assente: eseguire Supporto/CreaDB/job_schedules.sql' : e.message
    });
  }
});

router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    const c = await leggiCampi(req.body || {}, false);
    const cols = Object.keys(c);
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO job_schedules (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((k) => c[k])
    );
    await client.query('COMMIT');
    try {
      await verificaUtenteConfig(ins.rows[0].id);
    } catch (e) {
      await db.query('DELETE FROM job_schedules WHERE id = $1', [ins.rows[0].id]);
      throw e;
    }
    await ricalcolaProssima(ins.rows[0].id);
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(e.statusCode || (e.code === '23514' ? 400 : 500)).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    const c = await leggiCampi(req.body || {}, true);
    const cols = Object.keys(c);
    if (cols.length) {
      // Controllo preventivo dell'utente della configurazione rispetto al tenant
      // (quello nuovo, se cambia, altrimenti quello attuale della riga).
      if (c.utente_config || c.tenant_id) {
        const attuale = (await db.query('SELECT tenant_id, utente_config FROM job_schedules WHERE id = $1', [req.params.id])).rows[0];
        if (!attuale) return res.status(404).json({ error: 'Schedulazione non trovata' });
        const tenant = c.tenant_id || attuale.tenant_id;
        const utente = Object.prototype.hasOwnProperty.call(c, 'utente_config') ? c.utente_config : attuale.utente_config;
        if (utente) {
          const ok = await db.query('SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [utente, tenant]);
          if (!ok.rows.length) throw erroreValidazione('L\'utente scelto per la configurazione Jira non appartiene al tenant della schedulazione');
        }
      }
      const r = await db.query(
        `UPDATE job_schedules SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [req.params.id, ...cols.map((k) => c[k])]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Schedulazione non trovata' });
    }
    const prossima = await ricalcolaProssima(req.params.id);
    res.json({ ok: true, prossima_esecuzione: prossima });
  } catch (e) {
    res.status(e.statusCode || (e.code === '23514' ? 400 : 500)).json({ error: e.message });
  }
});

// Interruttore generale «Sospendi / Riattiva» (tabella job_scheduler_stato). Alla
// riattivazione le prossime esecuzioni si ricalcolano da adesso: le esecuzioni perse durante
// la sospensione non vengono recuperate tutte insieme.
router.put('/scheduler/stato', async (req, res) => {
  const attivo = !!(req.body && req.body.attivo);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO job_scheduler_stato (id, attivo, modificato_il, modificato_da) VALUES (1, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE SET attivo = EXCLUDED.attivo, modificato_il = now(), modificato_da = EXCLUDED.modificato_da`,
      [attivo, req.user.user_id || null]
    );
    if (attivo) {
      await client.query('UPDATE job_schedules SET prossima_esecuzione = NULL, updated_at = now() WHERE attivo AND in_esecuzione_dal IS NULL');
    }
    await client.query('COMMIT');
    if (attivo) {
      for (const r of (await db.query('SELECT id FROM job_schedules WHERE attivo AND prossima_esecuzione IS NULL')).rows) {
        await ricalcolaProssima(r.id);
      }
    }
    console.log(`[SCHEDULER] ${attivo ? 'Riattivato' : 'Sospeso'} dalla pagina Schedulazioni (utente ${req.user.user_id})`);
    res.json({ ok: true, attivo });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(e.code === '42P01' ? 503 : 500).json({
      error: e.code === '42P01' ? 'Tabella job_scheduler_stato assente: eseguire la parte finale di Supporto/CreaDB/job_schedules.sql' : e.message
    });
  } finally {
    client.release();
  }
});

// «Esegui ora»: la esegue lo schedulatore del server al prossimo giro (entro un minuto).
router.post('/:id/esegui-ora', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    const r = await db.query(
      `UPDATE job_schedules SET prossima_esecuzione = now(), updated_at = now()
        WHERE id = $1 AND attivo RETURNING id`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(400).json({ error: 'Schedulazione inesistente o disattivata' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sblocca una riga rimasta "in esecuzione" (es. backend riavviato durante il job).
router.post('/:id/sblocca', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    await db.query('UPDATE job_schedules SET in_esecuzione_dal = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
    await ricalcolaProssima(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id non valido' });
    const r = await db.query('DELETE FROM job_schedules WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Schedulazione non trovata' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// TRASCRIZIONI E RECAP (coda rec_meeting_chunks, jobs/meetingTranscription.js)
// ----------------------------------------------------------------------------
// Non sono job a orario ma una coda che il server lavora di continuo: qui si vedono lo
// stato dei servizi (Whisper, whisper.cpp, Ollama) e le riunioni in coda, con le azioni
// per intervenire se qualcosa si blocca:
//   - sblocca:  i blocchi "in trascrizione" che questo server NON sta lavorando tornano in
//               coda subito (invece di aspettare il recupero automatico dopo 20 minuti);
//   - riprova:  i blocchi in attesa di un nuovo tentativo ripartono adesso;
//   - annulla:  la riunione esce dalla coda (l'audio non ancora trascritto si perde; la
//               trascrizione già scritta resta);
//   - recap:    rilancia il recap della riunione;
//   - riavvia:  riavvia uno dei servizi della VM (solo quelli dell'elenco).
// ============================================================================
const MIN_APPESO = 10; // un blocco richiede 1-2 minuti: oltre 10 minuti "in trascrizione" è sospetto

// Servizi della VM legati a trascrizione e recap (gli unici riavviabili da qui).
function unitaServizi() {
  const units = [];
  for (const u of whisperUrls()) {
    const port = /:(\d+)$/.exec(u);
    if (port && /127\.0\.0\.1|localhost/.test(u)) units.push({ unit: `projexa-whisper@${port[1]}`, label: `Whisper Background (${port[1]})` });
  }
  if (whisperCppUrls().length) units.push({ unit: 'projexa-whisper-cpp', label: 'Whisper.cpp (Background-Veloce)' });
  units.push({ unit: 'ollama', label: 'Ollama (Recap Projexa lento)' });
  return units;
}

// CPU e memoria di ogni servizio da systemd (cgroup: comprende i processi figli).
// CPU % = tempo CPU consumato dall'ultima lettura, rispetto a tutti i core della VM;
// alla prima lettura (o dopo un riavvio del servizio) non c'è un intervallo: null.
const cpuPrecedente = new Map(); // unit -> { ns, t }
function consumiUnita(units, cores) {
  if (process.platform !== 'linux' || !units.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile('systemctl', ['show', ...units.map((u) => u.unit), '-p', 'Id', '-p', 'MemoryCurrent', '-p', 'CPUUsageNSec'],
      { timeout: 5000 }, (err, stdout) => {
        const out = new Map();
        const ora = Date.now();
        // Un blocco di righe "Chiave=valore" per unità, separati da una riga vuota.
        for (const blocco of String(stdout || '').split(/\n\s*\n/)) {
          const v = Object.fromEntries(blocco.split('\n').map((l) => l.split('=')).filter((x) => x.length >= 2).map(([k, ...r]) => [k.trim(), r.join('=').trim()]));
          if (!v.Id) continue;
          const unit = v.Id.replace(/\.service$/, '');
          const mem = /^\d+$/.test(v.MemoryCurrent || '') ? Number(v.MemoryCurrent) : null;
          const ns = /^\d+$/.test(v.CPUUsageNSec || '') ? Number(v.CPUUsageNSec) : null;
          let cpu = null;
          const prima = cpuPrecedente.get(unit);
          if (ns != null && prima && ns >= prima.ns && ora > prima.t) {
            cpu = Math.min(100, 100 * ((ns - prima.ns) / 1e6) / (ora - prima.t) / (cores || 1));
          }
          if (ns != null) cpuPrecedente.set(unit, { ns, t: ora });
          out.set(unit, { mem, cpu });
        }
        resolve(out);
      });
  });
}

function statoUnita(units) {
  if (process.platform !== 'linux' || !units.length) return Promise.resolve(units.map((u) => ({ ...u, state: 'n.d.' })));
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', ...units.map((u) => u.unit)], { timeout: 5000 }, (err, stdout) => {
      const lines = String(stdout || '').trim().split('\n');
      resolve(units.map((u, i) => ({ ...u, state: (lines[i] || 'unknown').trim() })));
    });
  });
}

router.get('/servizi', async (req, res) => {
  try {
    const carico = vmCarico();
    const unita = unitaServizi();
    const [statiServizi, consumi] = await Promise.all([statoUnita(unita), consumiUnita(unita, carico && carico.cores)]);
    const servizi = statiServizi.map((x) => ({ ...x, ...(consumi.get(x.unit) || {}) }));
    const { inLavorazione, recap } = statoWorker();
    let righe = [];
    try {
      righe = (await db.query(
        `SELECT c.id, c.tenant_id, c.user_id, c.id_calendar, c.kind, c.state, c.offset_sec, c.attempts,
                c.last_error, c.next_try_at, c.created_at
           FROM rec_meeting_chunks c
          ORDER BY c.seq`
      )).rows;
    } catch (e) {
      if (e.code !== '42P01') throw e; // tabella assente: nessuna coda
    }
    // Una riga per riunione (tenant + utente + id_calendar)
    const sessioni = new Map();
    const ora = Date.now();
    for (const r of righe) {
      const key = `${r.tenant_id}|${r.user_id}|${r.id_calendar}`;
      if (!sessioni.has(key)) {
        sessioni.set(key, {
          tenant_id: r.tenant_id, user_id: r.user_id, id_calendar: r.id_calendar,
          in_coda: 0, in_trascrizione: 0, trascritti: 0, appesi: 0, in_attesa_riprova: 0,
          finalize: false, tentativi: 0, ultimo_errore: null, dal: r.created_at, ultimo_secondo: 0
        });
      }
      const s = sessioni.get(key);
      if (r.kind === 'finalize') { s.finalize = true; }
      else if (r.state === 'done') s.trascritti++;
      else if (r.state === 'transcribing') {
        s.in_trascrizione++;
        const lavorato = inLavorazione.has(String(r.id));
        if (!lavorato && ora - new Date(r.next_try_at).getTime() > MIN_APPESO * 60000) s.appesi++;
      } else {
        s.in_coda++;
        if (new Date(r.next_try_at).getTime() > ora) s.in_attesa_riprova++;
      }
      s.tentativi = Math.max(s.tentativi, Number(r.attempts) || 0);
      if (r.last_error) s.ultimo_errore = String(r.last_error).slice(0, 300);
      s.ultimo_secondo = Math.max(s.ultimo_secondo, Number(r.offset_sec) || 0);
      if (new Date(r.created_at) < new Date(s.dal)) s.dal = r.created_at;
    }
    const elenco = [...sessioni.values()];
    // Oggetto della riunione e nome dell'utente (oggetto cifrato: lo decifra il pool)
    if (elenco.length) {
      const m = await db.query(
        `SELECT m.tenant_id, m.user_id, m.id_calendar, m.oggetto, u.name, u.cognome
           FROM rec_meeting m LEFT JOIN users u ON u.id = m.user_id
          WHERE (m.tenant_id, m.user_id, m.id_calendar) IN (
                SELECT x.t::uuid, x.u::uuid, x.c FROM jsonb_to_recordset($1::jsonb) AS x(t text, u text, c text))`,
        [JSON.stringify(elenco.map((e) => ({ t: e.tenant_id, u: e.user_id, c: e.id_calendar })))]
      );
      const info = new Map(m.rows.map((x) => [`${x.tenant_id}|${x.user_id}|${x.id_calendar}`, x]));
      for (const e of elenco) {
        const x = info.get(`${e.tenant_id}|${e.user_id}|${e.id_calendar}`) || {};
        e.oggetto = x.oggetto || null;
        e.utente = [x.name, x.cognome].filter(Boolean).join(' ') || null;
        e.recap_in_corso = recap.has(`${e.tenant_id}|${e.user_id}|${e.id_calendar}`);
      }
    }
    res.json({ servizi, vm: carico, sessioni: elenco, minAppeso: MIN_APPESO, adesso: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Riunione su cui agire: sempre dai tre campi della chiave (validati).
function chiaveSessione(body) {
  const b = body || {};
  const t = String(b.tenant_id || ''), u = String(b.user_id || ''), c = String(b.id_calendar || '').trim();
  if (!UUID.test(t) || !UUID.test(u) || !c) throw erroreValidazione('Riunione non valida');
  return [t, u, c];
}

router.post('/servizi/sessione/:azione', async (req, res) => {
  try {
    const [t, u, c] = chiaveSessione(req.body);
    const azione = req.params.azione;
    let n = 0;
    if (azione === 'sblocca') {
      const { inLavorazione } = statoWorker();
      n = (await db.query(
        `UPDATE rec_meeting_chunks SET state = 'pending', next_try_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND state = 'transcribing'
            AND NOT (id::text = ANY($4::text[]))`,
        [t, u, c, [...inLavorazione]]
      )).rowCount;
    } else if (azione === 'riprova') {
      n = (await db.query(
        `UPDATE rec_meeting_chunks SET next_try_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND state <> 'transcribing'`,
        [t, u, c]
      )).rowCount;
    } else if (azione === 'annulla') {
      n = (await db.query(
        'DELETE FROM rec_meeting_chunks WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
        [t, u, c]
      )).rowCount;
    } else if (azione === 'recap') {
      await enqueueFinalize({ tenant_id: t, user_id: u, email: null }, c);
      n = 1;
    } else {
      return res.status(400).json({ error: 'Azione non prevista' });
    }
    kickTranscriptionWorker();
    console.log(`[SERVIZI] ${azione} su ${c} (utente ${u}): ${n} righe - da ${req.user.user_id}`);
    res.json({ ok: true, righe: n });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post('/servizi/riavvia', async (req, res) => {
  try {
    const unit = String((req.body && req.body.unit) || '');
    if (!unitaServizi().some((x) => x.unit === unit)) return res.status(400).json({ error: 'Servizio non previsto' });
    if (process.platform !== 'linux') return res.status(501).json({ error: 'Disponibile solo sul server (VM)' });
    await new Promise((resolve, reject) => {
      execFile('sudo', ['-n', 'systemctl', 'restart', unit], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim() || 'riavvio non riuscito'));
        else resolve();
      });
    });
    console.log(`[SERVIZI] riavviato ${unit} da ${req.user.user_id}`);
    kickTranscriptionWorker();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
