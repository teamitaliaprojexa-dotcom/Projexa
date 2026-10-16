// ============================================================================
// CAPACITÀ E ALLOCAZIONE DELLE RISORSE (2026-10-16) - FUNZIONE FACOLTATIVA
// ----------------------------------------------------------------------------
// Si usa solo con Impostazioni › Preferenze › «Capacità e allocazione risorse» acceso
// (capacitaAttiva). Spenta, nessuna pagina, scheda o avviso la mostra: Projexa resta come prima.
// Tabelle: Supporto/CreaDB/capacita_risorse.sql. API: /api/pm/capacita* (routes/pm.js).
//
// Livelli (ognuno funziona anche senza i successivi):
//   0. FABBISOGNO per ruolo e mese, senza nomi: effort venduto - speso per voce di costo dei
//      Costi Progetto (il «ruolo»), distribuito sui giorni lavorativi da oggi alla fine del
//      progetto (campo End, altrimenti fine del Gantt). Senza date valide = «da pianificare».
//   1. CAPACITÀ: risorse (persona, ruolo = voce di costo, ore al giorno, % sui progetti) meno
//      festività italiane e assenze; ALLOCAZIONI persona × progetto in % e periodo.
//   2. CARICO per persona e settimana: allocato contro disponibile, rosso oltre il 100%.
// Unità: GIORNATE (progetti a ore: ore / 8). Ore al giorno della risorsa: giornata = ore/8.
// ============================================================================
import db from './database.js';
import {
  tabellaPresente, colonneTabella, oggiIso, progettiAperti, schedaProgetto, economiaProgetto, righeGantt, analisiGantt
} from './pmCore.js';
import { normVoce } from './pmEconomia.js';

export const CAMPO = 'capacità e allocazione risorse';
export const TABELLE = ['pm_risorse', 'pm_risorse_assenza', 'pm_allocazioni'];
const ORE_GIORNATA = 8;
const ORE_SETT_DEFAULT = 32; // ore lavorate a settimana se la persona non è in Rubrica
// Fasi di effort comuni a Gantt, Licenze da Attivare e Costi Progetto (colonne <fase>_hh / _gg).
const FASI = ['analisi', 'configurazione', 'formazione', 'programmazione'];

export async function capacitaAttiva(user) {
  const r = (await db.query(
    `SELECT valore1 FROM settings
      WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        AND LOWER(REGEXP_REPLACE(BTRIM(campo), '^\\(\\*\\)\\s*', '')) = $3
      ORDER BY id LIMIT 1`, [user.tenant_id, user.user_id, CAMPO])).rows[0];
  return !!r && ['true', 't', '1', 'yes', 'on'].includes(String(r.valore1 ?? '').trim().toLowerCase());
}
export async function tabellePresenti() {
  for (const t of TABELLE) if (!(await tabellaPresente(t))) return false;
  return true;
}

