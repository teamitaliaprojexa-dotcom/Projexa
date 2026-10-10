// ============================================================================
// FUNZIONI DA PROJECT MANAGER SENIOR - MOTORE DI CALCOLO (2026-10-09)
// ----------------------------------------------------------------------------
// Usato dalle API del Cruscotto PM (routes/pm.js) e dai job del server (jobs/pmJobs.js):
// per questo lavora con un oggetto `user` ({ tenant_id, user_id, ... }) e non con `req`.
// Ogni query filtra SEMPRE su tenant_id + user_id del proprietario del progetto.
//
//   progettoUtente      progetto dell'utente (validazione + nomi)
//   campiProgetto       campi della scheda (anche dentro le sezioni) letti come li vede l'utente
//   economiaProgetto    offerta / speso dai Costi Progetto (proj_worker), in ore o giornate
//   analisiGantt        avanzamento ponderato, ritardi, milestone, baseline, percorso critico
//   saluteProgetto      semaforo (5 indicatori) + previsione a finire (EAC) + andamento
//   contestoProgetto    tutto il progetto in testo, per l'AI (Status Report, Chiedi, Briefing)
//   aiPerPm / chiediAi  AI da usare e chiamata (AI esterna o «Recap Projexa (lento)»)
// Tabelle: Supporto/CreaDB/pm_senior.sql. Se non sono ancora state create, le funzioni che
// le leggono restituiscono dati vuoti invece di fallire (tabellaPresente).
// ============================================================================
import db from './database.js';
import { getIntegration } from './integrations.js';
import { askAiProvider, PROVIDERS as AI_PROVIDERS, localRecapMode, askOllamaRecap } from '../routes/ai.js';
import { stripMarkdown } from '../jobs/meetingTranscription.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const errore = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const normCampo = (c) => String(c || '').replace(/^\(\*\)\s*/, '').trim().toLowerCase();
export const vero = (v) => ['true', 't', '1', 'si', 'sì', 'yes', 'vero'].includes(String(v ?? '').trim().toLowerCase());
export const oggiIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

