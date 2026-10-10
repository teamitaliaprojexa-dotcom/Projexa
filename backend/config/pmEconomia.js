// ============================================================================
// ECONOMIA DEL PROGETTO IN DENARO (Earned Value in euro + margine) - 2026-10-10
// ----------------------------------------------------------------------------
// Usato dal Cruscotto PM › scheda «Economia» (routes/pm.js, /api/pm/economia), dal contesto
// per l'AI (contestoProgetto) e dalla fotografia giornaliera (jobs/pmJobs.js).
// Tabelle: Supporto/CreaDB/pm_economia.sql. Se non ci sono ancora, si calcola lo stesso
// tutto quello che viene dai Costi Progetto (senza costi interni/esterni né valuta).
//
// Da dove vengono i numeri:
//   - Costi Progetto (proj_worker): per ogni voce l'effort offerto, le ore/giornate spese e la
//     tariffa. Il database calcola già il VALORE in euro: offerta_hh/gg = effort × tariffa,
//     cost_time_spent_hh/gg = speso × tariffa (scontata se c'è). Le tariffe sono il PREZZO
//     al cliente: per questo il margine ha bisogno del costo interno per voce (pm_costo_interno).
//   - Change Request approvate: aggiungono importo al budget e al ricavo.
//   - Gantt (baseline se c'è, altrimenti le date attuali): quanto lavoro era previsto a oggi.
//   - Completamento del progetto (scheda, o calcolato dal Gantt): quanto lavoro è fatto.
//
// Earned Value (valori in euro):
//   BAC budget             = valore offerto delle voci + importo delle CR approvate
//   PV  valore pianificato = BAC × % di lavoro previsto a oggi dal piano
//   EV  valore guadagnato  = BAC × % di completamento
//   AC  valore consumato   = ore/giornate spese × tariffa
//   CPI = EV / AC  (sotto 1: si consuma più di quanto si produce)
//   SPI = EV / PV  (sotto 1: si è indietro rispetto al piano)
//   EAC stima a finire = BAC / CPI;  ETC = EAC - AC;  VAC = BAC - EAC
//   TCPI = (BAC - EV) / (BAC - AC): efficienza necessaria da qui in avanti per stare nel budget
// ============================================================================
import db from './database.js';
import {
  errore, oggiIso, dataIt, fmt, euro, tabellaPresente, colonneTabella, giorniTra,
  progettoUtente, schedaProgetto, righeGantt, analisiGantt, crProgetto
} from './pmCore.js';

// Valute più usate nei contratti (codice ISO 4217).
export const VALUTE = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY',
  'AED', 'SAR', 'QAR', 'ILS', 'INR', 'CNY', 'JPY', 'SGD', 'HKD', 'AUD', 'NZD', 'CAD', 'MXN', 'BRL', 'ARS', 'CLP', 'ZAR', 'EGP', 'MAD'];
export const CATEGORIE_ESTERNE = { fornitore: 'Fornitore', trasferta: 'Trasferta', licenze: 'Licenze', altro: 'Altro' };
// Voce dei Costi Progetto come chiave del costo interno: minuscolo, spazi singoli.
export const normVoce = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const n = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const giornoMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const piuGiorni = (iso, gg) => new Date(giornoMs(iso) + gg * 86400000).toISOString().slice(0, 10);