// ----------------------------------------------------------------------------
// CALENDARIO: giorni lavorativi (lun-ven) senza le festività nazionali italiane
// ----------------------------------------------------------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const giornoUtc = (s) => new Date(`${s}T12:00:00Z`);
const piu = (s, n) => { const d = giornoUtc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const cacheFeste = new Map();
function festivita(anno) {
  if (cacheFeste.has(anno)) return cacheFeste.get(anno);
  // Pasqua (algoritmo di Gauss/Meeus) -> Lunedì dell'Angelo.
  const a = anno % 19, b = Math.floor(anno / 100), c = anno % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mese = Math.floor((h + l - 7 * m + 114) / 31), giorno = ((h + l - 7 * m + 114) % 31) + 1;
  const pasqua = `${anno}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`;
  const s = new Set(['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'].map((x) => `${anno}-${x}`));
  s.add(piu(pasqua, 1));
  cacheFeste.set(anno, s);
  return s;
}
export const lavorativo = (s) => { const g = giornoUtc(s).getUTCDay(); return g !== 0 && g !== 6 && !festivita(Number(s.slice(0, 4))).has(s); };
// Giorni lavorativi da «dal» ad «al» compresi.
export function giorniLavorativi(dal, al) {
  const out = [];
  if (!dal || !al || al < dal) return out;
  for (let s = dal; s <= al; s = piu(s, 1)) if (lavorativo(s)) out.push(s);
  return out;
}
const lunedi = (s) => { const g = giornoUtc(s).getUTCDay(); return piu(s, g === 0 ? -6 : 1 - g); };
const fineMese = (m) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)); return iso(d); };
function elencoMesi(da, n) {
  const out = [];
  let y = Number(da.slice(0, 4)), m = Number(da.slice(5, 7));
  for (let i = 0; i < n; i++) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

// ----------------------------------------------------------------------------
// DATI
// ----------------------------------------------------------------------------
export async function risorse(user, { tutte = false } = {}) {
  if (!(await tabellaPresente('pm_risorse'))) return [];
  const r = await db.query(
    `SELECT id::text AS id, nominativo, email, ruolo, ore_giorno, perc_progetti, attiva, note, id_roles_write
       FROM pm_risorse WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
       ${tutte ? '' : 'AND attiva'}`, [user.tenant_id, user.user_id]);
  return r.rows.map((x) => ({ ...x, ore_giorno: Number(x.ore_giorno) || ORE_GIORNATA, perc_progetti: Number(x.perc_progetti) }))
    .sort((a, b) => String(a.nominativo).localeCompare(String(b.nominativo), 'it', { sensitivity: 'base' }));
}
export async function assenze(user, { risorsaId = null } = {}) {
  if (!(await tabellaPresente('pm_risorse_assenza'))) return [];
  const p = [user.tenant_id, user.user_id];
  if (risorsaId) p.push(risorsaId);
  return (await db.query(
    `SELECT id::text AS id, risorsa_id::text AS risorsa_id, dal::text AS dal, al::text AS al, nota, id_roles_write
       FROM pm_risorse_assenza WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
       ${risorsaId ? 'AND risorsa_id::text = $3' : ''} ORDER BY dal`, p)).rows;
}
export async function allocazioni(user, { projectId = null, risorsaId = null } = {}) {
  if (!(await tabellaPresente('pm_allocazioni'))) return [];
  const p = [user.tenant_id, user.user_id];
  const w = [];
  if (projectId) { p.push(projectId); w.push(`a.project_id::text = $${p.length}`); }
  if (risorsaId) { p.push(risorsaId); w.push(`a.risorsa_id::text = $${p.length}`); }
  return (await db.query(
    `SELECT a.id::text AS id, a.risorsa_id::text AS risorsa_id, a.project_id::text AS project_id, a.client_id::text AS client_id,
            a.perc, a.dal::text AS dal, a.al::text AS al, a.note, a.id_roles_write,
            r.nominativo, r.email, r.ruolo, r.ore_giorno, pr.valore2 AS progetto, c.valore2 AS cliente
       FROM pm_allocazioni a
       LEFT JOIN pm_risorse r ON r.id = a.risorsa_id
       LEFT JOIN projects pr ON pr.id = a.project_id
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = $1 AND a.user_id = $2 AND (a.scadenza IS NULL OR a.scadenza >= CURRENT_DATE)
        ${w.length ? `AND ${w.join(' AND ')}` : ''}
      ORDER BY a.dal, r.nominativo`, p)).rows.map((x) => ({ ...x, perc: Number(x.perc), ore_giorno: Number(x.ore_giorno) || ORE_GIORNATA }));
}

// ----------------------------------------------------------------------------
// LIVELLO 0: FABBISOGNO RESIDUO PER RUOLO (voce di costo) E MESE
// ----------------------------------------------------------------------------
// Effort per RUOLO del progetto. Il ruolo è la voce di costo del TENANT (conf_worker_cost,
// «Configurazione gruppi Billing») con lo stesso codice di fatturazione della voce del progetto
// (scelta dell'utente 2026-10-16: vale il codice, non il nome: «Analista», «Delivery HCM» e
// «Delivery Automation» con AVV/HR contano come «Delivery Presenze Hcm»). Senza codice o senza
// voce del tenant con quel codice resta il nome della voce del progetto. Stesse regole di
// economiaProgetto (pmCore.js) per ore/giornate e righe valide.
async function effortPerRuolo(user, projectId) {
  const r = await db.query(
    `SELECT COALESCE(cv.descr, wc.desc_worker, 'Senza voce') AS voce, hh.gestione_hh AS hh,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END) AS offerta,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END) AS speso,
            ${FASI.map((f) => `SUM(COALESCE((to_jsonb(a) ->> (CASE WHEN hh.gestione_hh THEN '${f}_hh' ELSE '${f}_gg' END))::numeric, 0)) AS ${f}`).join(',\n            ')}
       FROM proj_worker a
       LEFT JOIN proj_worker_cost wc ON wc.id = a.worker_cost_id AND wc.scadenza >= CURRENT_DATE
       LEFT JOIN LATERAL (
         SELECT BTRIM(c.desc_worker) AS descr FROM conf_worker_cost c
          WHERE c.tenant_id = a.tenant_id AND BTRIM(c.cod_billing) = BTRIM(wc.cod_billing)
            AND (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE)
          ORDER BY c.desc_worker LIMIT 1
       ) cv ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(bool_or(b.valore1), false) AS gestione_hh
           FROM projects b
          WHERE b.campo = 'Gestione a HH' AND b.argument = a.project_id::text
            AND b.tenant_id = a.tenant_id AND b.user_id = a.user_id AND b.scadenza >= CURRENT_DATE
       ) hh ON true
      WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.project_id::text = $3 AND a.scadenza >= CURRENT_DATE
      GROUP BY 1, 2`,
    [user.tenant_id, user.user_id, projectId]);
  return {
    aOre: r.rows.some((x) => x.hh),
    voci: r.rows.map((x) => ({ voce: x.voce, offerta: Number(x.offerta) || 0, speso: Number(x.speso) || 0, fasi: Object.fromEntries(FASI.map((f) => [f, Number(x[f]) || 0])) }))
  };
}

async function fabbisognoProgetto(user, p, oggi) {
  const conConf = await tabellaPresente('conf_worker_cost');
  const [scheda, eco, righe] = await Promise.all([schedaProgetto(user, p.projectId), conConf ? effortPerRuolo(user, p.projectId) : economiaProgetto(user, p.projectId), righeGantt(user, p.projectId)]);
  const g = analisiGantt(righe, oggi);
  const inizio = scheda.start || g.inizio || null;
  const fine = scheda.end || g.fine || null;
  // In giornate: stima (offerta), consuntivo (speso, ore Qlik; NON il fatturato), residuo = stima - consuntivo.
  const gg = (v) => (eco.aOre ? (v || 0) / ORE_GIORNATA : (v || 0));
  const tutte = eco.voci.map((v) => {
    const stima = gg(v.offerta), consuntivo = gg(v.speso);
    return { voce: v.voce, stima, consuntivo, residuo: Math.max(0, stima - consuntivo) };
  }).filter((v) => v.stima > 0 || v.consuntivo > 0);
  // Residui sotto 0,05 giornate (arrotondati a «0») contano come zero: non si mostrano.
  const voci = tutte.filter((v) => v.residuo >= 0.05);
  // Voci con consuntivo pari o oltre la stima (nessuna giornata da pianificare).
  const esaurite = tutte.filter((v) => v.residuo < 0.05 && v.stima > 0);
  let motivo = null;
  if (!fine) motivo = 'senza data di fine (campo End o Gantt)';
  else if (fine < oggi) motivo = `fine prevista superata (${fine.split('-').reverse().join('/')})`;
  return { ...p, inizio, fine, aOre: eco.aOre, voci, esaurite, haVoci: tutte.length > 0, motivo };
}

export async function fabbisogno(user, { mesi = 6, projectId = null } = {}) {
  const oggi = oggiIso();
  let progetti = await progettiAperti(user);
  if (projectId) progetti = progetti.filter((p) => p.projectId === projectId);
  const dati = [];
  for (let i = 0; i < progetti.length; i += 4) {
    dati.push(...await Promise.all(progetti.slice(i, i + 4).map((p) => fabbisognoProgetto(user, p, oggi).catch((e) => ({ ...p, errore: e.message, voci: [] })))));
  }
  const mm = elencoMesi(oggi, mesi);
  const ultimo = fineMese(mm[mm.length - 1]);
  // Per ruolo e progetto: stima, consuntivo, daPianificare (= residuo = stima - consuntivo),
  // distribuito nei mesi (perMese), dopo l'orizzonte (oltre) o, senza date valide, in senzaDate.
  const ruoli = new Map(); // normVoce -> { ruolo, stima, consuntivo, daPianificare, perMese, oltre, senzaDate, progetti: Map }
  const zero = () => ({ stima: 0, consuntivo: 0, daPianificare: 0, perMese: Object.fromEntries(mm.map((m) => [m, 0])), oltre: 0, senzaDate: 0 });
  const ruolo = (voce) => {
    const k = normVoce(voce);
    if (!ruoli.has(k)) ruoli.set(k, { chiave: k, ruolo: voce, ...zero(), progetti: new Map() });
    return ruoli.get(k);
  };
  for (const p of dati) {
    for (const v of p.voci) {
      const r = ruolo(v.voce);
      const rp = r.progetti.get(p.projectId) || { projectId: p.projectId, nome: p.nome, cliente: p.cliente, ...zero(), residuo: 0, motivo: p.motivo, inizio: p.inizio, fine: p.fine, clientId: p.clientId };
      rp.residuo += v.residuo;
      for (const o of [r, rp]) { o.stima += v.stima; o.consuntivo += v.consuntivo; o.daPianificare += v.residuo; }
      if (p.motivo) { r.senzaDate += v.residuo; rp.senzaDate += v.residuo; }
      else {
        const da = p.inizio && p.inizio > oggi ? p.inizio : oggi;
        const giorni = giorniLavorativi(da, p.fine);
        if (!giorni.length) { r.senzaDate += v.residuo; rp.senzaDate += v.residuo; rp.motivo = 'nessun giorno lavorativo nel periodo'; }
        else {
          const alGiorno = v.residuo / giorni.length;
          for (const d of giorni) {
            const m = d.slice(0, 7);
            if (d > ultimo) { r.oltre += alGiorno; rp.oltre += alGiorno; } else if (r.perMese[m] != null) { r.perMese[m] += alGiorno; rp.perMese[m] += alGiorno; }
          }
        }
      }
      r.progetti.set(p.projectId, rp);
    }
  }
  // Persone del team di ogni progetto con quel ruolo (quelle che rientrano nei conteggi): nome
  // dalla Rubrica (per email) se c'è, consuntivo in giornate (ore Qlik / 8) e allocazioni.
  try {
    const ids = [...new Set([...ruoli.values()].flatMap((r) => [...r.progetti.keys()]))];
    if (ids.length) {
      const { rubricaUtente } = await import('./azioniCliente.js');
      const [team, rub, all, ris] = await Promise.all([teamConRuolo(user, ids), rubricaUtente(user), allocazioni(user), risorse(user, { tutte: true })]);
      const nomeRub = new Map(rub.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c.nominativo]));
      const emailRis = new Map(ris.map((r) => [r.id, String(r.email || '').trim().toLowerCase()]));
      for (const t of team) {
        const r = ruoli.get(normVoce(t.ruolo || ''));
        const rp = r && r.progetti.get(t.project_id);
        if (!rp) continue;
        const email = String(t.email || '').trim().toLowerCase();
        rp.persone = rp.persone || new Map();
        const k = email || String(t.nominativo || '').toLowerCase();
        const x = rp.persone.get(k) || { nominativo: nomeRub.get(email) || String(t.nominativo || email).trim(), email, consuntivo: 0, allocazioni: [] };
        x.consuntivo += (Number(t.time_spent_hh) || 0) / ORE_GIORNATA;
        rp.persone.set(k, x);
      }
      for (const a of all.filter((a) => a.al >= oggi)) {
        const email = emailRis.get(a.risorsa_id);
        for (const r of ruoli.values()) {
          const x = r.progetti.get(a.project_id)?.persone?.get(email);
          if (x) x.allocazioni.push({ perc: a.perc, dal: a.dal, al: a.al });
        }
      }
    }
  } catch (e) { console.error('[CAPACITA] persone dei progetti:', e.message); }
  for (const r of ruoli.values()) for (const rp of r.progetti.values()) {
    rp.persone = rp.persone ? [...rp.persone.values()].sort((a, b) => b.consuntivo - a.consuntivo || a.nominativo.localeCompare(b.nominativo, 'it')) : [];
  }
  return {
    oggi, mesi: mm,
    ruoli: [...ruoli.values()].map((r) => ({ ...r, progetti: [...r.progetti.values()].sort((a, b) => b.residuo - a.residuo) }))
      .sort((a, b) => a.ruolo.localeCompare(b.ruolo, 'it')),
    // Nessuna riga nei Costi Progetto (stima e consuntivo a zero).
    progettiSenzaVoci: dati.filter((p) => !p.haVoci && !p.errore).map((p) => ({ projectId: p.projectId, nome: p.nome, cliente: p.cliente })),
    // Costi Progetto presenti ma consuntivo pari o oltre la stima in tutte le voci: niente da pianificare.
    progettiEsauriti: dati.filter((p) => p.haVoci && !p.voci.length && !p.errore).map((p) => ({
      projectId: p.projectId, nome: p.nome, cliente: p.cliente,
      voci: p.esaurite.map((v) => ({ voce: v.voce, stima: v.stima, consuntivo: v.consuntivo }))
    })),
    errori: dati.filter((p) => p.errore).map((p) => `${p.nome}: ${p.errore}`)
  };
}

// ----------------------------------------------------------------------------
// LIVELLO 1-2: CAPACITÀ, ALLOCATO E CARICO
// ----------------------------------------------------------------------------
// Giorni di assenza di una risorsa (Set di date ISO).
function giorniAssenza(lista) {
  const s = new Set();
  for (const a of lista) for (let d = a.dal; d <= a.al; d = piu(d, 1)) s.add(d);
  return s;
}

