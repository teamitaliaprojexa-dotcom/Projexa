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
  tabellaPresente, oggiIso, progettiAperti, schedaProgetto, economiaProgetto, righeGantt, analisiGantt
} from './pmCore.js';
import { normVoce } from './pmEconomia.js';

export const CAMPO = 'capacità e allocazione risorse';
export const TABELLE = ['pm_risorse', 'pm_risorse_assenza', 'pm_allocazioni'];
const ORE_GIORNATA = 8;

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
            r.nominativo, r.ruolo, r.ore_giorno, pr.valore2 AS progetto, c.valore2 AS cliente
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
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END) AS speso
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
  return { aOre: r.rows.some((x) => x.hh), voci: r.rows.map((x) => ({ voce: x.voce, offerta: Number(x.offerta) || 0, speso: Number(x.speso) || 0 })) };
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

// Per ogni risorsa e giorno lavorativo del periodo: capacità (giornate) e allocato (giornate),
// sommati per mese (ruoli) e per settimana (persone).
export async function capacitaECarico(user, { mesi = 6, settimane = 12 } = {}) {
  const oggi = oggiIso();
  const [ris, ass, all] = await Promise.all([risorse(user), assenze(user), allocazioni(user)]);
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
    const fattore = (r.ore_giorno || ORE_GIORNATA) / ORE_GIORNATA; // giornate per giorno lavorato
    const assenti = giorniAssenza(ass.filter((a) => a.risorsa_id === r.id));
    const mie = all.filter((a) => a.risorsa_id === r.id);
    const sett = Object.fromEntries(ss.map((s) => [s, { capacita: 0, allocato: 0, assenze: 0, progetti: {} }]));
    const k = normVoce(r.ruolo || 'Senza ruolo');
    if (!perRuolo.has(k)) perRuolo.set(k, { chiave: k, ruolo: r.ruolo || 'Senza ruolo', capacita: Object.fromEntries(mm.map((m) => [m, 0])), allocato: Object.fromEntries(mm.map((m) => [m, 0])), persone: 0 });
    const pr = perRuolo.get(k);
    pr.persone += 1;
    for (const d of giorni) {
      const assente = assenti.has(d);
      const cap = assente ? 0 : (r.perc_progetti / 100) * fattore;
      let allD = 0;
      const perProg = {};
      if (!assente) for (const a of mie) if (d >= a.dal && d <= a.al) { const x = (a.perc / 100) * fattore; allD += x; perProg[a.project_id] = (perProg[a.project_id] || 0) + x; }
      const m = d.slice(0, 7);
      if (d >= oggi && pr.capacita[m] != null) { pr.capacita[m] += cap; pr.allocato[m] += allD; }
      const w = lunedi(d);
      if (sett[w]) {
        sett[w].capacita += cap; sett[w].allocato += allD; if (assente) sett[w].assenze += 1;
        for (const [pid, x] of Object.entries(perProg)) sett[w].progetti[pid] = (sett[w].progetti[pid] || 0) + x;
      }
    }
    persone.push({
      id: r.id, nominativo: r.nominativo, ruolo: r.ruolo, perc_progetti: r.perc_progetti, ore_giorno: r.ore_giorno,
      settimane: ss.map((s) => {
        const x = sett[s];
        const carico = x.capacita > 0 ? (x.allocato / x.capacita) * 100 : (x.allocato > 0 ? null : 0);
        return { dal: s, capacita: x.capacita, allocato: x.allocato, assenze: x.assenze, carico, sovra: x.allocato > x.capacita + 0.001, progetti: x.progetti };
      })
    });
  }
  const nomiProgetti = Object.fromEntries(all.map((a) => [a.project_id, `${a.cliente ? `${a.cliente} · ` : ''}${a.progetto || 'Progetto'}`]));
  return { oggi, mesi: mm, settimane: ss, ruoli: [...perRuolo.values()], persone, nomiProgetti };
}