// ----------------------------------------------------------------------------
// Voci dei Costi Progetto con effort e VALORE in euro
// ----------------------------------------------------------------------------
async function vociInEuro(user, projectId) {
  const cols = await colonneTabella('proj_worker');
  const c = (x) => cols.has(x);
  // Nomi delle colonne come nel database (con fallback ai nomi della prima versione).
  const eff = (u) => (c(`offerta_effort_${u}`) ? `a.offerta_effort_${u}` : c(`effort_${u}`) ? `a.effort_${u}` : 'NULL::numeric');
  const valOff = (u) => (c(`offerta_${u}`) ? `a.offerta_${u}` : `(${eff(u)} * a.tariffa_${u})`);
  const valSpe = (u) => (c(`cost_time_spent_${u}`) ? `a.cost_time_spent_${u}` : `(a.time_spent_${u} * a.tariffa_${u})`);
  const r = await db.query(
    `SELECT COALESCE(wc.desc_worker, 'Senza voce') AS voce, hh.gestione_hh AS hh,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(${eff('hh')}, 0) ELSE COALESCE(${eff('gg')}, 0) END) AS offerta,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END) AS speso,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(${valOff('hh')}, ${valOff('gg')}, 0) ELSE COALESCE(${valOff('gg')}, ${valOff('hh')}, 0) END) AS valore_offerto,
            SUM(CASE WHEN hh.gestione_hh THEN COALESCE(${valSpe('hh')}, ${valSpe('gg')}, 0) ELSE COALESCE(${valSpe('gg')}, ${valSpe('hh')}, 0) END) AS valore_speso,
            MAX(CASE WHEN hh.gestione_hh THEN a.tariffa_hh ELSE a.tariffa_gg END) AS tariffa
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
  return r.rows.map((x) => ({
    voce: x.voce, hh: !!x.hh, offerta: n(x.offerta), speso: n(x.speso),
    valoreOfferto: n(x.valore_offerto), valoreSpeso: n(x.valore_speso), tariffa: x.tariffa == null ? null : Number(x.tariffa)
  }));
}

// ----------------------------------------------------------------------------
// Tabelle di pm_economia.sql (vuote se lo script non è ancora stato eseguito)
// ----------------------------------------------------------------------------
export async function impostazioniEconomia(user, projectId) {
  if (!(await tabellaPresente('pm_economia'))) return { valuta: 'EUR', cambio: null };
  const r = (await db.query(
    'SELECT valuta, cambio::float8 AS cambio FROM pm_economia WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3',
    [user.tenant_id, user.user_id, projectId])).rows[0];
  return r ? { valuta: r.valuta || 'EUR', cambio: r.cambio } : { valuta: 'EUR', cambio: null };
}

export async function costiInterni(user) {
  if (!(await tabellaPresente('pm_costo_interno'))) return new Map();
  const r = await db.query(
    'SELECT voce, costo_gg::float8 AS costo_gg, costo_hh::float8 AS costo_hh FROM pm_costo_interno WHERE tenant_id = $1 AND user_id = $2',
    [user.tenant_id, user.user_id]);
  return new Map(r.rows.map((x) => [x.voce, { gg: x.costo_gg, hh: x.costo_hh }]));
}

export async function costiEsterni(user, projectId) {
  if (!(await tabellaPresente('pm_costo_esterno'))) return [];
  const r = await db.query(
    `SELECT id::text AS id, categoria, descrizione, fornitore, data::text AS data, previsto::float8 AS previsto,
            effettivo::float8 AS effettivo, note, id_roles_write
       FROM pm_costo_esterno
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY data NULLS LAST, created_at`,
    [user.tenant_id, user.user_id, projectId]);
  return r.rows;
}

// Costo interno di un'unità (ora o giornata) della voce; null se non impostato.
function costoUnita(mappa, voce, hh) {
  const c = mappa.get(normVoce(voce));
  if (!c) return null;
  if (hh) return c.hh != null ? c.hh : (c.gg != null ? c.gg / 8 : null);
  return c.gg != null ? c.gg : (c.hh != null ? c.hh * 8 : null);
}

// ----------------------------------------------------------------------------
// Lavoro previsto dal piano a una data (0..100)
// ----------------------------------------------------------------------------
// Foglie del Gantt pesate per durata, sulle date di baseline se ci sono (piano approvato),
// altrimenti sulle date attuali. Senza Gantt: crescita lineare fra Start ed End della scheda.
// Restituisce anche il periodo coperto dal piano (per la curva a S).
export function pianoLavoro(righe, scheda) {
  const haFigli = new Set();
  for (const r of righe) {
    const p = r.chiave.split('.');
    if (p.length > 1) haFigli.add(p.slice(0, -1).join('.'));
  }
  const foglie = righe.filter((r) => !haFigli.has(r.chiave)).map((r) => {
    const conBaseline = r.baselineInizio && r.baselineFine;
    return { inizio: conBaseline ? r.baselineInizio : r.inizio, fine: conBaseline ? r.baselineFine : r.fine };
  }).filter((r) => r.inizio && r.fine && r.fine >= r.inizio);
  let fonte = 'gantt';
  if (!foglie.length) {
    if (!(scheda.start && scheda.end && scheda.end >= scheda.start)) return null;
    foglie.push({ inizio: scheda.start, fine: scheda.end });
    fonte = 'scheda';
  }
  const baseline = righe.some((r) => r.baselineFine);
  const pesi = foglie.map((f) => Math.max(1, giorniTra(f.inizio, f.fine) + 1));
  const tot = pesi.reduce((s, w) => s + w, 0);
  const al = (d) => {
    let fatto = 0;
    foglie.forEach((f, i) => {
      if (d < f.inizio) return;
      fatto += pesi[i] * Math.min(1, (giorniTra(f.inizio, d) + 1) / pesi[i]);
    });
    return tot ? (fatto / tot) * 100 : 0;
  };
  const inizio = foglie.reduce((m, f) => (f.inizio < m ? f.inizio : m), foglie[0].inizio);
  const fine = foglie.reduce((m, f) => (f.fine > m ? f.fine : m), foglie[0].fine);
  return { al, inizio, fine, fonte: fonte === 'gantt' ? (baseline ? 'baseline' : 'gantt') : 'scheda' };
}

// ----------------------------------------------------------------------------
// ECONOMIA COMPLETA DEL PROGETTO
// ----------------------------------------------------------------------------
export async function economiaEuro(user, projectId, { prog = null, scheda = null } = {}) {
  prog = prog || await progettoUtente(user, projectId);
  scheda = scheda || await schedaProgetto(user, projectId);
  const oggi = oggiIso();
  const [voci, righe, cr, imp, interni, esterni, tabelle] = await Promise.all([
    vociInEuro(user, projectId), righeGantt(user, projectId), crProgetto(user, projectId),
    impostazioniEconomia(user, projectId), costiInterni(user), costiEsterni(user, projectId),
    tabellaPresente('pm_costo_esterno')
  ]);
  const gantt = analisiGantt(righe, oggi);
  const aOre = scheda.aOre;
  const unita = aOre ? 'ore' : 'giorni';
  const crApprovate = cr.filter((x) => x.stato === 'approvata');
  const crImporto = crApprovate.reduce((s, x) => s + n(x.importo_delta), 0);
  const crEffort = crApprovate.reduce((s, x) => s + n(x.effort_delta), 0);

  // --- Valore (prezzo al cliente) ---
  const valoreOfferto = voci.reduce((s, v) => s + v.valoreOfferto, 0);
  const valoreSpeso = voci.reduce((s, v) => s + v.valoreSpeso, 0);
  const effortOfferto = voci.reduce((s, v) => s + v.offerta, 0);
  const effortSpeso = voci.reduce((s, v) => s + v.speso, 0);
  // Budget: il valore delle voci (tariffe) + CR. Senza tariffe nei Costi Progetto si usa
  // l'Importo della scheda, così CPI e SPI si calcolano lo stesso (con meno precisione).
  let fonteBudget = 'tariffe';
  let bac = valoreOfferto + crImporto;
  if (!valoreOfferto && scheda.importo) { bac = scheda.importo + crImporto; fonteBudget = 'importo'; }
  if (!bac) fonteBudget = null;
  const ac = valoreSpeso;

  const completamento = scheda.completamento != null ? scheda.completamento : gantt.completamento;
  const fonteCompl = scheda.completamento != null ? 'scheda' : (gantt.completamento != null ? 'gantt' : null);
  const pc = completamento != null ? Math.max(0, Math.min(100, completamento)) / 100 : null;
  const piano = pianoLavoro(righe, scheda);
  const pvPerc = piano ? Math.max(0, Math.min(100, piano.al(oggi))) : null;

  const ev = bac && pc != null ? pc * bac : null;
  const pv = bac && pvPerc != null ? (pvPerc / 100) * bac : null;
  const cpi = ev != null && ac > 0 ? ev / ac : null;
  const spi = ev != null && pv > 0 ? ev / pv : null;
  const eac = cpi ? bac / cpi : null;
  const etc = eac != null ? Math.max(0, eac - ac) : null;
  const vac = eac != null ? bac - eac : null;
  const tcpi = bac && ev != null && bac > ac ? (bac - ev) / (bac - ac) : null;
  // Sotto il 15% di completamento gli indici oscillano troppo (come per il semaforo).
  const affidabile = completamento != null && completamento >= 15;

  // --- Ricavo e margine ---
  const ricavo = (scheda.importo != null ? scheda.importo : valoreOfferto) + crImporto;
  const fonteRicavo = scheda.importo != null ? 'importo' : 'tariffe';
  let costoPrevistoInterno = 0, costoSpesoInterno = 0, unitaSenzaCosto = 0, conCosto = 0, effortConCosto = 0;
  const righeVoci = voci.map((v) => {
    const cu = costoUnita(interni, v.voce, v.hh);
    if (cu != null) {
      costoPrevistoInterno += v.offerta * cu;
      costoSpesoInterno += v.speso * cu;
      effortConCosto += v.offerta;
      conCosto += 1;
    } else if (v.offerta || v.speso) unitaSenzaCosto += 1;
    const margineVoce = cu != null ? v.valoreOfferto - v.offerta * cu : null;
    return {
      ...v, costoUnita: cu,
      costoPrevisto: cu != null ? v.offerta * cu : null, costoSpeso: cu != null ? v.speso * cu : null,
      margine: margineVoce, marginePerc: margineVoce != null && v.valoreOfferto ? (margineVoce / v.valoreOfferto) * 100 : null
    };
  });
  // Effort delle CR approvate al costo interno medio delle voci con costo.
  const costoMedio = effortConCosto ? costoPrevistoInterno / effortConCosto : null;
  const costoCr = costoMedio != null ? crEffort * costoMedio : 0;
  const estPrevisto = esterni.reduce((s, x) => s + n(x.previsto), 0);
  const estEffettivo = esterni.reduce((s, x) => s + n(x.effettivo), 0);
  // A finire: costo interno speso proiettato sul completamento; esterni = il maggiore fra
  // previsto ed effettivo di ogni riga.
  const estAFinire = esterni.reduce((s, x) => s + Math.max(n(x.previsto), n(x.effettivo)), 0);
  const haInterni = conCosto > 0;
  // Senza nessun costo interno il margine sarebbe ricavo meno i soli esterni (gonfiato): non si calcola.
  const costoPrevisto = haInterni ? costoPrevistoInterno + costoCr + estPrevisto : null;
  const costoSpeso = haInterni ? costoSpesoInterno + estEffettivo : null;
  let costoAFinire = null;
  if (haInterni && pc != null && pc > 0) costoAFinire = costoSpesoInterno / pc + estAFinire;
  else if (costoPrevisto != null) costoAFinire = Math.max(costoPrevistoInterno + costoCr, costoSpesoInterno) + estAFinire;
  const margine = {
    ricavo, fonteRicavo,
    costoPrevisto, costoSpeso, costoAFinire,
    previsto: costoPrevisto != null ? ricavo - costoPrevisto : null,
    aFinire: costoAFinire != null ? ricavo - costoAFinire : null,
    vociSenzaCosto: unitaSenzaCosto, haInterni,
    esterni: { previsto: estPrevisto, effettivo: estEffettivo, aFinire: estAFinire, righe: esterni.length },
    interni: { previsto: costoPrevistoInterno + costoCr, speso: costoSpesoInterno, cr: costoCr }
  };
  margine.previstoPerc = margine.previsto != null && ricavo ? (margine.previsto / ricavo) * 100 : null;
  margine.aFinirePerc = margine.aFinire != null && ricavo ? (margine.aFinire / ricavo) * 100 : null;

  // --- Curva a S: piano (settimanale) + storia delle fotografie giornaliere ---
  const curva = { piano: [], storia: [] };
  if (piano && bac) {
    const tot = Math.max(1, giorniTra(piano.inizio, piano.fine));
    const passo = Math.max(1, Math.round(tot / 40));
    for (let d = piano.inizio; d <= piano.fine; d = piuGiorni(d, passo)) curva.piano.push({ d, v: (piano.al(d) / 100) * bac });
    if (curva.piano[curva.piano.length - 1]?.d !== piano.fine) curva.piano.push({ d: piano.fine, v: bac });
  }
  if (await tabellaPresente('pm_snapshot')) {
    const sc = await colonneTabella('pm_snapshot');
    const conEuro = sc.has('ac_euro');
    const r = await db.query(
      `SELECT giorno::text AS giorno, speso::float8 AS speso, completamento::float8 AS completamento
              ${conEuro ? ', ac_euro::float8 AS ac_euro, ev_euro::float8 AS ev_euro' : ''}
         FROM pm_snapshot WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 ORDER BY giorno`,
      [user.tenant_id, user.user_id, projectId]);
    // Fotografie senza valori in euro (prima di pm_economia.sql): stima dalla tariffa media
    // di oggi (valore speso / effort speso) e dal completamento di quel giorno.
    const tariffaMedia = effortSpeso ? valoreSpeso / effortSpeso : null;
    curva.storia = r.rows.map((x) => ({
      d: x.giorno,
      ac: x.ac_euro != null ? x.ac_euro : (tariffaMedia != null && x.speso != null ? x.speso * tariffaMedia : null),
      ev: x.ev_euro != null ? x.ev_euro : (bac && x.completamento != null ? (x.completamento / 100) * bac : null),
      stimata: x.ac_euro == null
    })).filter((x) => x.ac != null || x.ev != null);
  }
  // Il punto di oggi sempre presente (anche senza fotografie).
  if (!curva.storia.length || curva.storia[curva.storia.length - 1].d !== oggi) curva.storia.push({ d: oggi, ac, ev, stimata: false });

  return {
    progetto: prog, oggi, unita, tabelle,
    impostazioni: { ...imp, valute: VALUTE },
    voci: righeVoci,
    effort: { offerto: effortOfferto, speso: effortSpeso, crEffort },
    ev: {
      bac, fonteBudget, valoreOfferto, crImporto, ac, ev, pv, pvPerc, completamento, fonteCompletamento: fonteCompl,
      piano: piano ? { fonte: piano.fonte, inizio: piano.inizio, fine: piano.fine } : null,
      cpi, spi, eac, etc, vac, tcpi, affidabile,
      sconto: scheda.importo != null && valoreOfferto ? valoreOfferto - scheda.importo : null
    },
    margine,
    esterni: esterni.map((x) => ({ ...x, categoriaLabel: CATEGORIE_ESTERNE[x.categoria] || x.categoria })),
    curva
  };
}

// Valori in euro della fotografia giornaliera (jobs/pmJobs.js), se le colonne ci sono.
export async function fotografiaEuro(user, projectId, giorno) {
  const cols = await colonneTabella('pm_snapshot');
  if (!cols.has('ac_euro')) return false;
  const e = (await economiaEuro(user, projectId)).ev;
  await db.query(
    `UPDATE pm_snapshot SET bac_euro = $5, pv_euro = $6, ev_euro = $7, ac_euro = $8
      WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3 AND giorno = $4::date`,
    [user.tenant_id, user.user_id, projectId, giorno, e.bac || null, e.pv, e.ev, e.ac]);
  return true;
}

// Testo per l'AI (Status Report, Chiedi al progetto, Briefing): l'economia in denaro.
export function testoEconomia(ec) {
  const e = ec.ev, m = ec.margine;
  const L = [];
  if (!e.bac) return '';
  const ind = (v) => (v == null ? '-' : fmt(v, 2));
  L.push(`ECONOMIA IN EURO (Earned Value${e.affidabile ? '' : ', completamento sotto il 15%: indici poco affidabili'})`);
  L.push(`Budget ${euro(e.bac)}${e.crImporto ? ` (di cui CR approvate ${euro(e.crImporto)})` : ''} | pianificato a oggi ${euro(e.pv)}${e.pvPerc != null ? ` (${fmt(e.pvPerc, 0)}%)` : ''} | guadagnato ${euro(e.ev)} | consumato ${euro(e.ac)}`);
  L.push(`CPI ${ind(e.cpi)} | SPI ${ind(e.spi)} | stima a finire ${euro(e.eac)} | scostamento a finire ${euro(e.vac)} | TCPI ${ind(e.tcpi)}`);
  if (m.previsto != null || m.aFinire != null) {
    L.push(`Margine: ricavo ${euro(m.ricavo)} | previsto ${euro(m.previsto)}${m.previstoPerc != null ? ` (${fmt(m.previstoPerc, 1)}%)` : ''} | a finire ${euro(m.aFinire)}${m.aFinirePerc != null ? ` (${fmt(m.aFinirePerc, 1)}%)` : ''}${m.vociSenzaCosto ? ` | ${m.vociSenzaCosto} voci senza costo interno` : ''}`);
  }
  if (m.esterni.righe) L.push(`Costi esterni: previsti ${euro(m.esterni.previsto)}, sostenuti ${euro(m.esterni.effettivo)}`);
  const imp = ec.impostazioni;
  if (imp.valuta && imp.valuta !== 'EUR' && imp.cambio) L.push(`Valuta del contratto ${imp.valuta} (1 EUR = ${fmt(imp.cambio, 4)} ${imp.valuta}): budget ${fmt(e.bac * imp.cambio, 2)} ${imp.valuta}`);
  return L.join('\n');
}