// Ore lavorate a settimana di ogni risorsa: rubrica.ore_lavorate_sett della stessa email
// (Supporto/CreaDB/rubrica_ore_settimanali.sql, default 32), prima la rubrica dell'utente poi quella
// degli altri utenti del tenant; senza rubrica 32 (scelta dell'utente: una sola fonte, la Rubrica).
// Restituisce Map(email minuscola -> ore) e la funzione ore(risorsa).
export async function oreSettimanali(user) {
  const perEmail = new Map();
  if ((await colonneTabella('rubrica')).has('ore_lavorate_sett')) {
    const r = await db.query(
      `SELECT user_id::text AS user_id, email, ore_lavorate_sett FROM rubrica
        WHERE tenant_id = $1 AND ore_lavorate_sett IS NOT NULL AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`, [user.tenant_id]);
    const mie = r.rows.filter((x) => x.user_id === String(user.user_id));
    for (const x of [...r.rows.filter((y) => y.user_id !== String(user.user_id)), ...mie]) { // le mie per ultime: vincono
      const e = String(x.email || '').trim().toLowerCase();
      if (e && Number(x.ore_lavorate_sett) > 0) perEmail.set(e, Number(x.ore_lavorate_sett));
    }
  }
  const ore = (r) => perEmail.get(String(r.email || '').trim().toLowerCase()) || ORE_SETT_DEFAULT;
  return { perEmail, ore };
}

// Allocazioni in corso o future degli ALTRI utenti del tenant (altri PM), con l'email della
// persona (pm_risorse del loro registro) e il nome del PM. Servono a sommare il carico di tutto
// il tenant sulle stesse persone.
async function allocazioniAltriPm(user) {
  if (!(await tabellaPresente('pm_allocazioni'))) return [];
  const r = await db.query(
    `SELECT a.user_id::text AS pm_id, a.perc, a.dal::text AS dal, a.al::text AS al, r.email, r.nominativo,
            pr.valore2 AS progetto, c.valore2 AS cliente, NULLIF(BTRIM(concat_ws(' ', u.name, u.cognome)), '') AS pm
       FROM pm_allocazioni a
       JOIN pm_risorse r ON r.id = a.risorsa_id
       LEFT JOIN projects pr ON pr.id = a.project_id
       LEFT JOIN clients c ON c.id = a.client_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = $1 AND a.user_id <> $2 AND a.al >= CURRENT_DATE
        AND (a.scadenza IS NULL OR a.scadenza >= CURRENT_DATE) AND (r.scadenza IS NULL OR r.scadenza >= CURRENT_DATE)`,
    [user.tenant_id, user.user_id]).catch(() => ({ rows: [] }));
  return r.rows.map((x) => ({ ...x, perc: Number(x.perc), email: String(x.email || '').trim().toLowerCase(), pm: x.pm || 'Altro PM' }));
}

// Per ogni risorsa e giorno lavorativo del periodo:
//   - capacità per la pianificazione (giornate) = ore/sett ÷ 5 ÷ 8 (Fabbisogno);
//   - allocato da me (giornate) = % allocata × ore/sett ÷ 5 ÷ 8;
//   - allocato dagli altri PM del tenant sulla stessa persona (stessa email), stesso calcolo;
//   - ore disponibili = ore/sett ÷ 5 per ogni giorno lavorativo non di assenza.
// Settimana in sovraccarico (sovraTenant) = ore allocate da tutto il tenant > ore disponibili.
export async function capacitaECarico(user, { mesi = 6, settimane = 12 } = {}) {
  const oggi = oggiIso();
  const [ris, ass, all, altri, ore] = await Promise.all([risorse(user), assenze(user), allocazioni(user), allocazioniAltriPm(user), oreSettimanali(user)]);
  const mm = elencoMesi(oggi, mesi);
  const primoLun = lunedi(oggi);
  const ss = Array.from({ length: settimane }, (_, i) => piu(primoLun, i * 7));
  const fineMesi = fineMese(mm[mm.length - 1]);
  const fineSett = piu(ss[ss.length - 1], 6);
  const al = fineMesi > fineSett ? fineMesi : fineSett;
  const giorni = giorniLavorativi(primoLun, al);
  const perRuolo = new Map();
  const persone = [];
  for (const r of ris) {
    const oreSett = ore.ore(r);
    const giornoPieno = oreSett / 5 / ORE_GIORNATA; // giornate per giorno lavorato al 100%
    const assenti = giorniAssenza(ass.filter((a) => a.risorsa_id === r.id));
    const mie = all.filter((a) => a.risorsa_id === r.id);
    const email = String(r.email || '').trim().toLowerCase();
    const sueAltri = email ? altri.filter((a) => a.email === email) : [];
    const sett = Object.fromEntries(ss.map((s) => [s, { capacita: 0, allocato: 0, altri: 0, oreDisp: 0, assenze: 0, progetti: {}, altriDett: {} }]));
    const k = normVoce(r.ruolo || 'Senza ruolo');
    if (!perRuolo.has(k)) perRuolo.set(k, { chiave: k, ruolo: r.ruolo || 'Senza ruolo', capacita: Object.fromEntries(mm.map((m) => [m, 0])), allocato: Object.fromEntries(mm.map((m) => [m, 0])), persone: 0 });
    const pr = perRuolo.get(k);
    pr.persone += 1;
    for (const d of giorni) {
      if (d < oggi) continue; // si conta da oggi
      const assente = assenti.has(d);
      const cap = assente ? 0 : giornoPieno;
      let allD = 0, altD = 0;
      const perProg = {}, perAltro = {};
      if (!assente) {
        for (const a of mie) if (d >= a.dal && d <= a.al) { const x = (a.perc / 100) * giornoPieno; allD += x; perProg[a.project_id] = (perProg[a.project_id] || 0) + x; }
        for (const a of sueAltri) if (d >= a.dal && d <= a.al) {
          const x = (a.perc / 100) * giornoPieno; altD += x;
          const kk = `${a.pm} · ${a.cliente ? `${a.cliente} · ` : ''}${a.progetto || 'Progetto'}`;
          perAltro[kk] = (perAltro[kk] || 0) + x;
        }
      }
      const m = d.slice(0, 7);
      if (pr.capacita[m] != null) { pr.capacita[m] += cap; pr.allocato[m] += allD; }
      const w = lunedi(d);
      if (sett[w]) {
        const x = sett[w];
        x.capacita += cap; x.allocato += allD; x.altri += altD; if (!assente) x.oreDisp += oreSett / 5; else x.assenze += 1;
        for (const [pid, v] of Object.entries(perProg)) x.progetti[pid] = (x.progetti[pid] || 0) + v;
        for (const [kk, v] of Object.entries(perAltro)) x.altriDett[kk] = (x.altriDett[kk] || 0) + v;
      }
    }
    const settimaneP = ss.map((s) => {
      const x = sett[s];
      const oreTot = (x.allocato + x.altri) * ORE_GIORNATA;
      const carico = x.oreDisp > 0 ? (oreTot / x.oreDisp) * 100 : (oreTot > 0 ? null : 0);
      return {
        dal: s, capacita: x.capacita, allocato: x.allocato, altri: x.altri, altriDett: x.altriDett, assenze: x.assenze, progetti: x.progetti,
        oreTot, oreDisp: x.oreDisp, carico,
        sovra: oreTot > x.oreDisp + 0.01 && oreTot > 0 // sovraccarico considerando tutto il tenant
      };
    });
    persone.push({
      id: r.id, nominativo: r.nominativo, ruolo: r.ruolo, perc_progetti: r.perc_progetti, ore_giorno: r.ore_giorno, oreSett,
      oreDaRubrica: ore.perEmail.has(email), settimaneSovra: settimaneP.filter((s) => s.sovra).length, conAltri: settimaneP.some((s) => s.altri > 0),
      settimane: settimaneP
    });
  }
  const nomiProgetti = Object.fromEntries(all.map((a) => [a.project_id, `${a.cliente ? `${a.cliente} · ` : ''}${a.progetto || 'Progetto'}`]));
  return { oggi, mesi: mm, settimane: ss, ruoli: [...perRuolo.values()], persone, nomiProgetti };
}

// Persone sovrallocate nelle prossime N settimane, sommando tutti i PM del tenant (campanella).
export async function sovrallocazioni(user, settimane = 4) {
  const c = await capacitaECarico(user, { mesi: 1, settimane });
  const out = [];
  for (const p of c.persone) for (const s of p.settimane) if (s.sovra && s.allocato > 0) out.push({ risorsaId: p.id, nominativo: p.nominativo, settimana: s.dal, carico: s.carico, allocato: (s.allocato + s.altri), capacita: s.oreDisp / ORE_GIORNATA });
  return out;
}