// Persone sovrallocate nelle prossime N settimane (avvisi in campanella).
export async function sovrallocazioni(user, settimane = 4) {
  const c = await capacitaECarico(user, { mesi: 1, settimane });
  const out = [];
  for (const p of c.persone) for (const s of p.settimane) if (s.sovra && s.allocato > 0) out.push({ risorsaId: p.id, nominativo: p.nominativo, settimana: s.dal, carico: s.carico, allocato: s.allocato, capacita: s.capacita });
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
  return (await db.query(
    `SELECT c.project_id::text AS project_id, c.nominativo, c.email, c.time_spent_hh, ${ruolo} AS ruolo
       FROM proj_componenti c
       LEFT JOIN proj_worker_cost w ON w.id = c.team_pro
      WHERE c.tenant_id = $1 AND c.user_id = $2 AND (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE)
        ${projectIds ? 'AND c.project_id::text = ANY($3::text[])' : ''}`, p)).rows;
}

// ----------------------------------------------------------------------------
// PROPOSTE DI ALLOCAZIONE DAI TEAM DEI PROGETTI (pulsante «Dai team dei progetti»)
// ----------------------------------------------------------------------------
// Per ogni progetto aperto con effort ancora da fare: le persone del team (proj_componenti,
// Kick-off) già presenti tra le Risorse (stessa email o stesso nome e cognome). Periodo = da oggi
// (o dall'inizio se futuro) alla fine del progetto; percentuale = giornate ancora da fare per il
// ruolo della persona, divise tra le persone del team con quel ruolo, rapportate ai giorni
// disponibili (giorni lavorativi × quota sui progetti × ore/8), arrotondata a 5 (5-100%).
// Saltate: persone già allocate sul progetto, progetti senza fine valida, ruolo senza effort.
export async function proposteAllocazioni(user) {
  const { normNome } = await import('./azioniCliente.js');
  const oggi = oggiIso();
  const [fab, ris, all] = await Promise.all([fabbisogno(user, { mesi: 12 }), risorse(user), allocazioni(user)]);
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
  if (!progetti.size || !ris.length) return { proposte, saltate };
  const team = await teamConRuolo(user, [...progetti.keys()]);
  for (const [pid, { p, ruoli }] of progetti) {
    // Persone del team riconosciute tra le Risorse (una volta sola per progetto), con il ruolo
    // che hanno IN QUESTO progetto (voce del team); senza voce nel team, quello della risorsa.
    const persone = new Map();
    for (const t of team.filter((x) => x.project_id === pid)) {
      const r = perEmail.get(String(t.email || '').trim().toLowerCase()) || perNome.get(normNome(t.nominativo));
      if (r) persone.set(r.id, { ...r, ruolo: t.ruolo || r.ruolo });
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
        if (giaAllocate.has(`${r.id}|${pid}`)) { saltate.giaAllocate += 1; continue; }
        if (!eff || eff.residuo <= 0) { saltate.ruoloSenzaEffort += 1; continue; }
        const giornate = eff.residuo / lista.length;
        const disponibili = giorni * (r.perc_progetti / 100) * ((r.ore_giorno || ORE_GIORNATA) / ORE_GIORNATA);
        const perc = disponibili > 0 ? Math.min(100, Math.max(5, Math.round(((giornate / disponibili) * 100) / 5) * 5)) : 100;
        proposte.push({
          risorsa_id: r.id, nominativo: r.nominativo, ruolo: eff.ruolo, projectId: pid, progetto: p.nome, cliente: p.cliente,
          dal, al: fine, perc, giornate: Math.round(giornate * 10) / 10, colleghi: lista.length
        });
      }
    }
  }
  proposte.sort((a, b) => String(a.cliente).localeCompare(String(b.cliente), 'it') || String(a.progetto).localeCompare(String(b.progetto), 'it') || a.nominativo.localeCompare(b.nominativo, 'it'));
  return { proposte, saltate };
}