// Numero da testo italiano o inglese ("1.234,50", "1234.5", "80%"). null se non è un numero.
export function numero(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[%€\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Data da 'AAAA-MM-GG…' o 'GG/MM/AAAA' -> 'AAAA-MM-GG' (null se non valida).
export function dataIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
export const dataIt = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const giorno = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
export const giorniTra = (a, b) => giorno(b) - giorno(a);

// Giorni lavorativi (lun-ven) strettamente compresi tra due date.
function lavorativiTra(a, b) {
  let n = 0;
  for (let d = giorno(a) + 1; d < giorno(b); d++) {
    const w = new Date(d * 86400000).getUTCDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

const cacheTabelle = new Map();
export async function tabellaPresente(nome) {
  const c = cacheTabelle.get(nome);
  if (c && Date.now() - c.t < 60000) return c.ok;
  const r = await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1", [nome]);
  cacheTabelle.set(nome, { ok: r.rows.length > 0, t: Date.now() });
  return r.rows.length > 0;
}
const cacheColonne = new Map();
export async function colonneTabella(nome) {
  const c = cacheColonne.get(nome);
  if (c && Date.now() - c.t < 60000) return c.cols;
  const r = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [nome]);
  const cols = new Set(r.rows.map((x) => x.column_name));
  cacheColonne.set(nome, { cols, t: Date.now() });
  return cols;
}

// ----------------------------------------------------------------------------
// PROGETTO E CAMPI DELLA SCHEDA
// ----------------------------------------------------------------------------

// Progetto del proprietario (tenant + utente). Errore 404 se non è suo.
export async function progettoUtente(user, projectId, pool = db) {
  const id = String(projectId || '').trim();
  if (!UUID_RE.test(id)) throw errore(400, 'Progetto non valido');
  const p = (await pool.query(
    `SELECT p.id::text AS id, p.client_id::text AS client_id, p.valore2 AS nome,
            (p.scadenza IS NULL OR p.scadenza >= CURRENT_DATE) AS aperto,
            (SELECT c.valore2 FROM clients c WHERE c.id = p.client_id LIMIT 1) AS cliente
       FROM projects p
      WHERE p.id::text = $1 AND p.tenant_id = $2 AND p.user_id = $3 AND p.argument = 'Progetto' AND p.campo = 'Progetto'
      LIMIT 1`,
    [id, user.tenant_id, user.user_id]
  )).rows[0];
  if (!p) throw errore(404, 'Progetto non trovato');
  return { projectId: p.id, clientId: p.client_id, nome: p.nome || 'Progetto', cliente: p.cliente || '', aperto: !!p.aperto };
}

// Valore di un campo come lo vede l'utente: sì/no da valore1, numeri da valore3, resto valore2.
function valoreCampo(row) {
  const t = String(row.tipo_valore ?? '').trim();
  const pieno = (v) => v != null && String(v).trim() !== '';
  if (['1', '14', '22'].includes(t)) return pieno(row.valore1) ? String(row.valore1).trim() : '';
  const ordine = ['3', '8'].includes(t) ? [row.valore3, row.valore2] : [row.valore2, row.valore3];
  const v = ordine.find(pieno);
  return v == null ? '' : String(v).trim();
}

// Campi della scheda del progetto (anche annidati nelle sezioni). Restituisce un oggetto con
// get(nome) -> valore ('' se assente) e riga(nome) -> riga EAV; i campi _hh/_gg seguono la
// «Gestione a HH» del progetto, come nella scheda.
export async function campiProgetto(user, projectId, { tutti = false } = {}) {
  const ids = (await db.query(
    `WITH RECURSIVE albero(id, livello) AS (
       SELECT id, 0 FROM projects WHERE id::text = $1
       UNION ALL
       SELECT x.id, a.livello + 1 FROM projects x JOIN albero a ON x.argument = a.id::text
        WHERE x.tenant_id = $2 AND x.user_id = $3 AND a.livello < 6 AND x.tipo_valore::text = '0'
     )
     SELECT id::text AS id FROM albero`,
    [projectId, user.tenant_id, user.user_id]
  )).rows.map((x) => x.id);
  const r = await db.query(
    `SELECT id::text AS id, campo, tipo_valore::text AS tipo_valore, valore1::text AS valore1, valore2::text AS valore2,
            valore3::text AS valore3, id_roles_write
       FROM projects
      WHERE tenant_id = $1 AND user_id = $2 AND argument = ANY($3::text[])
        ${tutti ? '' : 'AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)'}
      ORDER BY (scadenza IS NULL OR scadenza >= CURRENT_DATE) DESC, id`,
    [user.tenant_id, user.user_id, ids]
  );
  const perCampo = new Map();
  for (const x of r.rows) { const k = normCampo(x.campo); if (!perCampo.has(k)) perCampo.set(k, x); }
  const gestione = perCampo.get('gestione a hh');
  const aOre = !!gestione && vero(gestione.valore1);
  const riga = (nome) => {
    const n = String(nome).toLowerCase();
    const c = [perCampo.get(n), perCampo.get(n + (aOre ? '_hh' : '_gg')), perCampo.get(n + (aOre ? '_gg' : '_hh'))].filter(Boolean);
    return c.find((x) => valoreCampo(x) !== '') || c[0] || null;
  };
  return {
    aOre,
    riga,
    get: (nome) => { const x = riga(nome); return x ? valoreCampo(x) : ''; },
    // Data di un campo: nei campi «sì/no + data» (tipo 22) valore1 è solo la casella e la data
    // sta in valore2, quindi si prende la prima colonna che contiene davvero una data.
    data: (nome) => { const x = riga(nome); return x ? (dataIso(x.valore2) || dataIso(x.valore3) || dataIso(x.valore1)) : null; },
    sezioni: ids
  };
}

// Dati principali della scheda, già interpretati.
export async function schedaProgetto(user, projectId) {
  const c = await campiProgetto(user, projectId);
  const stato = c.get('Stato Progetto');
  return {
    aOre: c.aOre,
    unita: c.aOre ? 'ore' : 'giorni',
    descrizione: c.get('Descrizione'),
    start: c.data('Start'),
    end: c.data('End'),
    stato,
    anno: c.get('Anno').replace(/\.0+$/, ''),
    tipo: c.get('Tipo'),
    tipologia: c.get('Tipologia'),
    rischio: c.get('Rischio'),
    completamento: numero(c.get('Completamento')),
    importo: numero(c.get('Importo')),
    effortTotale: numero(c.get('Effort Totale')),
    offertaInviata: c.data('Offerta inviata al Cliente'),
    ordineRicevuto: c.data('Ordine Ricevuto'),
    richiedente: c.get('Richiedente'),
    campi: c
  };
}

// ----------------------------------------------------------------------------
// ECONOMIA: Costi Progetto (proj_worker), come l'indicatore Gestione Progetto
// ----------------------------------------------------------------------------
export async function economiaProgetto(user, projectId) {
  const r = await db.query(
    `SELECT COALESCE(wc.desc_worker, 'Senza voce') AS voce, hh.gestione_hh AS hh,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END) AS offerta,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END) AS speso
       FROM proj_worker a
       LEFT JOIN proj_worker_cost wc ON wc.id = a.worker_cost_id AND wc.scadenza >= CURRENT_DATE
       LEFT JOIN LATERAL (
         SELECT COALESCE(bool_or(b.valore1), false) AS gestione_hh
           FROM projects b
          WHERE b.campo = 'Gestione a HH' AND b.argument = a.project_id::text
            AND b.tenant_id = a.tenant_id AND b.user_id = a.user_id AND b.scadenza >= CURRENT_DATE
       ) hh ON true
      WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.project_id::text = $3 AND a.scadenza >= CURRENT_DATE
      GROUP BY 1, 2
      ORDER BY 1`,
    [user.tenant_id, user.user_id, projectId]
  );
  const voci = r.rows.map((x) => ({ voce: x.voce, offerta: Number(x.offerta) || 0, speso: Number(x.speso) || 0 }));
  return {
    voci,
    aOre: r.rows.some((x) => x.hh),
    offerta: voci.reduce((s, v) => s + v.offerta, 0),
    speso: voci.reduce((s, v) => s + v.speso, 0)
  };
}

// ----------------------------------------------------------------------------
// GANTT (proj_activity)
// ----------------------------------------------------------------------------

// Righe del Gantt del progetto con livello, nome e chiave gerarchica.
export async function righeGantt(user, projectId) {
  const r = await db.query(
    `SELECT * FROM proj_activity
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3
      ORDER BY ordinamento1 NULLS LAST, ordinamento2 NULLS FIRST, ordinamento3 NULLS FIRST, ordinamento4 NULLS FIRST, created_at`,
    [user.tenant_id, user.user_id, projectId]
  );
  return r.rows.map((x) => {
    const livello = x.argomento4 ? 4 : x.argomento3 ? 3 : x.argomento2 ? 2 : 1;
    const chiave = [x.ordinamento1, x.ordinamento2, x.ordinamento3, x.ordinamento4].slice(0, livello).map((n) => n ?? 0).join('.');
    return {
      id: String(x.id),
      livello,
      chiave,
      nome: String(x[`argomento${livello}`] || '').trim() || '(senza nome)',
      inizio: dataIso(x.data_inizio),
      fine: dataIso(x.data_fine),
      avanzamento: Math.max(0, Math.min(100, Number(x.avanzamento) || 0)),
      stato: x.stato || '',
      owner: x.owner || x.nominativo || '',
      dipendenza: x.dipendenza ? String(x.dipendenza) : null,
      milestone: x.milestone === true,
      baselineInizio: dataIso(x.baseline_inizio),
      baselineFine: dataIso(x.baseline_fine),
      baselineIl: x.baseline_il || null
    };
  });
}

// Analisi del Gantt: avanzamento ponderato sulle foglie (peso = durata in giorni), attività
// in ritardo, milestone, scostamento dalla baseline e percorso critico (attività senza margine:
// se slittano, slitta la fine del progetto).
export function analisiGantt(righe, oggi = oggiIso()) {
  const out = {
    attivita: righe.length, foglie: 0, conDate: 0, completamento: null,
    inRitardo: [], nonIniziate: [], milestone: [], critico: [],
    inizio: null, fine: null, baselineFine: null, scostamentoGiorni: null, baselineIl: null
  };
  if (!righe.length) return out;
  const haFigli = new Set();
  for (const r of righe) {
    const p = r.chiave.split('.');
    if (p.length > 1) haFigli.add(p.slice(0, -1).join('.'));
  }
  const datate = righe.filter((r) => r.inizio && r.fine);
  out.conDate = datate.length;
  const foglie = righe.filter((r) => !haFigli.has(r.chiave));
  out.foglie = foglie.length;
  let peso = 0, fatto = 0;
  for (const f of foglie) {
    const w = f.inizio && f.fine ? Math.max(1, giorniTra(f.inizio, f.fine) + 1) : 1;
    peso += w; fatto += w * f.avanzamento;
    if (f.fine && f.fine < oggi && f.avanzamento < 100) out.inRitardo.push({ id: f.id, nome: f.nome, fine: f.fine, avanzamento: f.avanzamento, giorni: giorniTra(f.fine, oggi), owner: f.owner });
    else if (f.inizio && f.inizio < oggi && f.avanzamento === 0) out.nonIniziate.push({ id: f.id, nome: f.nome, inizio: f.inizio, owner: f.owner });
  }
  if (peso) out.completamento = Math.round((fatto / peso) * 10) / 10;
  out.inRitardo.sort((a, b) => b.giorni - a.giorni);
  for (const m of righe.filter((r) => r.milestone)) {
    const data = m.fine || m.inizio;
    out.milestone.push({
      id: m.id, nome: m.nome, data, raggiunta: m.avanzamento >= 100,
      scaduta: !!data && data < oggi && m.avanzamento < 100,
      baseline: m.baselineFine, scostamento: m.baselineFine && data ? giorniTra(m.baselineFine, data) : null
    });
  }
  out.milestone.sort((a, b) => String(a.data || '9999').localeCompare(String(b.data || '9999')));
  if (datate.length) {
    out.inizio = datate.reduce((m, r) => (r.inizio < m ? r.inizio : m), datate[0].inizio);
    out.fine = datate.reduce((m, r) => (r.fine > m ? r.fine : m), datate[0].fine);
  }
  const conBaseline = righe.filter((r) => r.baselineFine);
  if (conBaseline.length) {
    out.baselineFine = conBaseline.reduce((m, r) => (r.baselineFine > m ? r.baselineFine : m), conBaseline[0].baselineFine);
    out.baselineIl = conBaseline.find((r) => r.baselineIl)?.baselineIl || null;
    if (out.fine) out.scostamentoGiorni = giorniTra(out.baselineFine, out.fine);
  }
  // Percorso critico: margine (giorni lavorativi) fra la fine di un'attività e l'inizio della
  // prima che dipende da lei; senza successori, fra la sua fine e la fine del progetto.
  if (datate.length && out.fine) {
    const succ = new Map();
    for (const r of datate) if (r.dipendenza) {
      if (!succ.has(r.dipendenza)) succ.set(r.dipendenza, []);
      succ.get(r.dipendenza).push(r);
    }
    const critici = new Set();
    for (const r of datate) {
      const s = succ.get(r.id) || [];
      const margine = s.length
        ? Math.min(...s.map((x) => (x.inizio <= r.fine ? 0 : lavorativiTra(r.fine, x.inizio))))
        : (r.fine >= out.fine ? 0 : lavorativiTra(r.fine, out.fine) + 1);
      if (margine <= 0) critici.add(r.id);
    }
    // Tiene solo le catene che arrivano alla fine del progetto: si parte dalle attività che
    // finiscono per ultime e si risale lungo le dipendenze senza margine.
    const perId = new Map(datate.map((r) => [r.id, r]));
    const percorso = new Set();
    const coda = datate.filter((r) => r.fine === out.fine).map((r) => r.id);
    while (coda.length) {
      const id = coda.pop();
      if (percorso.has(id)) continue;
      percorso.add(id);
      const r = perId.get(id);
      if (r && r.dipendenza && critici.has(r.dipendenza)) coda.push(r.dipendenza);
    }
    out.critico = [...percorso];
  }
  return out;
}

// ----------------------------------------------------------------------------
// REGISTRI (RAID, Change Request), To-Do e Issue del progetto
// ----------------------------------------------------------------------------
export async function raidProgetto(user, projectId, { tutte = false } = {}) {
  if (!(await tabellaPresente('pm_raid'))) return [];
  const r = await db.query(
    `SELECT id::text AS id, tipo, titolo, descrizione, probabilita, impatto, owner, mitigazione,
            data_revisione::text AS data_revisione, decisa_da, stato, origine, id_calendar, id_roles_write,
            -- riga tolta dal registro (pulsante «Togli dal registro» = scadenza a ieri): visibile solo con «anche chiusi»
            (scadenza IS NOT NULL AND scadenza < CURRENT_DATE) AS riga_chiusa, scadenza::text AS scadenza_riga,
            created_at, updated_at
       FROM pm_raid
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3
        ${tutte ? '' : 'AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)'}
      ORDER BY created_at`,
    [user.tenant_id, user.user_id, projectId]
  );
  return r.rows.map((x) => ({ ...x, punteggio: x.probabilita && x.impatto ? x.probabilita * x.impatto : null }));
}

export async function crProgetto(user, projectId) {
  if (!(await tabellaPresente('pm_change_request'))) return [];
  const r = await db.query(
    `SELECT id::text AS id, codice, titolo, descrizione, motivo, richiesta_da, data_richiesta::text AS data_richiesta,
            effort_delta::float8 AS effort_delta, importo_delta::float8 AS importo_delta, giorni_delta, stato,
            data_decisione::text AS data_decisione, note, id_roles_write, created_at
       FROM pm_change_request
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY codice NULLS LAST, created_at`,
    [user.tenant_id, user.user_id, projectId]
  );
  return r.rows;
}

const STATI_TASK_APERTI = ['todo', 'in_progress'];
export async function taskProgetto(user, projectId) {
  const cols = await colonneTabella('tasks');
  const r = await db.query(
    `SELECT t.id::text AS id, t.titile, t.description, t.status, t.priority, t.due_date::text AS due_date,
            ${cols.has('assigned_to_text') ? 't.assigned_to_text' : 'NULL::text AS assigned_to_text'},
            rb.nominativo AS assegnato
       FROM tasks t
       LEFT JOIN rubrica rb ON rb.id::text = t.assigned_to::text AND rb.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1 AND t.user_id = $2 AND t.project_id::text = $3
        AND (t.scadenza IS NULL OR t.scadenza >= CURRENT_DATE)
        AND COALESCE(t.status, 'todo') = ANY($4)
      ORDER BY t.due_date NULLS LAST`,
    [user.tenant_id, user.user_id, projectId, STATI_TASK_APERTI]
  );
  const oggi = oggiIso();
  return r.rows.map((x) => ({
    id: x.id, titolo: x.titile || '', descrizione: x.description || '', stato: x.status, priorita: x.priority,
    scadenza: x.due_date, assegnato: x.assegnato || x.assigned_to_text || '', scaduta: !!x.due_date && x.due_date < oggi
  }));
}

export async function issueProgetto(user, projectId) {
  const cols = await colonneTabella('issue');
  if (!cols.has('project_id')) return [];
  const r = await db.query(
    `SELECT id::text AS id, descrizione, stato, priorita, owner, categoria, data_segnalazione::text AS data_segnalazione,
            scadenza::text AS scadenza
       FROM issue
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3
        AND LOWER(COALESCE(stato, '')) NOT IN ('chiuso', 'chiusa', 'risolto', 'risolta')
      ORDER BY data_segnalazione DESC NULLS LAST`,
    [user.tenant_id, user.user_id, projectId]
  );
  return r.rows.map((x) => ({ ...x, scadenza: x.scadenza && x.scadenza < '2099-01-01' ? x.scadenza : null }));
}

// Ultime riunioni del progetto con recap (testo semplice).
export async function riunioniProgetto(user, projectId, { limite = 5, dal = null, conTrascrizione = false } = {}) {
  const params = [user.tenant_id, user.user_id, projectId, limite];
  let filtro = '';
  if (dal) { params.push(dal); filtro = `AND data_calendar >= $${params.length}::date`; }
  const r = await db.query(
    `SELECT id_calendar, oggetto, data_calendar::text AS data, recap${conTrascrizione ? ', trascrizione' : ''}
       FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 ${filtro}
        AND (recap IS NOT NULL AND BTRIM(recap) <> ''${conTrascrizione ? " OR trascrizione IS NOT NULL AND BTRIM(trascrizione) <> ''" : ''})
      ORDER BY data_calendar DESC NULLS LAST, orario_calendar DESC NULLS LAST
      LIMIT $4`,
    params
  );
  return r.rows.map((x) => ({ ...x, recap: stripMarkdown(String(x.recap || '')).trim() }));
}

// ----------------------------------------------------------------------------
// SALUTE DEL PROGETTO + PREVISIONE A FINIRE
// ----------------------------------------------------------------------------
const ORDINE_STATO = { rosso: 3, giallo: 2, verde: 1, nd: 0 };
const peggiore = (a, b) => (ORDINE_STATO[a] >= ORDINE_STATO[b] ? a : b);

// Ritmo di consumo dalle fotografie giornaliere (pm_snapshot): unità al giorno sulle ultime
// 4 settimane (servono almeno 7 giorni di storia), null se non calcolabile.
async function ritmoConsumo(user, projectId) {
  if (!(await tabellaPresente('pm_snapshot'))) return null;
  const r = await db.query(
    `SELECT giorno::text AS giorno, speso::float8 AS speso FROM pm_snapshot
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND giorno >= CURRENT_DATE - 35
      ORDER BY giorno`,
    [user.tenant_id, user.user_id, projectId]
  );
  if (r.rows.length < 2) return null;
  const a = r.rows[0], b = r.rows[r.rows.length - 1];
  const gg = giorniTra(a.giorno, b.giorno);
  if (gg < 7) return null;
  return Math.max(0, (b.speso - a.speso) / gg);
}

export async function saluteProgetto(user, projectId, { prog = null, scheda = null } = {}) {
  prog = prog || await progettoUtente(user, projectId);
  scheda = scheda || await schedaProgetto(user, projectId);
  const oggi = oggiIso();
  const [eco, righe, raid, cr, task, issue] = await Promise.all([
    economiaProgetto(user, projectId),
    righeGantt(user, projectId),
    raidProgetto(user, projectId),
    crProgetto(user, projectId),
    taskProgetto(user, projectId),
    issueProgetto(user, projectId)
  ]);
  const gantt = analisiGantt(righe, oggi);
  const unita = scheda.aOre ? 'ore' : 'giorni';
  const crApprovate = cr.filter((x) => x.stato === 'approvata');
  const crDelta = crApprovate.reduce((s, x) => s + (Number(x.effort_delta) || 0), 0);
  const crImporto = crApprovate.reduce((s, x) => s + (Number(x.importo_delta) || 0), 0);
  const crGiorni = crApprovate.reduce((s, x) => s + (Number(x.giorni_delta) || 0), 0);

  // Completamento: quello della scheda; se manca, quello calcolato dal Gantt.
  const fonteCompl = scheda.completamento != null ? 'scheda' : (gantt.completamento != null ? 'gantt' : null);
  const completamento = scheda.completamento != null ? scheda.completamento : gantt.completamento;

  // --- Previsione a finire (Earned Value semplificato, in ore o giornate) ---
  const bac = eco.offerta + crDelta;
  const ac = eco.speso;
  const pc = completamento != null ? Math.max(0, Math.min(100, completamento)) / 100 : null;
  const eac = { unita, bac, bacOriginale: eco.offerta, crDelta, ac, completamento, fonteCompletamento: fonteCompl,
    ev: null, cpi: null, eac: null, etc: null, vac: null, percPrevista: null, valoreEuro: null,
    ritmoGiorno: null, esaurimentoBudget: null, finePrevista: null };
  if (bac > 0) {
    if (pc != null && pc > 0) {
      eac.ev = pc * bac;
      eac.cpi = ac > 0 ? eac.ev / ac : null;
      eac.eac = ac > 0 ? ac / pc : bac;
      eac.etc = Math.max(0, eac.eac - ac);
      eac.vac = bac - eac.eac;
      eac.percPrevista = (eac.eac / bac) * 100;
    }
    const importo = (scheda.importo || 0) + crImporto;
    if (importo > 0 && eac.vac != null) eac.valoreEuro = (eac.vac / bac) * importo;
  }
  const ritmo = await ritmoConsumo(user, projectId);
  if (ritmo && ritmo > 0) {
    eac.ritmoGiorno = ritmo;
    const add = (n) => new Date(Date.parse(`${oggi}T00:00:00Z`) + Math.round(n) * 86400000).toISOString().slice(0, 10);
    if (bac > ac) eac.esaurimentoBudget = add((bac - ac) / ritmo);
    if (eac.etc != null) eac.finePrevista = add(eac.etc / ritmo);
  }

  const ind = [];
  // 1. Budget (effort)
  {
    let stato = 'nd', nota = 'Offerta effort non compilata nei Costi Progetto';
    if (bac > 0) {
      const perc = (ac / bac) * 100;
      stato = 'verde';
      nota = `Speso ${fmt(ac)} su ${fmt(bac)} ${unita} (${fmt(perc, 0)}%)${crDelta ? `, di cui ${fmt(crDelta)} da Change Request approvate` : ''}`;
      // Sotto il 15% di completamento la stima a finire (speso ÷ completamento) oscilla troppo
      // (a inizio progetto poche ore danno subito +40%): si mostra ma non cambia il colore.
      const stimaAffidabile = eac.percPrevista != null && completamento != null && completamento >= 15;
      if (ac > bac) { stato = 'rosso'; nota += ': budget superato'; }
      else if (stimaAffidabile && eac.percPrevista > 110) { stato = 'rosso'; nota += `: a finire previsto ${fmt(eac.percPrevista, 0)}% del budget`; }
      else if ((stimaAffidabile && eac.percPrevista > 100) || (perc >= 80 && (completamento == null || completamento < 80))) {
        stato = 'giallo';
        nota += stimaAffidabile && eac.percPrevista > 100 ? `: a finire previsto ${fmt(eac.percPrevista, 0)}% del budget` : ': speso oltre l\'80% con lavoro ancora da completare';
      } else if (eac.percPrevista != null && !stimaAffidabile) {
        nota += `; stima a finire ${fmt(eac.percPrevista, 0)}% del budget, ancora poco affidabile (completamento sotto il 15%)`;
      }
    }
    ind.push({ chiave: 'budget', titolo: 'Budget', stato, nota });
  }
  // 2. Tempi
  {
    let stato = 'verde';
    const note = [];
    const end = scheda.end;
    if (!end && !gantt.fine) { stato = 'nd'; note.push('Date di fine non compilate (campo End o Gantt)'); }
    if (end && end < oggi && (completamento == null || completamento < 100)) { stato = 'rosso'; note.push(`Data di fine (${dataIt(end)}) superata con il progetto non completato`); }
    if (gantt.inRitardo.length) {
      stato = peggiore(stato, gantt.inRitardo.length >= 3 ? 'rosso' : 'giallo');
      note.push(`${gantt.inRitardo.length} attività del Gantt in ritardo`);
    }
    if (gantt.scostamentoGiorni != null && gantt.scostamentoGiorni > 0) {
      stato = peggiore(stato, gantt.scostamentoGiorni > 10 ? 'rosso' : 'giallo');
      note.push(`fine prevista ${gantt.scostamentoGiorni} giorni dopo la baseline`);
    }
    const ms = gantt.milestone.filter((m) => m.scaduta);
    if (ms.length) { stato = peggiore(stato, 'rosso'); note.push(`${ms.length} milestone superata non raggiunta`); }
    // Avanzamento atteso dal tempo trascorso (Start -> End) contro completamento reale.
    if (scheda.start && end && completamento != null && scheda.start < oggi && end > scheda.start) {
      const atteso = Math.min(100, (giorniTra(scheda.start, oggi) / giorniTra(scheda.start, end)) * 100);
      if (atteso - completamento > 20) { stato = peggiore(stato, 'giallo'); note.push(`completamento ${fmt(completamento, 0)}% contro ${fmt(atteso, 0)}% atteso dal calendario`); }
    }
    if (stato !== 'nd' && !note.length) note.push(end ? `Fine prevista ${dataIt(end)}` : `Fine del Gantt ${dataIt(gantt.fine)}`);
    ind.push({ chiave: 'tempi', titolo: 'Tempi', stato, nota: note.join('; ') });
  }
  // 3. Rischi
  {
    const aperti = raid.filter((x) => x.tipo === 'rischio' && x.stato !== 'chiuso');
    const max = aperti.reduce((m, x) => Math.max(m, x.punteggio || 0), 0);
    let stato = 'verde', nota = aperti.length ? `${aperti.length} rischi aperti, punteggio massimo ${max}` : 'Nessun rischio aperto nel registro';
    if (max >= 15) stato = 'rosso';
    else if (max >= 8) stato = 'giallo';
    const daRivedere = aperti.filter((x) => x.data_revisione && x.data_revisione < oggi).length;
    if (daRivedere) { stato = peggiore(stato, 'giallo'); nota += `; ${daRivedere} da rivedere (data di revisione passata)`; }
    if (!aperti.length && /alto/i.test(scheda.rischio || '')) { stato = 'giallo'; nota = 'Rischio «Alto» nella scheda, ma nessun rischio descritto nel registro'; }
    ind.push({ chiave: 'rischi', titolo: 'Rischi', stato, nota });
  }
  // 4. Issue e azioni
  {
    const scadute = task.filter((t) => t.scaduta).length;
    const alte = issue.filter((i) => /alt|urgent|critic/i.test(i.priorita || '')).length;
    let stato = 'verde';
    if (alte || scadute >= 3) stato = 'rosso';
    else if (issue.length || scadute) stato = 'giallo';
    const nota = [`${issue.length} issue aperte${alte ? ` (${alte} ad alta priorità)` : ''}`, `${task.length} azioni aperte${scadute ? `, ${scadute} scadute` : ''}`].join('; ');
    ind.push({ chiave: 'issue', titolo: 'Issue e azioni', stato, nota });
  }
  // 5. Commerciale (offerta, ordine, change request)
  {
    let stato = 'verde';
    const note = [];
    const iniziato = scheda.start && scheda.start <= oggi;
    if (!/previsione/i.test(scheda.tipologia || '')) {
      if (!scheda.ordineRicevuto) {
        if (scheda.offertaInviata) {
          const gg = giorniTra(scheda.offertaInviata, oggi);
          stato = iniziato ? 'rosso' : (gg >= 15 ? 'giallo' : 'verde');
          note.push(iniziato ? 'Progetto iniziato senza ordine: fatturazione bloccata' : `Offerta inviata da ${gg} giorni, ordine non ancora arrivato`);
        } else {
          stato = iniziato ? 'rosso' : 'giallo';
          note.push(iniziato ? 'Progetto iniziato senza offerta inviata né ordine' : 'Offerta da inviare');
        }
      } else note.push(`Ordine ricevuto il ${dataIt(scheda.ordineRicevuto)}`);
    } else note.push('Tipologia «Previsione»: offerta e ordine non controllati');
    const crAttese = cr.filter((x) => x.stato === 'inviata' && x.data_richiesta && giorniTra(x.data_richiesta, oggi) > 15);
    if (crAttese.length) { stato = peggiore(stato, 'giallo'); note.push(`${crAttese.length} Change Request inviate da oltre 15 giorni senza risposta`); }
    ind.push({ chiave: 'commerciale', titolo: 'Commerciale', stato, nota: note.join('; ') });
  }

  const semaforo = ind.reduce((s, x) => peggiore(s, x.stato), 'nd');
  return {
    progetto: prog,
    scheda: { ...scheda, campi: undefined },
    semaforo: semaforo === 'nd' ? 'nd' : semaforo,
    indicatori: ind,
    eac,
    economia: eco,
    gantt,
    conteggi: {
      rischiAperti: raid.filter((x) => x.tipo === 'rischio' && x.stato !== 'chiuso').length,
      decisioni: raid.filter((x) => x.tipo === 'decisione').length,
      crAperte: cr.filter((x) => x.stato === 'bozza' || x.stato === 'inviata').length,
      crApprovate: crApprovate.length,
      crImporto, crGiorni,
      taskAperti: task.length, taskScaduti: task.filter((t) => t.scaduta).length,
      issueAperte: issue.length
    }
  };
}

export function fmt(n, dec = 1) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  const [i, d] = Math.abs(v).toFixed(dec).split('.');
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${v < 0 ? '-' : ''}${s}${d && Number(d) ? `,${d}` : ''}`;
}
export const euro = (n) => (n == null ? '-' : `${fmt(n, 2)} €`);

// Progetti aperti del proprietario, con il cliente. Esclusi gli «Annullato», quelli con
// «Anno» successivo all'anno in corso (es. i progetti del 2027 nel 2026: scelta dell'utente,
// come l'indicatore Gestione Progetto) e quelli con Tipologia «Previsione». I progetti senza
// Anno restano. Vale per Portfolio, digest e notifiche dei progetti.
export async function progettiAperti(user) {
  const r = await db.query(
    `SELECT a.id::text AS id, a.client_id::text AS client_id, a.valore2 AS nome,
            (SELECT c.valore2 FROM clients c WHERE c.id = a.client_id LIMIT 1) AS cliente
       FROM projects a
      WHERE a.campo = 'Progetto' AND a.argument = 'Progetto' AND a.tenant_id = $1 AND a.user_id = $2
        AND a.scadenza >= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM projects sp
           WHERE sp.campo = 'Stato Progetto' AND sp.argument = a.id::text
             AND sp.tenant_id = a.tenant_id AND sp.user_id = a.user_id AND sp.scadenza >= CURRENT_DATE
             AND LOWER(BTRIM(sp.valore2)) = 'annullato')
        AND NOT EXISTS (
          SELECT 1 FROM projects an
           WHERE an.campo = 'Anno' AND an.argument = a.id::text
             AND an.tenant_id = a.tenant_id AND an.user_id = a.user_id AND an.scadenza >= CURRENT_DATE
             AND regexp_replace(BTRIM(COALESCE(an.valore3::text, an.valore2, '')), '\\.0+$', '') ~ '^[0-9]{4}$'
             AND regexp_replace(BTRIM(COALESCE(an.valore3::text, an.valore2, '')), '\\.0+$', '')::int > EXTRACT(YEAR FROM CURRENT_DATE))
        -- Tipologia «Previsione»: non è ancora un progetto reale (scelta dell'utente, come Offerte e ordini).
        AND NOT EXISTS (
          SELECT 1 FROM projects t
           WHERE t.argument = a.id::text AND LOWER(BTRIM(t.campo)) IN ('tipologia', '(*) tipologia')
             AND t.tenant_id = a.tenant_id AND t.user_id = a.user_id AND t.scadenza >= CURRENT_DATE
             AND LOWER(BTRIM(t.valore2)) = 'previsione')`,
    [user.tenant_id, user.user_id]
  );
  return r.rows
    .map((x) => ({ projectId: x.id, clientId: x.client_id, nome: x.nome || 'Progetto', cliente: x.cliente || '', aperto: true }))
    .sort((a, b) => a.cliente.localeCompare(b.cliente, 'it') || a.nome.localeCompare(b.nome, 'it'));
}

// Salute di tutti i progetti aperti (portfolio, digest, notifiche): 4 progetti alla volta.
export async function saluteTuttiProgetti(user) {
  const progetti = await progettiAperti(user);
  const out = [];
  for (let i = 0; i < progetti.length; i += 4) {
    const blocco = await Promise.all(progetti.slice(i, i + 4).map(async (p) => {
      try { return await saluteProgetto(user, p.projectId, { prog: p }); }
      catch (e) { return { progetto: p, errore: e.message, semaforo: 'nd', indicatori: [] }; }
    }));
    out.push(...blocco);
  }
  return out;
}

// ----------------------------------------------------------------------------
// CONTESTO PER L'AI: tutto il progetto in testo semplice
// ----------------------------------------------------------------------------
export async function contestoProgetto(user, projectId, { riunioni = 5, dal = null, maxRecap = 3500 } = {}) {
  const prog = await progettoUtente(user, projectId);
  const scheda = await schedaProgetto(user, projectId);
  const salute = await saluteProgetto(user, projectId, { prog, scheda });
  const [raid, cr, task, issue, meet, righe] = await Promise.all([
    raidProgetto(user, projectId), crProgetto(user, projectId), taskProgetto(user, projectId),
    issueProgetto(user, projectId), riunioniProgetto(user, projectId, { limite: riunioni, dal }), righeGantt(user, projectId)
  ]);
  const u = salute.eac.unita;
  const L = [];
  L.push(`PROGETTO: ${prog.nome}`);
  L.push(`CLIENTE: ${prog.cliente || '-'}`);
  L.push(`Stato: ${scheda.stato || '-'} | Tipologia: ${scheda.tipologia || '-'} | Tipo: ${scheda.tipo || '-'} | Anno: ${scheda.anno || '-'}`);
  L.push(`Periodo: ${dataIt(scheda.start) || '-'} -> ${dataIt(scheda.end) || '-'} | Completamento: ${scheda.completamento != null ? `${fmt(scheda.completamento, 0)}%` : (salute.gantt.completamento != null ? `${fmt(salute.gantt.completamento, 0)}% (calcolato dal Gantt)` : 'non indicato')}`);
  if (scheda.descrizione) L.push(`Descrizione: ${scheda.descrizione}`);
  L.push(`Importo: ${scheda.importo != null ? euro(scheda.importo) : '-'} | Offerta inviata: ${dataIt(scheda.offertaInviata) || 'no'} | Ordine ricevuto: ${dataIt(scheda.ordineRicevuto) || 'no'}`);
  L.push('');
  L.push(`SALUTE: ${salute.semaforo.toUpperCase()}`);
  for (const i of salute.indicatori) L.push(`- ${i.titolo}: ${i.stato.toUpperCase()} - ${i.nota}`);
  const e = salute.eac;
  L.push(`Effort (${u}): budget ${fmt(e.bac)} (offerta ${fmt(e.bacOriginale)} + CR approvate ${fmt(e.crDelta)}), speso ${fmt(e.ac)}`
    + (e.eac != null ? `, stima a finire ${fmt(e.eac)} (${fmt(e.percPrevista, 0)}% del budget), mancano ${fmt(e.etc)}` : ', stima a finire non calcolabile (manca il completamento)')
    + (e.cpi != null ? `, indice di efficienza CPI ${fmt(e.cpi, 2)}` : ''));
  if (salute.economia.voci.length) L.push(`Voci di costo: ${salute.economia.voci.map((v) => `${v.voce} ${fmt(v.speso)}/${fmt(v.offerta)}`).join('; ')}`);
  // Economia in denaro (config/pmEconomia.js, import dinamico: i due moduli si usano a vicenda).
  try {
    const { economiaEuro, testoEconomia } = await import('./pmEconomia.js');
    const te = testoEconomia(await economiaEuro(user, projectId, { prog, scheda }));
    if (te) L.push(te);
  } catch (err) { console.error('PM contesto economia:', err.message); }
  L.push('');
  if (righe.length) {
    const g = salute.gantt;
    L.push(`GANTT (${righe.length} attività, completamento calcolato ${g.completamento != null ? `${fmt(g.completamento, 0)}%` : '-'}${g.baselineFine ? `, baseline fine ${dataIt(g.baselineFine)}, scostamento ${g.scostamentoGiorni} gg` : ''})`);
    for (const r of righe.slice(0, 120)) {
      L.push(`${'  '.repeat(r.livello - 1)}- ${r.nome}${r.milestone ? ' [MILESTONE]' : ''} | ${dataIt(r.inizio) || '?'} -> ${dataIt(r.fine) || '?'} | ${r.avanzamento}%${r.owner ? ` | ${r.owner}` : ''}${g.critico.includes(r.id) ? ' | CRITICA' : ''}`);
    }
    if (g.inRitardo.length) L.push(`In ritardo: ${g.inRitardo.map((x) => `${x.nome} (fine ${dataIt(x.fine)}, ${x.avanzamento}%)`).join('; ')}`);
    L.push('');
  }
  const rischi = raid.filter((x) => x.tipo === 'rischio');
  if (rischi.length) {
    L.push('RISCHI');
    rischi.forEach((x) => L.push(`- [${x.stato}] ${x.titolo} | P${x.probabilita || '?'} x I${x.impatto || '?'} = ${x.punteggio ?? '?'} | owner ${x.owner || '-'}${x.mitigazione ? ` | risposta: ${x.mitigazione}` : ''}${x.descrizione ? ` | ${x.descrizione}` : ''}`));
    L.push('');
  }
  const dec = raid.filter((x) => x.tipo === 'decisione');
  if (dec.length) {
    L.push('DECISIONI');
    dec.forEach((x) => L.push(`- ${dataIt(x.data_revisione) || ''} ${x.titolo}${x.decisa_da ? ` (decisa da ${x.decisa_da})` : ''}${x.descrizione ? `: ${x.descrizione}` : ''} [${x.stato}]`));
    L.push('');
  }
  const dip = raid.filter((x) => x.tipo === 'dipendenza' || x.tipo === 'assunzione');
  if (dip.length) {
    L.push('DIPENDENZE E ASSUNZIONI');
    dip.forEach((x) => L.push(`- (${x.tipo}) [${x.stato}] ${x.titolo}${x.owner ? ` | ${x.owner}` : ''}${x.descrizione ? ` | ${x.descrizione}` : ''}`));
    L.push('');
  }
  if (cr.length) {
    L.push('CHANGE REQUEST');
    cr.forEach((x) => L.push(`- ${x.codice || ''} ${x.titolo} | stato ${x.stato} | effort ${fmt(x.effort_delta)} ${u} | importo ${euro(x.importo_delta)} | tempi ${x.giorni_delta ?? 0} gg${x.motivo ? ` | motivo: ${x.motivo}` : ''}`));
    L.push('');
  }
  if (task.length) {
    L.push('AZIONI APERTE (To-Do)');
    task.slice(0, 60).forEach((t) => L.push(`- ${t.titolo}${t.descrizione ? `: ${t.descrizione.slice(0, 200)}` : ''} | ${t.assegnato || 'non assegnata'} | scadenza ${dataIt(t.scadenza) || '-'}${t.scaduta ? ' (SCADUTA)' : ''}`));
    L.push('');
  }
  if (issue.length) {
    L.push('ISSUE APERTE');
    issue.slice(0, 40).forEach((i) => L.push(`- [${i.priorita || '-'}] ${String(i.descrizione || '').slice(0, 250)} | owner ${i.owner || '-'} | stato ${i.stato || '-'}`));
    L.push('');
  }
  if (meet.length) {
    L.push('ULTIME RIUNIONI (recap)');
    meet.forEach((m) => L.push(`--- ${dataIt(m.data)} ${m.oggetto || ''}\n${String(m.recap || '').slice(0, maxRecap)}`));
  }
  return { prog, scheda, salute, raid, cr, task, issue, riunioni: meet, righe, testo: L.join('\n') };
}

// ----------------------------------------------------------------------------
// AI
// ----------------------------------------------------------------------------
async function settingValore(user, campo) {
  const c = String(campo).trim().toLowerCase();
  const r = (await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2 AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, c]
  )).rows[0];
  return r && r.valore2 ? String(r.valore2).trim() : '';
}

// AI per le funzioni PM: la prima AI esterna collegata tra «AI generazione e-mail recap»,
// «AI Slide Kick-Off» e «AI Offerta Economica»; se c'è solo «Recap Projexa (lento)» si usa
// quello (solo per i testi, non per le risposte strutturate). null se nessuna.
export async function aiPerPm(user, { soloEsterna = false } = {}) {
  const nomi = [];
  for (const c of ['AI generazione e-mail recap', 'AI Slide Kick-Off', 'AI Offerta Economica']) {
    const v = await settingValore(user, c);
    if (v && !nomi.includes(v)) nomi.push(v);
  }
  for (const nome of nomi) {
    const cfg = AI_PROVIDERS[nome.toLowerCase()];
    if (!cfg) continue;
    const el = await getIntegration(user.user_id, cfg.provider);
    if (el[`${cfg.prefix}_api_key`]) return { nome, locale: false, label: cfg.label };
  }
  if (!soloEsterna) {
    const locale = nomi.find((n) => localRecapMode(n) === 'server');
    if (locale) return { nome: locale, locale: true, label: 'Recap Projexa (lento)' };
  }
  return null;
}

// build(dati) -> prompt completo. Con l'AI locale i dati vengono riassunti a pezzi.
// ai: AI già scelta per la richiesta (req.aiScelta da Impostazioni › AI › «AI Funzioni PM»,
// vedi config/aiFunzioni.js e jobs/aiLavori.js); senza, la prima AI disponibile (aiPerPm).
export async function chiediAi(user, build, dati, { json = false, soloEsterna = false, ai: scelta = null } = {}) {
  if (scelta && !scelta.nome && scelta.errore) throw errore(428, scelta.errore);
  const ai = scelta && scelta.nome ? { nome: scelta.nome, locale: !!scelta.locale, label: scelta.label } : await aiPerPm(user, { soloEsterna: soloEsterna || json });
  if (!ai) {
    throw errore(428, json || soloEsterna
      ? 'Serve un\'AI con chiave API (ChatGPT, Claude, Gemini o Mistral): sceglila in Impostazioni › AI › «AI generazione e-mail recap» (o «AI Slide Kick-Off») e collega la sua chiave'
      : 'Nessuna AI disponibile: sceglila in Impostazioni › AI › «AI generazione e-mail recap» e collega la sua chiave');
  }
  const r = ai.locale
    ? await askOllamaRecap(async (t) => build(t), dati)
    : await askAiProvider(user.user_id, ai.nome, build(dati), json ? { json: true } : {});
  return { testo: String(r.text || ''), label: r.label || ai.label, model: r.model || '', locale: ai.locale };
}

// JSON dalla risposta dell'AI (anche dentro ```json … ``` o con testo attorno).
export function leggiJson(testo) {
  const s = String(testo || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* si cerca il primo oggetto */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* niente */ } }
  return null;
}