// Team dei progetti (proj_componenti) con il RUOLO della persona nel progetto: la sua voce di
// costo nel team (team_pro), riportata alla voce del tenant con lo stesso codice di fatturazione.
export async function teamConRuolo(user, projectIds = null) {
  const p = [user.tenant_id, user.user_id];
  if (projectIds) p.push(projectIds);
  const ruolo = (await tabellaPresente('conf_worker_cost'))
    ? `COALESCE((SELECT BTRIM(k.desc_worker) FROM conf_worker_cost k
                  WHERE k.tenant_id = c.tenant_id AND BTRIM(k.cod_billing) = BTRIM(w.cod_billing)
                    AND (k.scadenza IS NULL OR k.scadenza >= CURRENT_DATE) ORDER BY k.desc_worker LIMIT 1), w.desc_worker)`
    : 'w.desc_worker';
  // nel_piano (Supporto/CreaDB/team_nel_piano.sql): senza colonna tutti nel piano.
  const colTeam = await colonneTabella('proj_componenti');
  return (await db.query(
    `SELECT c.id::text AS id, c.project_id::text AS project_id, c.nominativo, c.email, c.time_spent_hh, ${ruolo} AS ruolo,
            ${colTeam.has('nel_piano') ? 'c.nel_piano' : 'true'} AS nel_piano, ${colTeam.has('id_roles_write') ? 'c.id_roles_write' : 'NULL'} AS id_roles_write
       FROM proj_componenti c
       LEFT JOIN proj_worker_cost w ON w.id = c.team_pro
      WHERE c.tenant_id = $1 AND c.user_id = $2 AND (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE)
        ${projectIds ? 'AND c.project_id::text = ANY($3::text[])' : ''}`, p)).rows;
}

// ----------------------------------------------------------------------------
// PROPOSTE DI ALLOCAZIONE DAI TEAM DEI PROGETTI (pulsante «Dai team dei progetti»)
// ----------------------------------------------------------------------------
// Per ogni progetto aperto con effort ancora da fare: le persone del team (proj_componenti,
// Kick-off): se già tra le risorse (stessa email o stesso nome) con il loro id, altrimenti con
// risorsa_id null (la risorsa si crea al salvataggio, /capacita/progetto/alloca). Periodo = da oggi
// (o dall'inizio se futuro) alla fine del progetto; percentuale = giornate ancora da fare per il
// ruolo della persona, divise tra le persone del team con quel ruolo, rapportate ai giorni
// disponibili (giorni lavorativi × ore settimanali della Rubrica ÷ 5 ÷ 8), arrotondata a 5 (5-100%).
// Saltate: persone già allocate sul progetto, progetti senza fine valida, ruolo senza effort.
export async function proposteAllocazioni(user) {
  const { normNome } = await import('./azioniCliente.js');
  const oggi = oggiIso();
  const [fab, ris, all, ore] = await Promise.all([fabbisogno(user, { mesi: 12 }), risorse(user), allocazioni(user), oreSettimanali(user)]);
  const perEmail = new Map(ris.filter((r) => r.email).map((r) => [String(r.email).trim().toLowerCase(), r]));
  const perNome = new Map(ris.map((r) => [normNome(r.nominativo), r]));
  const giaAllocate = new Set(all.filter((a) => a.al >= oggi).map((a) => `${a.risorsa_id}|${a.project_id}`));
  // progetto -> { dati, ruoli: chiave -> residuo }
  const progetti = new Map();
  for (const r of fab.ruoli) for (const p of r.progetti) {
    if (!progetti.has(p.projectId)) progetti.set(p.projectId, { p, ruoli: new Map() });
    progetti.get(p.projectId).ruoli.set(r.chiave, { ruolo: r.ruolo, residuo: p.residuo });
  }
  const proposte = [];
  const saltate = { senzaFine: 0, giaAllocate: 0, ruoloSenzaEffort: 0 };
  if (!progetti.size) return { proposte, saltate };
  const team = await teamConRuolo(user, [...progetti.keys()]);
  for (const [pid, { p, ruoli }] of progetti) {
    // Persone del team riconosciute tra le Risorse (una volta sola per progetto), con il ruolo
    // che hanno IN QUESTO progetto (voce del team); senza voce nel team, quello della risorsa.
    const persone = new Map();
    for (const t of team.filter((x) => x.project_id === pid)) {
      const email = String(t.email || '').trim().toLowerCase();
      const r = perEmail.get(email) || perNome.get(normNome(t.nominativo));
      if (r) persone.set(r.id, { ...r, ruolo: t.ruolo || r.ruolo });
      else if (t.nominativo) {
        const k = email || normNome(t.nominativo);
        if (!persone.has(k)) persone.set(k, { id: null, chiave: k, nominativo: t.nominativo, email: t.email || null, ruolo: t.ruolo });
      }
    }
    if (!persone.size) continue;
    const fine = p.fine;
    if (p.motivo || !fine) { saltate.senzaFine += persone.size; continue; }
    const dal = p.inizio && p.inizio > oggi ? p.inizio : oggi;
    const giorni = giorniLavorativi(dal, fine).length;
    if (!giorni) { saltate.senzaFine += persone.size; continue; }
    const perRuolo = new Map(); // ruolo -> persone del team con quel ruolo
    for (const r of persone.values()) {
      const k = normVoce(r.ruolo || '');
      if (!perRuolo.has(k)) perRuolo.set(k, []);
      perRuolo.get(k).push(r);
    }
    for (const [k, lista] of perRuolo) {
      const eff = ruoli.get(k);
      for (const r of lista) {
        if (r.id && giaAllocate.has(`${r.id}|${pid}`)) { saltate.giaAllocate += 1; continue; }
        if (!eff || eff.residuo <= 0) { saltate.ruoloSenzaEffort += 1; continue; }
        const giornate = eff.residuo / lista.length;
        const disponibili = giorni * (ore.ore(r) / 5 / ORE_GIORNATA); // ore settimanali dalla Rubrica
        const perc = disponibili > 0 ? Math.min(100, Math.max(5, Math.round(((giornate / disponibili) * 100) / 5) * 5)) : 100;
        proposte.push({
          risorsa_id: r.id, email: r.email || null, nominativo: r.nominativo, ruolo: eff.ruolo, projectId: pid, progetto: p.nome, cliente: p.cliente,
          dal, al: fine, perc, giornate: Math.round(giornate * 10) / 10, colleghi: lista.length
        });
      }
    }
  }
  proposte.sort((a, b) => String(a.cliente).localeCompare(String(b.cliente), 'it') || String(a.progetto).localeCompare(String(b.progetto), 'it') || a.nominativo.localeCompare(b.nominativo, 'it'));
  return { proposte, saltate };
}

// ----------------------------------------------------------------------------
// COPERTURA (scheda «Copertura», prima vista della pagina): per ogni progetto e ruolo, le
// giornate da pianificare contro quelle già coperte dalle allocazioni, mese per mese, e gli
// avvisi di incoerenza. Non serve conoscere il resto dell'agenda delle persone.
// Allocato di una persona su un progetto = giorni lavorativi del periodo (da oggi, festività e
// assenze escluse) × % allocata × ore/8. Il ruolo è quello della persona NEL progetto (voce del
// team), altrimenti quello della risorsa.
// ----------------------------------------------------------------------------
const fmtG = (v) => (Math.round((v || 0) * 10) / 10).toLocaleString('it-IT');
const dataItaliana = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');

// fab = fabbisogno già calcolato (facoltativo: evita di rifarlo).
export async function copertura(user, { mesi = 6, fab: fabPronto = null } = {}) {
  const { normNome } = await import('./azioniCliente.js');
  const oggi = oggiIso();
  const [fab, ris, all, ass, ore] = await Promise.all([fabPronto || fabbisogno(user, { mesi }), risorse(user, { tutte: true }), allocazioni(user), assenze(user), oreSettimanali(user)]);
  const mm = fab.mesi;
  const perRis = new Map(ris.map((r) => [r.id, r]));
  const assenti = new Map(ris.map((r) => [r.id, giorniAssenza(ass.filter((a) => a.risorsa_id === r.id))]));
  const ids = [...new Set(fab.ruoli.flatMap((r) => r.progetti.map((p) => p.projectId)).concat(all.map((a) => a.project_id)))];
  const team = ids.length ? await teamConRuolo(user, ids) : [];
  const ruoloNelProgetto = (a) => {
    const r = perRis.get(a.risorsa_id) || {};
    const email = String(r.email || '').trim().toLowerCase();
    const t = team.find((x) => x.project_id === a.project_id && ((email && String(x.email || '').trim().toLowerCase() === email) || normNome(x.nominativo) === normNome(r.nominativo)));
    return (t && t.ruolo) || r.ruolo || 'Senza ruolo';
  };
  // Righe progetto × ruolo dal fabbisogno.
  const righe = new Map();
  const riga = (projectId, ruolo, base = {}) => {
    const k = `${projectId}|${normVoce(ruolo)}`;
    if (!righe.has(k)) {
      righe.set(k, { projectId, ruolo, chiave: normVoce(ruolo), nome: base.nome || '', cliente: base.cliente || '', fine: base.fine || null, motivo: base.motivo || null,
        daPianificare: 0, coperto: 0, perMese: Object.fromEntries(mm.map((m) => [m, { fab: 0, all: 0 }])), persone: [] });
    }
    return righe.get(k);
  };
  const datiProgetto = new Map();
  for (const r of fab.ruoli) for (const p of r.progetti) {
    datiProgetto.set(p.projectId, { nome: p.nome, cliente: p.cliente, fine: p.fine, motivo: p.motivo });
    const x = riga(p.projectId, r.ruolo, p);
    x.daPianificare += p.daPianificare;
    mm.forEach((m) => { x.perMese[m].fab += p.perMese[m] || 0; });
  }
  // Allocazioni in corso o future, distribuite sui giorni lavorativi.
  const m0 = mm[mm.length - 1];
  const ultimoMese = new Date(Date.UTC(+m0.slice(0, 4), +m0.slice(5, 7), 0)).toISOString().slice(0, 10);
  const attive = all.filter((x) => x.al >= oggi);
  // Fasi del Gantt (Analisi, Configurazione…) che la persona ha nel periodo di ogni allocazione:
  // attività con effort per fase, non finite, con date che toccano il periodo e con la persona nel
  // Nominativo (o Nominativo vuoto = chi del team è allocato). Per il tooltip della Copertura.
  const gantt = new Map(await Promise.all([...new Set(attive.map((a) => a.project_id))]
    .map(async (id) => [id, await righeGantt(user, id).catch(() => [])])));
  const fasiNelPeriodo = (a, nominativo) => {
    const righeG = gantt.get(a.project_id) || [];
    const haFigli = new Set(righeG.map((x) => x.chiave.split('.').slice(0, -1).join('.')).filter(Boolean));
    const top = new Map(righeG.filter((x) => x.livello === 1).map((x) => [x.chiave, x.nome]));
    const perFase = new Map();
    for (const x of righeG) {
      if (haFigli.has(x.chiave) || x.avanzamento >= 100 || !x.inizio || !x.fine || x.fine < a.dal || x.inizio > a.al) continue;
      const nomi = x.nominativo ? x.nominativo.split(',').map((s) => normNome(s)) : [];
      if (nomi.length && !nomi.includes(normNome(nominativo))) continue;
      const modulo = String(top.get(x.chiave.split('.')[0]) || '').replace(/^Modulo\s+/i, '');
      for (const f of FASI) if (x.fasi && x.fasi[f] > 0) {
        if (!perFase.has(f)) perFase.set(f, new Set());
        if (modulo) perFase.get(f).add(modulo);
      }
    }
    return FASI.filter((f) => perFase.has(f)).map((f) => ({ fase: f, moduli: [...perFase.get(f)] }));
  };
  for (const a of attive) {
    const r = perRis.get(a.risorsa_id);
    if (!r) continue;
    const dp = datiProgetto.get(a.project_id) || { nome: a.progetto || '', cliente: a.cliente || '', fine: null };
    const x = riga(a.project_id, ruoloNelProgetto(a), dp);
    const fattore = (a.perc / 100) * (ore.ore(r) / 5 / ORE_GIORNATA); // ore/sett della persona (Rubrica)
    const ass1 = assenti.get(r.id) || new Set();
    let tot = 0;
    const perMeseP = {}; // giornate coperte da questa persona in ogni mese (tooltip)
    for (const d of giorniLavorativi(a.dal > oggi ? a.dal : oggi, a.al)) {
      if (ass1.has(d)) continue;
      tot += fattore;
      const m = d.slice(0, 7);
      if (d <= ultimoMese && x.perMese[m]) { x.perMese[m].all += fattore; perMeseP[m] = (perMeseP[m] || 0) + fattore; }
    }
    x.coperto += tot;
    x.persone.push({ id: a.id, nominativo: r.nominativo, perc: a.perc, dal: a.dal, al: a.al, note: a.note || '', attivita: fasiNelPeriodo(a, r.nominativo), giornate: tot, perMese: perMeseP, oreSett: ore.ore(r) });
  }
  const lista = [...righe.values()].map((x) => ({ ...x, scoperto: Math.max(0, x.daPianificare - x.coperto), eccesso: Math.max(0, x.coperto - x.daPianificare) }));
  // Raggruppate per progetto, prima i progetti con più giornate scoperte.
  const progetti = new Map();
  for (const x of lista) {
    if (!progetti.has(x.projectId)) progetti.set(x.projectId, { projectId: x.projectId, nome: x.nome, cliente: x.cliente, fine: x.fine, motivo: x.motivo, daPianificare: 0, coperto: 0, scoperto: 0, ruoli: [] });
    const p = progetti.get(x.projectId);
    p.daPianificare += x.daPianificare;
    p.coperto += Math.min(x.coperto, x.daPianificare);
    p.scoperto += x.scoperto;
    p.ruoli.push(x);
  }
  const elenco = [...progetti.values()].sort((a, b) => b.scoperto - a.scoperto || String(a.cliente).localeCompare(String(b.cliente), 'it'));
  elenco.forEach((p) => p.ruoli.sort((a, b) => b.scoperto - a.scoperto || a.ruolo.localeCompare(b.ruolo, 'it')));

  // Avvisi di incoerenza.
  const avvisi = [];
  const nomeP = (x) => `${x.cliente ? `${x.cliente} · ` : ''}${x.nome}`;
  for (const x of lista) {
    if (x.daPianificare >= 0.5 && !x.persone.length) {
      avvisi.push({ tipo: 'nessuno', gravita: 'alta', projectId: x.projectId, testo: `${nomeP(x)} · ${x.ruolo}: ${fmtG(x.daPianificare)} giornate da fare e nessuna persona allocata` });
    } else if (x.scoperto >= 0.5) {
      avvisi.push({ tipo: 'scoperto', gravita: 'media', projectId: x.projectId, testo: `${nomeP(x)} · ${x.ruolo}: allocate ${fmtG(x.coperto)} giornate su ${fmtG(x.daPianificare)} da fare (ne mancano ${fmtG(x.scoperto)})` });
    }
    if (x.eccesso >= 1 && x.daPianificare > 0) {
      avvisi.push({ tipo: 'eccesso', gravita: 'bassa', projectId: x.projectId, testo: `${nomeP(x)} · ${x.ruolo}: allocate ${fmtG(x.coperto)} giornate, più delle ${fmtG(x.daPianificare)} da fare` });
    }
  }
  // Fine dell'allocazione per persona e progetto: l'ultima dei suoi periodi (il piano dal Gantt
  // ne crea più d'uno, uno dopo l'altro: conta solo dove finisce l'ultimo).
  const ultime = new Map();
  for (const a of attive) {
    const k = `${a.project_id}|${a.risorsa_id}`;
    if (!ultime.has(k) || a.al > ultime.get(k).al) ultime.set(k, a);
  }
  for (const a of ultime.values()) {
    const dp = datiProgetto.get(a.project_id);
    const r = perRis.get(a.risorsa_id);
    if (!dp || !dp.fine || !r) continue;
    if (a.al < dp.fine && dp.fine > oggi) {
      avvisi.push({ tipo: 'finePrima', gravita: 'media', projectId: a.project_id, testo: `${r.nominativo} su ${nomeP(dp)}: allocazione fino al ${dataItaliana(a.al)}, progetto fino al ${dataItaliana(dp.fine)}` });
    }
    if (a.al > dp.fine) {
      avvisi.push({ tipo: 'fineDopo', gravita: 'bassa', projectId: a.project_id, testo: `${r.nominativo} su ${nomeP(dp)}: allocazione oltre la fine del progetto (${dataItaliana(a.al)} invece di ${dataItaliana(dp.fine)})` });
    }
  }
  // Stessa persona su più tuoi progetti negli stessi giorni (informativo).
  const perPersona = new Map();
  for (const a of attive) { if (!perPersona.has(a.risorsa_id)) perPersona.set(a.risorsa_id, []); perPersona.get(a.risorsa_id).push(a); }
  for (const [rid, l] of perPersona) {
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      if (l[i].project_id === l[j].project_id) continue;
      const da = [l[i].dal, l[j].dal, oggi].sort().pop();
      const al = [l[i].al, l[j].al].sort()[0];
      if (da > al) continue;
      const r = perRis.get(rid);
      avvisi.push({ tipo: 'sovrapposte', gravita: 'bassa', projectId: l[i].project_id,
        testo: `${r ? r.nominativo : 'Persona'} è su due tuoi progetti dal ${dataItaliana(da)} al ${dataItaliana(al)}: ${l[i].progetto} (${l[i].perc}%) e ${l[j].progetto} (${l[j].perc}%), in tutto ${l[i].perc + l[j].perc}%` });
    }
  }
  const ordine = { alta: 0, media: 1, bassa: 2 };
  avvisi.sort((a, b) => ordine[a.gravita] - ordine[b.gravita]);
  const tot = (k) => elenco.reduce((s, p) => s + p[k], 0);
  // Giorni lavorativi di ogni mese da oggi (festività escluse), per spiegare i numeri nel tooltip.
  const giorniMese = Object.fromEntries(mm.map((m) => {
    const fineM = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
    const da = `${m}-01` > oggi ? `${m}-01` : oggi;
    return [m, giorniLavorativi(da, fineM).length];
  }));
  return { oggi, mesi: mm, giorniMese, progetti: elenco, avvisi, totali: { daPianificare: tot('daPianificare'), coperto: tot('coperto'), scoperto: tot('scoperto') } };
}

// ----------------------------------------------------------------------------
// TEAM DEL PROGETTO (scheda «Risorse» del Cruscotto): le persone del team (proj_componenti) con
// il ruolo nel progetto, il consuntivo, le allocazioni e, per chi non è allocato, la proposta
// (periodo da oggi alla fine del progetto; % = giornate da fare del ruolo divise tra le persone
// del team con quel ruolo, sulle ore settimanali della persona). fab = fabbisogno del progetto.
// ----------------------------------------------------------------------------
export async function teamProgetto(user, projectId, fab) {
  const { normNome } = await import('./azioniCliente.js');
  const oggi = oggiIso();
  const [team, ris, all, ore] = await Promise.all([teamConRuolo(user, [projectId]), risorse(user, { tutte: true }), allocazioni(user, { projectId }), oreSettimanali(user)]);
  const perEmail = new Map(ris.filter((r) => r.email).map((r) => [String(r.email).trim().toLowerCase(), r]));
  const perNome = new Map(ris.map((r) => [normNome(r.nominativo), r]));
  // Dati del progetto dal fabbisogno: fine, inizio e giornate da fare per ruolo.
  let inizio = null, fine = null, motivo = null;
  const residuo = new Map();
  for (const r of fab.ruoli) for (const p of r.progetti) if (p.projectId === projectId) {
    inizio = p.inizio || inizio; fine = p.fine || fine; motivo = p.motivo || motivo;
    residuo.set(r.chiave, (residuo.get(r.chiave) || 0) + p.daPianificare);
  }
  // Una riga per persona (email), con il ruolo del team e il consuntivo sommato.
  const persone = new Map();
  for (const t of team) {
    const email = String(t.email || '').trim().toLowerCase();
    const k = email || normNome(t.nominativo);
    if (!k) continue;
    const r = (email && perEmail.get(email)) || perNome.get(normNome(t.nominativo)) || null;
    const x = persone.get(k) || { email, nominativo: (r && r.nominativo) || String(t.nominativo || email).trim(), ruolo: t.ruolo || (r && r.ruolo) || '', risorsaId: r ? r.id : null, consuntivo: 0, nelPiano: false, righe: [] };
    x.consuntivo += (Number(t.time_spent_hh) || 0) / ORE_GIORNATA;
    x.nelPiano = x.nelPiano || t.nel_piano !== false;
    x.righe.push(t.id);
    persone.set(k, x);
  }
  const lista = [...persone.values()];
  const perRuolo = new Map();
  lista.filter((x) => x.nelPiano).forEach((x) => { const k = normVoce(x.ruolo); perRuolo.set(k, (perRuolo.get(k) || 0) + 1); });
  const dal = inizio && inizio > oggi ? inizio : oggi;
  const giorni = fine && !motivo ? giorniLavorativi(dal, fine).length : 0;
  for (const x of lista) {
    x.allocazioni = x.risorsaId ? all.filter((a) => a.risorsa_id === x.risorsaId && a.al >= oggi).map((a) => ({ id: a.id, perc: a.perc, dal: a.dal, al: a.al })) : [];
    const res = residuo.get(normVoce(x.ruolo)) || 0;
    const oreSett = x.risorsaId ? ore.ore(perEmail.get(x.email) || ris.find((r) => r.id === x.risorsaId)) : (ore.perEmail.get(x.email) || ORE_SETT_DEFAULT);
    const giornate = res / (perRuolo.get(normVoce(x.ruolo)) || 1);
    const disponibili = giorni * (oreSett / 5 / ORE_GIORNATA);
    x.proposta = x.nelPiano && giorni && giornate > 0
      ? { dal, al: fine, giornate: Math.round(giornate * 10) / 10, perc: disponibili > 0 ? Math.min(100, Math.max(5, Math.round(((giornate / disponibili) * 100) / 5) * 5)) : 100 }
      : null;
    x.motivoNoProposta = !x.nelPiano ? 'fuori dal piano' : !giorni ? (motivo || 'progetto senza data di fine') : (giornate <= 0 ? 'nessuna giornata da fare per il suo ruolo' : null);
  }
  lista.sort((a, b) => a.ruolo.localeCompare(b.ruolo, 'it') || a.nominativo.localeCompare(b.nominativo, 'it'));
  return { fine, motivo, persone: lista };
}

// ----------------------------------------------------------------------------
// PIANO AUTOMATICO DEL PROGETTO (Cruscotto PM › Risorse, 2026-10-16)
// ----------------------------------------------------------------------------
// Dati per il piano: per ogni ruolo (voce di costo) le giornate che restano = Stima −
// Consuntivo dei Costi Progetto, i giorni lavorativi da oggi alla consegna (campo End o
// fine Gantt, oppure la data scelta nel Cruscotto) e le persone del team con quel ruolo:
// ore settimanali (Rubrica), giornate già fatte qui, allocazione di oggi su questo progetto
// e giornate a settimana già impegnate altrove (altri progetti del PM + altri PM del tenant,
// stessa email) nel periodo fino alla consegna. La divisione tra le persone e le percentuali
// le calcola la pagina (si possono togliere persone e cambiare la data senza salvare).
export async function pianoProgetto(user, projectId, { consegna = null } = {}) {
  const oggi = oggiIso();
  const fab = await fabbisogno(user, { mesi: 12, projectId });
  const [team, tutteAll, altriPm, ore] = await Promise.all([
    teamProgetto(user, projectId, fab), allocazioni(user), allocazioniAltriPm(user), oreSettimanali(user)
  ]);
  const fineProgetto = team.fine || null;
  const fine = consegna && consegna >= oggi ? consegna : fineProgetto;
  const giorni = fine && fine >= oggi ? giorniLavorativi(oggi, fine) : [];
  const nG = giorni.length;
  // Settimane (lunedì) con i giorni lavorativi di ognuna, per la striscia settimana per settimana.
  const settimane = new Map();
  for (const d of giorni) {
    const t = Date.parse(`${d}T12:00:00Z`);
    const lun = new Date(t - (((new Date(t).getUTCDay() + 6) % 7) * 86400000)).toISOString().slice(0, 10);
    settimane.set(lun, (settimane.get(lun) || 0) + 1);
  }
  // Giornate di un'allocazione dentro [oggi, fine]: giorni lavorativi × % × ore/sett ÷ 5 ÷ 8.
  const giornate = (a, oreSett) => {
    if (!nG) return 0;
    const dal = a.dal > oggi ? a.dal : oggi;
    const al = a.al < fine ? a.al : fine;
    if (al < dal) return 0;
    return giorniLavorativi(dal, al).length * (Number(a.perc) / 100) * (oreSett / 5 / ORE_GIORNATA);
  };
  // Con il Gantt a fasi (analisi/configurazione/formazione/programmazione) e i Costi Progetto
  // ripartiti per fase il piano segue le attività del Gantt (pianoDaGantt); altrimenti è uniforme.
  const daGantt = await pianoDaGantt(user, projectId, { oggi, fine, fineProgetto, motivo: team.motivo || null, team, tutteAll, altriPm, ore, giornate });
  if (daGantt) return daGantt;
  const ruoli = new Map();
  for (const r of fab.ruoli) for (const p of r.progetti) if (p.projectId === projectId) {
    const x = ruoli.get(r.chiave) || { ruolo: r.ruolo, chiave: r.chiave, stima: 0, consuntivo: 0, persone: [] };
    x.stima += p.stima || 0; x.consuntivo += p.consuntivo || 0;
    ruoli.set(r.chiave, x);
  }
  for (const x of team.persone) {
    const k = normVoce(x.ruolo || '');
    const r = ruoli.get(k);
    if (!r) continue; // ruolo senza voce nei Costi Progetto: niente da pianificare
    const email = String(x.email || '').trim().toLowerCase();
    const oreSett = (email && ore.perEmail.get(email)) || ORE_SETT_DEFAULT;
    const mie = x.risorsaId ? tutteAll.filter((a) => a.risorsa_id === x.risorsaId) : [];
    const qui = mie.filter((a) => a.project_id === projectId && a.al >= oggi);
    const corrente = qui.find((a) => a.dal <= oggi) || qui[0] || null;
    const altrove = [
      ...mie.filter((a) => a.project_id !== projectId).map((a) => ({ gg: giornate(a, oreSett), nome: [a.cliente, a.progetto].filter(Boolean).join(' · ') })),
      ...(email ? altriPm.filter((a) => a.email === email).map((a) => ({ gg: giornate(a, oreSett), nome: `${[a.cliente, a.progetto].filter(Boolean).join(' · ')} (${a.pm})` })) : [])
    ].filter((a) => a.gg > 0.001);
    const ggAltrove = altrove.reduce((t, a) => t + a.gg, 0);
    r.persone.push({
      nominativo: x.nominativo, email: x.email || null, ruolo: x.ruolo, risorsaId: x.risorsaId, oreSett, nelPiano: x.nelPiano,
      fatte: Math.round(x.consuntivo * 100) / 100,
      oggiPerc: corrente ? corrente.perc : 0, allocazioni: qui.map((a) => ({ id: a.id, perc: a.perc, dal: a.dal, al: a.al })),
      altriGgSett: nG ? Math.round((ggAltrove / nG) * 5 * 100) / 100 : 0,
      altriDett: [...new Set(altrove.map((a) => a.nome))].join(', ')
    });
  }
  const lista = [...ruoli.values()].map((r) => ({ ...r, stima: Math.round(r.stima * 100) / 100, consuntivo: Math.round(r.consuntivo * 100) / 100, resto: Math.max(0, Math.round((r.stima - r.consuntivo) * 100) / 100) }))
    .filter((r) => r.resto > 0.05 || r.persone.some((p) => p.oggiPerc > 0))
    .sort((a, b) => b.resto - a.resto);
  return {
    oggi, consegna: fine, consegnaProgetto: fineProgetto, motivo: team.motivo || null,
    giorni: nG, settimane: [...settimane.entries()].map(([lun, n]) => ({ lun, giorni: n })), ruoli: lista
  };
}

// ----------------------------------------------------------------------------
// PIANO DAL GANTT (Cruscotto PM › Risorse, 2026-10-16)
// ----------------------------------------------------------------------------
// Incrocia le attività del Gantt (licenza/modulo → fasi con date, avanzamento e Nominativo),
// la ripartizione per fase dei Costi Progetto (Analisi, Configurazione, Formazione,
// Programmazione per ruolo: le stesse della griglia Licenze da Attivare) e stima/consuntivo.
// Scelte dell'utente:
//   - per ogni fase: stima = effort della fase × quota del ruolo (Costi Progetto); ore lavorate =
//     Effettivo del Gantt se scritto, altrimenti stima × avanzamento %; da fare = stima − lavorate
//     (le ore lavorate sono il dato giusto, scelta dell'utente; il consuntivo Qlik dei Costi
//     Progetto resta solo come confronto);
//   - chi le fa = Nominativo dell'attività (Owner Interno, anche più persone); se vuoto, le
//     persone del team con quel ruolo («Nel piano» acceso). Divise in base alle ore settimanali;
//   - fasi senza data di fine: da oggi alla consegna, con avviso; fasi scadute e non finite:
//     nei prossimi 5 giorni lavorativi, con avviso;
//   - ruoli senza ripartizione per fase (es. Project Manager) esclusi dal piano.
// null = il progetto non ha i dati per questo piano (si usa quello uniforme).
async function pianoDaGantt(user, projectId, { oggi, fine, fineProgetto, motivo, team, tutteAll, altriPm, ore, giornate }) {
  if (!(await tabellaPresente('conf_worker_cost'))) return null;
  const [eco, righe] = await Promise.all([effortPerRuolo(user, projectId), righeGantt(user, projectId)]);
  const gg = (v) => (eco.aOre ? (Number(v) || 0) / ORE_GIORNATA : (Number(v) || 0));
  const tondo = (v) => Math.round(v * 100) / 100;
  // Ruoli che fanno ogni fase, con la loro quota (Costi Progetto).
  const ruoli = new Map(); // chiave -> { ruolo, stima, consuntivo, fasi, resto, peso }
  const esclusi = [];
  for (const v of eco.voci) {
    const k = normVoce(v.voce);
    const stima = gg(v.offerta), consuntivo = gg(v.speso);
    if (!FASI.some((f) => v.fasi[f] > 0)) {
      if (stima - consuntivo > 0.05) esclusi.push({ ruolo: v.voce, resto: tondo(stima - consuntivo) });
      continue;
    }
    const r = ruoli.get(k) || { ruolo: v.voce, chiave: k, stima: 0, consuntivo: 0, fasi: Object.fromEntries(FASI.map((f) => [f, 0])), peso: 0 };
    r.stima += stima; r.consuntivo += consuntivo;
    FASI.forEach((f) => { r.fasi[f] += v.fasi[f]; });
    ruoli.set(k, r);
  }
  // Ruoli chiusi: ore vendute già tutte consuntivate in Qlik (es. Delivery Automation 2 h su 2):
  // fuori dal piano, e la loro quota delle fasi torna agli altri ruoli.
  const chiusi = [];
  for (const [k, r] of ruoli) {
    if (r.stima > 0 && r.consuntivo >= r.stima - 0.001) { chiusi.push({ ruolo: r.ruolo, stima: tondo(r.stima), consuntivo: tondo(r.consuntivo) }); ruoli.delete(k); }
  }
  const ruoliFase = new Map();
  for (const r of ruoli.values()) r.resto = Math.max(0, r.stima - r.consuntivo);
  for (const f of FASI) {
    const l = [...ruoli.values()].filter((r) => r.fasi[f] > 0);
    const tot = l.reduce((s, r) => s + r.fasi[f], 0);
    ruoliFase.set(f, l.map((r) => ({ r, quota: r.fasi[f] / tot })));
  }
  // Attività foglia del Gantt con effort per fase.
  const haFigli = new Set();
  for (const x of righe) { const p = x.chiave.split('.'); if (p.length > 1) haFigli.add(p.slice(0, -1).join('.')); }
  const perChiave = new Map(righe.map((x) => [x.chiave, x]));
  const foglie = righe.filter((x) => !haFigli.has(x.chiave) && FASI.some((f) => x.fasi[f] > 0));
  if (!ruoli.size || !foglie.length) return null;

  const { normNome } = await import('./azioniCliente.js');
  const persTeam = team.persone;
  const perNome = new Map(persTeam.map((p) => [normNome(p.nominativo), p]));
  const oreDi = (p) => (p.email && ore.perEmail.get(String(p.email).trim().toLowerCase())) || ORE_SETT_DEFAULT;
  const prossimi = giorniLavorativi(oggi, piu(oggi, 14)).slice(0, 5);
  const fineRitardo = prossimi[prossimi.length - 1] || oggi;

  // Pesi per ruolo: effort della fase × quota del ruolo × parte non ancora fatta.
  const quote = [];
  for (const x of foglie) {
    const modulo = x.livello > 1 ? (perChiave.get(x.chiave.split('.')[0])?.nome || '') : '';
    for (const f of FASI) {
      if (!(x.fasi[f] > 0)) continue;
      const aperto = 1 - x.avanzamento / 100;
      const chi = ruoliFase.get(f);
      // Consuntivo della fase: Effettivo del Gantt (diviso tra fasi e ruoli in proporzione alla
      // stima) se compilato, altrimenti si ripartisce dopo il consuntivo del ruolo (vedi sotto).
      const stimaFoglia = FASI.reduce((t, k) => t + gg(x.fasi[k]), 0);
      const eff = (s) => (x.effettivo != null && stimaFoglia > 0 ? gg(x.effettivo) * (s / stimaFoglia) : null);
      if (!chi.length) { quote.push({ x, modulo, fase: f, r: null, peso: 0, stimaFase: gg(x.fasi[f]), eff: eff(gg(x.fasi[f])), fatto: 0 }); continue; }
      for (const { r, quota } of chi) {
        const peso = gg(x.fasi[f]) * quota * aperto;
        const stimaFase = gg(x.fasi[f]) * quota;
        const q = { x, modulo, fase: f, r, peso, stimaFase, eff: eff(stimaFase), fatto: stimaFase * (x.avanzamento / 100) };
        r.peso += peso;
        if (q.eff != null) r.effTot = (r.effTot || 0) + q.eff; else r.fattoPeso = (r.fattoPeso || 0) + q.fatto;
        quote.push(q);
      }
    }
  }

  const persone = new Map(); // «ruolo|persona» -> riga del piano
  const fasi = [];
  const avvisi = { senzaDate: [], inRitardo: [], fuoriTeam: new Set(), senzaRuolo: [], senzaPersone: [] };
  for (const q of quote) {
    const nome = `${q.modulo ? `${q.modulo} › ` : ''}${q.x.nome}`;
    if (!q.r) { avvisi.senzaRuolo.push(`${nome} (${q.fase})`); continue; }
    // Ore lavorate della fase (scelta dell'utente: è il dato giusto): Effettivo del Gantt se
    // scritto, altrimenti stima della fase × avanzamento % dell'attività (figlio) nel Gantt.
    // Da fare = stima − lavorate (mai sotto zero).
    const cons = q.eff != null ? q.eff : q.fatto;
    const da = Math.max(0, q.stimaFase - cons);
    q.r.lavorate = (q.r.lavorate || 0) + cons;
    q.r.stimaGantt = (q.r.stimaGantt || 0) + q.stimaFase;
    q.r.daFare = (q.r.daFare || 0) + da;
    // Periodo: date dell'attività da oggi in poi; senza fine = fino alla consegna; scaduta = prossimi 5 giorni.
    let dal = q.x.inizio, al = q.x.fine, avviso = null;
    if (!al) { dal = oggi; al = fine && fine >= oggi ? fine : null; avviso = 'senzaDate'; }
    else if (al < oggi) { if (da > 0.001) { dal = oggi; al = fineRitardo; avviso = 'inRitardo'; } }
    else if (!dal || dal < oggi) dal = oggi;
    // Chi: Nominativo dell'attività (Owner Interno), altrimenti il team con quel ruolo.
    let chi = [], fonte = 'team';
    if (q.x.nominativo && (q.x.ownerTipo === 'interno' || !q.x.ownerTipo)) {
      chi = q.x.nominativo.split(',').map((s) => s.trim()).filter(Boolean).map((n) => {
        const t = perNome.get(normNome(n));
        if (!t) avvisi.fuoriTeam.add(n);
        return t || { nominativo: n, email: null, ruolo: q.r.ruolo, risorsaId: null, nelPiano: true, consuntivo: 0, fuoriTeam: true };
      })
        // Solo chi nel team ha QUESTO ruolo (o non ha ruolo): la quota di un altro ruolo della
        // stessa fase va al team di quel ruolo, non alle persone del Nominativo.
        .filter((p) => p.nelPiano !== false && (!p.ruolo || normVoce(p.ruolo) === q.r.chiave));
      if (chi.length) fonte = 'gantt';
    }
    if (!chi.length) chi = persTeam.filter((p) => p.nelPiano !== false && normVoce(p.ruolo || '') === q.r.chiave);
    fasi.push({
      id: q.x.id, modulo: q.modulo, attivita: q.x.nome, fase: q.fase, ruolo: q.r.ruolo, avanzamento: q.x.avanzamento,
      inizio: q.x.inizio, fine: q.x.fine, dal: al ? dal : null, al, avviso,
      stima: tondo(q.stimaFase), daFare: tondo(da), consuntivo: tondo(cons), consFonte: q.eff != null ? 'effettivo' : 'avanzamento', persone: chi.map((p) => p.nominativo), fonte
    });
    if (da <= 0.001) continue;
    if (avviso === 'senzaDate') avvisi.senzaDate.push(nome);
    if (avviso === 'inRitardo') avvisi.inRitardo.push(nome);
    if (!chi.length) { avvisi.senzaPersone.push(`${nome} (${q.r.ruolo})`); continue; }
    const giorni = al && al >= dal ? giorniLavorativi(dal, al) : [];
    if (!giorni.length) continue;
    const capTot = chi.reduce((s, p) => s + oreDi(p), 0);
    for (const p of chi) {
      const k = `${q.r.chiave}|${p.email || normNome(p.nominativo)}`;
      const riga = persone.get(k) || {
        chiaveRuolo: q.r.chiave, nominativo: p.nominativo, email: p.email || null, risorsaId: p.risorsaId || null,
        oreSett: oreDi(p), fuoriTeam: !!p.fuoriTeam, fatte: tondo(p.consuntivo || 0), perGiorno: new Map(), attivita: new Set(), lavori: new Map()
      };
      const alGiorno = (da * oreDi(p)) / capTot / giorni.length;
      for (const d of giorni) riga.perGiorno.set(d, (riga.perGiorno.get(d) || 0) + alGiorno);
      riga.attivita.add(nome);
      // Fasi della persona per la timeline: periodo usato dal piano e giornate a suo carico.
      const lav = riga.lavori.get(nome) || { nome, modulo: q.modulo, attivita: q.x.nome, fase: q.fase, dal, al, avviso, gg: 0 };
      lav.gg += (da * oreDi(p)) / capTot;
      riga.lavori.set(nome, lav);
      persone.set(k, riga);
    }
  }

  // Settimane da oggi all'ultima giornata pianificata (almeno fino alla consegna).
  let ultimo = fine && fine >= oggi ? fine : oggi;
  for (const r of persone.values()) for (const d of r.perGiorno.keys()) if (d > ultimo) ultimo = d;
  const lunDi = (d) => { const t = giornoUtc(d); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return iso(t); };
  const settimane = new Map();
  for (const d of giorniLavorativi(oggi, ultimo)) settimane.set(lunDi(d), (settimane.get(lunDi(d)) || 0) + 1);
  const giorniFino = fine && fine >= oggi ? giorniLavorativi(oggi, fine).length : 0;

  const lista = [...ruoli.values()].map((r) => {
    const pers = [...persone.values()].filter((p) => p.chiaveRuolo === r.chiave).map((p) => {
      const perSett = {};
      for (const [d, v] of p.perGiorno) perSett[lunDi(d)] = (perSett[lunDi(d)] || 0) + v;
      const email = String(p.email || '').trim().toLowerCase();
      const mie = p.risorsaId ? tutteAll.filter((a) => a.risorsa_id === p.risorsaId) : [];
      const qui = mie.filter((a) => a.project_id === projectId && a.al >= oggi);
      const corrente = qui.find((a) => a.dal <= oggi) || qui[0] || null;
      const altrove = [
        ...mie.filter((a) => a.project_id !== projectId).map((a) => ({ gg: giornate(a, p.oreSett), nome: [a.cliente, a.progetto].filter(Boolean).join(' · ') })),
        ...(email ? altriPm.filter((a) => a.email === email).map((a) => ({ gg: giornate(a, p.oreSett), nome: `${[a.cliente, a.progetto].filter(Boolean).join(' · ')} (${a.pm})` })) : [])
      ].filter((a) => a.gg > 0.001);
      return {
        nominativo: p.nominativo, email: p.email, ruolo: r.ruolo, risorsaId: p.risorsaId, oreSett: p.oreSett, fuoriTeam: p.fuoriTeam, fatte: p.fatte,
        totale: tondo([...p.perGiorno.values()].reduce((a, b) => a + b, 0)),
        perSett: Object.fromEntries(Object.entries(perSett).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
        attivita: [...p.attivita],
        lavori: [...p.lavori.values()].map((l) => ({ ...l, gg: tondo(l.gg) })).sort((a, b) => a.dal.localeCompare(b.dal) || b.gg - a.gg),
        oggiPerc: corrente ? corrente.perc : 0, allocazioni: qui.map((a) => ({ id: a.id, perc: a.perc, dal: a.dal, al: a.al, note: a.note || '' })),
        altriGgSett: giorniFino ? tondo((altrove.reduce((t, a) => t + a.gg, 0) / giorniFino) * 5) : 0,
        altriDett: [...new Set(altrove.map((a) => a.nome))].join(', ')
      };
    }).sort((a, b) => b.totale - a.totale || a.nominativo.localeCompare(b.nominativo, 'it'));
    return {
      // Dal Gantt: stima delle fasi, ore lavorate (Effettivo o stima × avanzamento), da fare = stima − lavorate.
      ruolo: r.ruolo, chiave: r.chiave, stima: tondo(r.stimaGantt || 0), lavorate: tondo(r.lavorate || 0), resto: tondo(r.daFare || 0),
      // Dai Costi Progetto (Qlik), solo per confronto: stima venduta e ore consuntivate.
      stimaCosti: tondo(r.stima), consuntivo: tondo(r.consuntivo),
      distribuito: tondo(pers.reduce((s, p) => s + p.totale, 0)),
      persone: pers
    };
  }).filter((r) => r.resto > 0.05 || r.persone.length).sort((a, b) => b.resto - a.resto);

  return {
    modo: 'gantt', oggi, consegna: fine, consegnaProgetto: fineProgetto, motivo, aOre: eco.aOre,
    giorni: [...settimane.values()].reduce((a, b) => a + b, 0),
    settimane: [...settimane.entries()].map(([lun, n]) => ({ lun, giorni: n })),
    ruoli: lista, fasi, esclusi, chiusi, consegneLicenze: consegneLicenze(righe),
    avvisi: { ...avvisi, fuoriTeam: [...avvisi.fuoriTeam] }
  };
}

// Data di consegna di ogni licenza (argomento di primo livello del Gantt): la data della sua
// attività «Go-live» se c'è, altrimenti l'ultima data di fine delle sue attività.
function consegneLicenze(righe) {
  const out = {};
  for (const top of righe.filter((x) => x.livello === 1)) {
    const figli = righe.filter((x) => x.chiave.startsWith(`${top.chiave}.`));
    const golive = figli.find((x) => /go[\s-]*live/i.test(x.nome) && (x.fine || x.inizio));
    const fini = [top.fine, ...figli.map((x) => x.fine)].filter(Boolean).sort();
    const data = golive ? (golive.fine || golive.inizio) : (fini[fini.length - 1] || null);
    if (data) out[top.nome] = { data, golive: !!golive };
  }
  return out;
}
