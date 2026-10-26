// ============================================================================
// ASSOCIAZIONE AUTOMATICA TO-DO LIST E RAID (job «associa_todo_raid», 2026-10-20)
// ----------------------------------------------------------------------------
// L'AI che estrae To-Do, Rischi, Decisioni e Dipendenze dalle riunioni crea spesso la stessa
// cosa in più registri: chiudendone una ci si dimentica dell'altra. Ogni mattina (lun-ven alle
// 5:00) il job manda all'AI scelta dall'utente in Impostazioni › AI › «Associazione Autom.
// ToDoList e RAID» le voci APERTE di UN progetto alla volta e scrive lo stesso collegamento_id
// (uuid) sulle voci che parlano della stessa cosa: tasks.collegamento_id e
// pm_raid.collegamento_id. Chiudendo una voce, il trigger del database chiude le collegate
// (Supporto/CreaDB/associazione_todo_raid.sql).
//
// AI: ChatGPT / Claude / Gemini / Mistral sempre in modalità BATCH (metà prezzo, risposta entro
// 24 ore): i giri successivi del job (ogni 15 minuti) raccolgono i risultati pronti. Gemini
// gratuito non ha il Batch: niente associazione e una notifica che chiede di scegliere un'altra
// AI. «Projexa» = modello locale Ollama della VM: gratuito, senza Batch, eseguito subito (alle
// 5 la VM è libera). Copilot non è utilizzabile (nessuna API disponibile).
//
// Per non mandare tutto all'AI: solo progetti con voci nuove o modificate dall'ultimo invio, e
// solo le voci che hanno qualcosa in comune con almeno una voce di un altro registro (parole
// del titolo/descrizione o stesso owner). Si collegano solo gli abbinamenti con confidenza alta.
//
// INSEGNANTE (2026-10-21, analisi_associazioni.sql): con «Projexa» (anche «Projexa 14B») e utente
// di ANALISI_PM_EMAILS, lo STESSO elenco di voci va anche all'AI della pagina Analisi PM (Gemini
// subito o ChatGPT in Batch), che risponde solo per confronto: non collega niente. In Analisi PM ›
// Associazioni si segnano i gruppi giusti e sbagliati (collegando o scollegando davvero le voci);
// le valutazioni diventano esempi nel prompt di Projexa e il file per addestrare
// assoc-projexa-14b, il modello usato qui quando c'è sulla VM.
// ============================================================================
import db from '../config/database.js';
import notifDb from '../config/notifDatabase.js';
import authDb from '../config/authDatabase.js';
import { encryptValue, encryptRowForWrite } from '../config/crypto.js';
import { titoloVoce } from '../config/dedupVoci.js';
import { askAiProvider, inviaBatchAi, statoBatchAi, isBatchNonDisponibile, ollamaPost, ollamaConPrecedenza, senzaRagionamento } from '../routes/ai.js';
import { nomiClientiProgetti } from './notifiche.js';
import { analisiPmAbilitata, aiScelta } from './analisiPm.js';
import { controllaIssueDoppie } from './issueDoppie.js';

// Nome nuovo dal 2026-10-26 (Supporto/CreaDB/uniforma_nomi_e_stati.sql); il vecchio vale ancora.
const CAMPI = ['associazione automatica to-do e raid', 'associazione autom. todolist e raid'];
const AI = { chatgpt: 'chatgpt', gpt: 'chatgpt', claude: 'claude', gemini: 'gemini', mistral: 'mistral' };
const CONFIDENZA_MIN = 80;     // sotto, l'abbinamento non si scrive
const MAX_VOCI = 60;           // voci per richiesta (un progetto)
const ORA_ULTIMO_INVIO = 9;    // dopo le 9 si invia solo a chi oggi non ha ancora avuto un invio (vedi invia)
const SCADENZA_BATCH_ORE = 26; // i fornitori garantiscono la risposta entro 24 ore
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
// Associazioni con «Projexa»: 14B (abbinare voci e rispondere in JSON è ragionamento, dove il
// 14B è nettamente meglio del 7B); se sulla VM non c'è, ollamaConPrecedenza ripiega sul 7B.
const OLLAMA_MODELLO = process.env.OLLAMA_ASSOCIAZIONI_MODEL || process.env.OLLAMA_FUNZIONI_14B_MODEL || 'qwen3:14b';
// Modello addestrato sulle valutazioni (Analisi PM › Modello sulla VM, famiglia «assoc»): se sulla
// VM non c'è ancora si usa OLLAMA_MODELLO.
export const OLLAMA_ADDESTRATO = process.env.OLLAMA_ASSOC_PROJEXA_MODEL || 'assoc-projexa-14b';
const MAX_ESEMPI = 8;          // per tipo (stesso impegno / da non collegare) nel prompt di Projexa

const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const oraRoma = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
const corto = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
export const REGISTRI = { todo: 'To-Do', rischio: 'Rischio', decisione: 'Decisione', dipendenza: 'Dipendenza', assunzione: 'Assunzione' };
// Dipendenze e assunzioni sono un registro solo nella pagina (stessa sezione).
const famiglia = (v) => (v.registro === 'assunzione' ? 'dipendenza' : v.registro);

// --------------------------------------------------------------------------
// Notifiche (campanella): al massimo una per utente, giorno e tipo (chiave_dedup).
// --------------------------------------------------------------------------
async function notifica(u, tipo, titolo, messaggio) {
  try {
    await notifDb.query(
      `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id, chiave_dedup)
       VALUES ($1, $2, 'ai', $3, $4, NULL, NULL, $5)
       ON CONFLICT (tenant_id, user_id, chiave_dedup) WHERE chiave_dedup IS NOT NULL
       DO UPDATE SET titolo = EXCLUDED.titolo, messaggio = EXCLUDED.messaggio, letta = false, letta_il = NULL, aggiornata_il = now()`,
      [u.tenant_id, u.user_id, encryptValue(titolo), messaggio ? encryptValue(String(messaggio).slice(0, 2000)) : null,
        `ai|associazione|${tipo}|${oggiRoma()}`]
    );
  } catch (e) {
    console.error(`[ASSOCIAZIONE] notifica non creata per ${u.user_id}: ${e.message}`);
  }
}

// --------------------------------------------------------------------------
// Voci aperte di un utente (decifrate dal pool) e scelta di quelle da confrontare.
// --------------------------------------------------------------------------
async function vociAperte(u, projectId = null) {
  const p = projectId ? ' AND project_id::text = $3' : '';
  const args = projectId ? [u.tenant_id, u.user_id, String(projectId)] : [u.tenant_id, u.user_id];
  const t = (await db.query(
    `SELECT id::text AS id, project_id::text AS project_id, client_id::text AS client_id, titile AS titolo, description AS descrizione,
            assigned_to_text AS owner, collegamento_id::text AS coll, coalesce(updated_at, created_at) AS mod
       FROM tasks
      WHERE tenant_id = $1 AND user_id = $2 AND project_id IS NOT NULL
        AND status IS DISTINCT FROM 'completed' AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)${p}`, args)).rows
    .map((x) => ({ ...x, tabella: 'tasks', registro: 'todo' }));
  const r = (await db.query(
    `SELECT id::text AS id, project_id::text AS project_id, client_id::text AS client_id, titolo, descrizione, owner, tipo,
            collegamento_id::text AS coll, coalesce(updated_at, created_at) AS mod
       FROM pm_raid
      WHERE tenant_id = $1 AND user_id = $2 AND stato <> 'chiuso'
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)${p}`, args)).rows
    .map((x) => ({ ...x, tabella: 'pm_raid', registro: x.tipo }));
  return [...t, ...r];
}

const VUOTE = new Set(['della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'sulla', 'sulle', 'questo', 'questa', 'quello', 'quella', 'anche', 'perché', 'quindi', 'essere', 'fare', 'progetto', 'cliente', 'teamsystem', 'attività', 'attivita', 'verifica', 'gestione', 'tutti', 'entro']);
const parole = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-zà-ú0-9 ]+/gi, ' ').split(/\s+/)
  .filter((w) => w.length >= 4 && !VUOTE.has(w)));
const persona = (o) => String(o || '').toLowerCase().replace(/[^a-zà-ú ]+/g, ' ').trim();

// Coppie plausibili tra registri diversi: ≥2 parole in comune, oppure stesso owner e ≥1 parola.
export function candidate(voci) {
  const W = voci.map((v) => parole(`${v.titolo} ${v.descrizione || ''}`));
  const scelte = new Set();
  for (let i = 0; i < voci.length; i++) {
    for (let j = i + 1; j < voci.length; j++) {
      if (famiglia(voci[i]) === famiglia(voci[j])) continue;
      if (voci[i].coll && voci[i].coll === voci[j].coll) continue; // già collegate
      let comuni = 0;
      for (const w of W[i]) if (W[j].has(w)) comuni++;
      const stessoOwner = persona(voci[i].owner) && persona(voci[i].owner) === persona(voci[j].owner);
      if (comuni >= 2 || (stessoOwner && comuni >= 1)) { scelte.add(i); scelte.add(j); }
    }
  }
  return [...scelte].map((i) => voci[i]);
}

// Controllo sulla risposta dell'AI (prova 2026-10-20: il 7B metteva insieme saldi ferie,
// causali e wave «perché tutte del go-live»): ogni voce del gruppo deve avere almeno 2 parole
// significative in comune con una voce di un ALTRO registro dello stesso gruppo.
// In più: almeno una voce RAID e al massimo una per registro RAID (Dipendenze e Assunzioni contano
// come uno). Più To-Do sono ammesse (passi della stessa voce RAID): il trigger chiude la voce RAID
// solo quando sono completate tutte, e non chiude le To-Do tra loro.
export function coerente(voci) {
  const raid = voci.filter((v) => v.tabella === 'pm_raid').map(famiglia);
  if (!raid.length || new Set(raid).size !== raid.length) return false;
  const W = voci.map((v) => parole(`${v.titolo} ${v.descrizione || ''}`));
  return voci.every((v, i) => voci.some((x, j) => {
    if (i === j || famiglia(x) === famiglia(v)) return false;
    let comuni = 0;
    for (const w of W[i]) if (W[j].has(w)) comuni++;
    return comuni >= 2;
  }));
}

// esempi: casi valutati in Analisi PM (esempiValutati), solo per Projexa. Senza esempi è il
// compito esatto dell'insegnante e degli esempi di addestramento.
export function prompt(voci, esempi = '') {
  const elenco = voci.map((v, i) => ({
    n: i + 1, registro: REGISTRI[v.registro] || v.registro, titolo: corto(v.titolo, 200),
    descrizione: corto(v.descrizione, 400), owner: corto(v.owner, 80) || null
  }));
  return `Sei un project manager. Queste sono le voci APERTE di un solo progetto, prese da registri diversi (To-Do List, Rischi, Decisioni, Dipendenze, Assunzioni). Spesso la stessa cosa è stata scritta in più registri con parole diverse.

Trova i GRUPPI di voci che si riferiscono allo STESSO impegno concreto: chiudendo una voce, anche le altre del gruppo non avrebbero più motivo di restare aperte (es. la Decisione "sessioni di formazione presenze il 16 e 26 novembre" e la To-Do "organizzare le sessioni di formazione presenze").
NON raggruppare voci che parlano solo dello stesso argomento generale ma di attività diverse (es. "formazione presenze" e "configurazione presenze" no; "saldi ferie" e "causali" no).
Di solito un gruppo ha 2 voci, raramente 3. Nel dubbio NON raggruppare: un collegamento sbagliato chiude voci che dovevano restare aperte.
Usa titolo, descrizione e owner. Ogni voce può stare in un solo gruppo. Un gruppo ha almeno 2 voci, almeno una NON To-Do, e al massimo UNA voce per ciascun registro RAID (Rischi, Decisioni, Dipendenze/Assunzioni). Più To-Do nello stesso gruppo solo se sono i passi della stessa voce RAID (es. la Decisione "formazione il 16 e il 26" con le To-Do "sessione 1" e "sessione 2").

Rispondi SOLO con JSON in questa forma:
{"gruppi":[{"voci":[1,4],"confidenza":90,"motivo":"breve spiegazione"}]}
confidenza da 0 a 100 (100 = certamente la stessa cosa). Se non ci sono gruppi: {"gruppi":[]}
${esempi}
VOCI:
${JSON.stringify(elenco, null, 0)}`;
}

// JSON della risposta (anche se l'AI aggiunge testo o ```json intorno).
export function leggiGruppi(testo) {
  const t = String(testo || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('risposta dell\'AI senza JSON');
  const j = JSON.parse(m[0]);
  return Array.isArray(j.gruppi) ? j.gruppi : [];
}

// Gruppi di una risposta, ripuliti (voci 1..n senza doppioni, in ordine); null = risposta illeggibile.
export function gruppiDa(testo, n) {
  try {
    return leggiGruppi(testo).map((g) => ({
      voci: [...new Set((Array.isArray(g && g.voci) ? g.voci : []).map(Number))].filter((x) => Number.isInteger(x) && x >= 1 && x <= n).sort((a, b) => a - b),
      confidenza: Number(g && g.confidenza) || 0,
      motivo: String((g && g.motivo) || '').slice(0, 500)
    })).filter((g) => g.voci.length >= 2);
  } catch {
    return null;
  }
}

// Fotografia delle voci inviate (pm_associazioni.elenco): serve a mostrarle e a ricostruire il
// compito anche dopo che le voci sono state chiuse o modificate.
const fotografia = (voci) => voci.map((v) => ({
  k: `${v.tabella}|${v.id}`, registro: v.registro, titolo: v.titolo, descrizione: v.descrizione || null, owner: v.owner || null
}));

// Casi valutati dall'utente in Analisi PM › Associazioni (i più recenti), come metro di giudizio
// per Projexa. '' = nessuno (o tabelle non ancora aggiornate).
export async function esempiValutati(u) {
  let righe;
  try {
    righe = (await db.query(
      `SELECT elenco, valutazione FROM pm_associazioni
        WHERE tenant_id = $1 AND user_id = $2 AND valutazione IS NOT NULL AND elenco IS NOT NULL
        ORDER BY valutata_il DESC NULLS LAST, created_at DESC LIMIT 40`, [u.tenant_id, u.user_id])).rows;
  } catch (e) {
    if (e.code === '42703') return '';
    throw e;
  }
  const si = [];
  const no = [];
  for (const r of righe) {
    let el, va;
    try { el = JSON.parse(r.elenco); va = JSON.parse(r.valutazione); } catch { continue; }
    for (const g of (va && Array.isArray(va.gruppi) ? va.gruppi : [])) {
      const voci = (g.voci || []).map((n) => el[n - 1]).filter(Boolean);
      if (voci.length < 2) continue;
      const riga = voci.map((v) => `${REGISTRI[v.registro] || v.registro} «${corto(v.titolo, 90)}»`).join(' + ');
      if (g.esito === 'giusto') si.push(riga);
      else if (g.esito === 'sbagliato') no.push(riga);
    }
  }
  if (!si.length && !no.length) return '';
  return `
CASI GIÀ VALUTATI DAL PROJECT MANAGER (di altri giorni o progetti: servono solo come metro di giudizio, NON sono voci di questo elenco):
${[...si.slice(0, MAX_ESEMPI).map((x) => `- STESSO IMPEGNO: ${x}`), ...no.slice(0, MAX_ESEMPI).map((x) => `- DA NON COLLEGARE: ${x}`)].join('\n')}
`;
}

// Stato attuale delle voci (chiavi «tabella|id»): collegamento e apertura.
export async function vociDaChiavi(u, chiavi) {
  const out = [];
  for (const [tab, stato] of [['tasks', `status IS DISTINCT FROM 'completed'`], ['pm_raid', `stato <> 'chiuso'`]]) {
    const ids = chiavi.filter((k) => k.startsWith(`${tab}|`)).map((k) => k.slice(tab.length + 1));
    if (!ids.length) continue;
    const r = await db.query(
      `SELECT id::text AS id, collegamento_id::text AS coll, (${stato}) AS aperta FROM ${tab}
        WHERE tenant_id = $1 AND user_id = $2 AND id::text = ANY($3)`, [u.tenant_id, u.user_id, ids]);
    out.push(...r.rows.map((x) => ({ ...x, tabella: tab, k: `${tab}|${x.id}` })));
  }
  return out;
}

// Collega a mano (gruppo segnato come giusto): stesso collegamento_id, unificando quelli che le
// voci avevano già, come applica(). Non tocca updated_at.
export async function collegaVoci(u, chiavi) {
  const voci = await vociDaChiavi(u, chiavi);
  if (voci.length < 2) throw Object.assign(new Error('Servono almeno 2 voci ancora presenti'), { status: 400 });
  const esistenti = [...new Set(voci.map((v) => v.coll).filter(Boolean))];
  const coll = esistenti[0] || (await db.query('SELECT gen_random_uuid()::text AS id')).rows[0].id;
  for (const tab of ['tasks', 'pm_raid']) {
    await db.query(
      `UPDATE ${tab} SET collegamento_id = $1::uuid
        WHERE tenant_id = $2 AND user_id = $3 AND (id::text = ANY($4) OR collegamento_id::text = ANY($5))`,
      [coll, u.tenant_id, u.user_id, voci.filter((v) => v.tabella === tab).map((v) => v.id), esistenti]);
  }
  await descriviGruppo(u, coll);
}

// Scollega (gruppo segnato come sbagliato): le voci escono dal loro collegamento; chi resta da
// solo nel gruppo viene scollegato da descriviGruppo.
export async function scollegaVoci(u, chiavi) {
  const voci = await vociDaChiavi(u, chiavi);
  const colls = [...new Set(voci.map((v) => v.coll).filter(Boolean))];
  for (const tab of ['tasks', 'pm_raid']) {
    const ids = voci.filter((v) => v.tabella === tab).map((v) => v.id);
    if (ids.length) {
      await db.query(`UPDATE ${tab} SET collegamento_id = NULL, collegato_a = NULL WHERE tenant_id = $1 AND user_id = $2 AND id::text = ANY($3)`,
        [u.tenant_id, u.user_id, ids]);
    }
  }
  for (const c of colls) await descriviGruppo(u, c);
}

// Insegnante attivo per l'utente: pagina Analisi PM abilitata (ANALISI_PM_EMAILS).
async function insegnanteAttivo(u) {
  if (!String(process.env.ANALISI_PM_EMAILS || '').trim()) return false;
  const r = (await authDb.query('SELECT email FROM users WHERE id = $1', [u.user_id])).rows[0];
  return analisiPmAbilitata(r && r.email);
}

// --------------------------------------------------------------------------
// Applicazione: stesso collegamento_id a tutte le voci del gruppo. Se alcune avevano già un
// collegamento, si unificano sotto quello (anche le altre voci di quei collegamenti).
// Non si tocca updated_at: le voci non risultano "modificate" il giorno dopo.
// --------------------------------------------------------------------------
async function applica(u, voci, gruppi) {
  const usate = new Set();
  const righe = [];
  let collegate = 0;
  for (const g of gruppi) {
    const conf = Number(g && g.confidenza) || 0;
    const idx = [...new Set((Array.isArray(g && g.voci) ? g.voci : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= voci.length && !usate.has(n));
    if (conf < CONFIDENZA_MIN || idx.length < 2) continue;
    const scelte = idx.map((n) => voci[n - 1]);
    if (new Set(scelte.map(famiglia)).size < 2 || !coerente(scelte)) {
      console.log(`[ASSOCIAZIONE] gruppo scartato (voci senza abbastanza in comune): ${scelte.map((v) => corto(v.titolo, 40)).join(' | ')}`);
      continue;
    }
    // Le voci devono essere ancora aperte (il Batch può arrivare ore dopo).
    const ancora = await vociAperte(u, scelte[0].project_id);
    const aperte = new Set(ancora.map((v) => `${v.tabella}|${v.id}`));
    const valide = scelte.filter((v) => aperte.has(`${v.tabella}|${v.id}`));
    if (valide.length < 2) continue;
    idx.forEach((n) => usate.add(n));
    const esistenti = [...new Set(ancora.filter((v) => valide.some((x) => x.tabella === v.tabella && x.id === v.id) && v.coll).map((v) => v.coll))];
    const coll = esistenti[0] || (await db.query('SELECT gen_random_uuid()::text AS id')).rows[0].id;
    for (const tab of ['tasks', 'pm_raid']) {
      const ids = valide.filter((v) => v.tabella === tab).map((v) => v.id);
      await db.query(
        `UPDATE ${tab} SET collegamento_id = $1::uuid
          WHERE tenant_id = $2 AND user_id = $3 AND (id::text = ANY($4) OR collegamento_id::text = ANY($5))`,
        [coll, u.tenant_id, u.user_id, ids, esistenti]);
    }
    await descriviGruppo(u, coll);
    collegate += valide.length;
    righe.push(`${valide.map((v) => `${REGISTRI[v.registro] || v.registro} «${corto(titoloVoce(v), 60)}»`).join(' ↔ ')}`);
  }
  return { collegate, righe };
}

// «Collegato a» (colonna collegato_a, 2026-10-20): su ogni voce del gruppo le ALTRE voci, in
// chiaro («Decisione: … | Rischio: …»), da mostrare al posto del codice collegamento_id nella
// To-Do List, nel RAID e nei report. Gruppo rimasto con una sola voce = collegamento tolto.
async function descriviGruppo(u, coll) {
  const voci = [
    ...(await db.query(`SELECT id::text AS id, titile AS titolo, description AS descrizione FROM tasks
        WHERE tenant_id = $1 AND user_id = $2 AND collegamento_id::text = $3`, [u.tenant_id, u.user_id, coll])).rows
      .map((x) => ({ ...x, tabella: 'tasks', registro: 'todo' })),
    ...(await db.query(`SELECT id::text AS id, titolo, descrizione, tipo FROM pm_raid
        WHERE tenant_id = $1 AND user_id = $2 AND collegamento_id::text = $3`, [u.tenant_id, u.user_id, coll])).rows
      .map((x) => ({ ...x, tabella: 'pm_raid', registro: x.tipo }))
  ];
  for (const v of voci) {
    const altre = voci.filter((x) => x !== v).map((x) => `${REGISTRI[x.registro] || x.registro}: ${corto(titoloVoce(x), 90)}`);
    const set = altre.length ? { collegato_a: altre.join(' | ').slice(0, 2000) } : { collegato_a: null, collegamento_id: null };
    const { data } = await encryptRowForWrite(db, v.tabella, set, { id: v.id });
    const cols = Object.keys(data);
    await db.query(`UPDATE ${v.tabella} SET ${cols.map((c, i) => `"${c}" = $${i + 4}`).join(', ')}
                     WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
    [v.id, u.tenant_id, u.user_id, ...cols.map((c) => data[c])]);
  }
}

// Collegamenti senza «Collegato a» (creati prima della colonna, o voce scollegata dalla scheda):
// si ricompone la descrizione di quei gruppi. Ogni giro del job, costa solo qualche query.
async function completaDescrizioni(report) {
  const g = (await db.query(
    `SELECT DISTINCT tenant_id::text AS tenant_id, user_id::text AS user_id, collegamento_id::text AS coll FROM (
       SELECT tenant_id, user_id, collegamento_id FROM tasks WHERE collegamento_id IS NOT NULL AND collegato_a IS NULL
       UNION ALL
       SELECT tenant_id, user_id, collegamento_id FROM pm_raid WHERE collegamento_id IS NOT NULL AND collegato_a IS NULL) x
     LIMIT 500`)).rows;
  for (const x of g) await descriviGruppo({ tenant_id: x.tenant_id, user_id: x.user_id }, x.coll);
  report.descritti = g.length;
}

// Esito di un progetto: riga salvata + elenco per la notifica dell'utente.
async function chiudiRichiesta(rich, u, voci, testo, esiti) {
  const gruppi = leggiGruppi(testo);
  const { collegate, righe } = await applica(u, voci, gruppi);
  await db.query(`UPDATE pm_associazioni SET stato = 'applicato', collegate = $2, risposta = $3, concluso_il = now() WHERE id = $1`,
    [rich.id, collegate, encryptValue(String(testo).slice(0, 20000))]);
  if (collegate) esiti.push({ u, projectId: rich.project_id, clientId: rich.client_id, righe });
  return collegate;
}

// Una notifica per utente con i collegamenti scritti (raggruppati per progetto).
async function notificaEsiti(esiti) {
  const perUtente = new Map();
  for (const e of esiti) {
    const k = `${e.u.tenant_id}|${e.u.user_id}`;
    if (!perUtente.has(k)) perUtente.set(k, { u: e.u, voci: [] });
    perUtente.get(k).voci.push(e);
  }
  for (const { u, voci } of perUtente.values()) {
    const { clienti, progetti } = await nomiClientiProgetti(voci.map((v) => v.clientId), voci.map((v) => v.projectId));
    const testo = voci.map((v) => [
      [clienti.get(String(v.clientId || '')), progetti.get(String(v.projectId || ''))].filter(Boolean).join(' · ') || 'Progetto',
      ...v.righe.map((r) => `• ${r}`)
    ].join('\n')).join('\n\n');
    const n = voci.reduce((s, v) => s + v.righe.length, 0);
    await notifica(u, 'esito', `Associazione To-Do e RAID: ${n} ${n === 1 ? 'collegamento nuovo' : 'collegamenti nuovi'}`,
      `${testo}\n\nChiudendo una voce RAID si chiudono anche le collegate (i Rischi passano a «in corso»); le voci RAID si chiudono da sole quando sono completate tutte le To-Do collegate. Riaprendo una voce si riaprono le collegate.`);
  }
}

// --------------------------------------------------------------------------
// Giro del job
// --------------------------------------------------------------------------
async function utentiAttivi() {
  return (await db.query(
    `SELECT DISTINCT ON (tenant_id, user_id) tenant_id::text AS tenant_id, user_id::text AS user_id, btrim(valore2) AS ai
       FROM settings
      WHERE lower(btrim(regexp_replace(campo, '^\\(\\*\\)\\s*', ''))) = ANY($1::text[])
        AND coalesce(btrim(valore2), '') <> ''
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY tenant_id, user_id, id`, [CAMPI])).rows;
}

// 1. Risultati Batch pronti.
async function raccogli(report, esiti) {
  const attese = (await db.query(
    `SELECT id, tenant_id::text AS tenant_id, user_id::text AS user_id, project_id::text AS project_id, client_id::text AS client_id,
            ai, batch_id, created_at FROM pm_associazioni WHERE stato = 'inviato' AND batch_id IS NOT NULL ORDER BY created_at`)).rows;
  for (const a of attese) {
    const u = { tenant_id: a.tenant_id, user_id: a.user_id };
    try {
      const s = await statoBatchAi(a.user_id, a.ai, a.batch_id);
      if (s.stato === 'in_corso') {
        if (Date.now() - new Date(a.created_at).getTime() > SCADENZA_BATCH_ORE * 3600000) throw new Error('nessuna risposta del Batch entro 26 ore');
        report.inAttesa++;
        continue;
      }
      if (s.stato !== 'pronto') throw new Error(s.errore || 'Batch non riuscito');
      // Le voci si rileggono: servono nello stesso ordine dell'invio (n = posizione).
      const voci = await vociInviate(u, a.id);
      report.collegate += await chiudiRichiesta(a, u, voci, s.text, esiti);
      report.raccolti++;
    } catch (e) {
      report.errori.push(`${a.ai} progetto ${a.project_id}: ${e.message}`);
      await db.query(`UPDATE pm_associazioni SET stato = 'errore', errore = $2, concluso_il = now() WHERE id = $1`, [a.id, String(e.message).slice(0, 1000)]);
    }
  }
}

// Voci inviate (id in ordine salvati nella richiesta) con i dati attuali.
async function vociInviate(u, richiestaId) {
  const r = (await db.query('SELECT project_id::text AS p, ordine FROM pm_associazioni WHERE id = $1', [richiestaId])).rows[0];
  if (!r || !Array.isArray(r.ordine)) throw new Error('elenco delle voci inviate non trovato');
  const tutte = await vociAperte(u, r.p);
  const perChiave = new Map(tutte.map((v) => [`${v.tabella}|${v.id}`, v]));
  // Voce chiusa nel frattempo: segnaposto (applica la scarta).
  return r.ordine.map((k) => perChiave.get(k) || { tabella: k.split('|')[0], id: k.split('|')[1], registro: 'chiusa', titolo: '' });
}

// Projexa: Ollama della VM, subito (gratuito, niente Batch). Dal 2026-10-20 con il 14B (alle 5
// la VM è libera e nessuno aspetta; se il 14B manca, il 7B) e con la precedenza ad Assistente PM
// e trascrizione se si allunga fino all'inizio delle call. Dal 2026-10-21 prima il modello
// addestrato (assoc-projexa-14b) se c'è, e i casi già valutati.
// perPrompt = voci da scrivere nel prompt, voci = le stesse con i dati attuali (posizione n).
const inCorsoLocali = new Set(); // richieste con Projexa in esecuzione in questo processo
async function associaConProjexa(rich, u, { perPrompt, voci, esempi, insegnante }, report, esiti) {
  inCorsoLocali.add(String(rich.id));
  try {
    const r = await ollamaConPrecedenza([OLLAMA_ADDESTRATO, OLLAMA_MODELLO], (model, signal) => ollamaPost(`${OLLAMA_URL}/api/chat`, {
      model, stream: false, format: 'json', think: false, keep_alive: '10m',
      messages: [{ role: 'user', content: prompt(perPrompt, esempi) }],
      options: { num_ctx: 8192, temperature: 0, num_predict: 800 }
    }, 40 * 60000, { signal }));
    if (!r.ok) throw new Error((r.data && r.data.error) || `Ollama: errore ${r.status}`);
    report.collegate += await chiudiRichiesta(rich, u, voci, senzaRagionamento(r.data && r.data.message && r.data.message.content), esiti);
    report.locali++;
    // Stesso elenco all'AI insegnante (giro successivo del job, funzione insegnante()).
    if (insegnante) await db.query(`UPDATE pm_associazioni SET insegnante_stato = 'da_inviare' WHERE id = $1`, [rich.id]);
  } finally {
    inCorsoLocali.delete(String(rich.id));
  }
}

// 1b. Richieste con Projexa interrotte da un riavvio del server (2026-10-23): la chiamata a
//     Ollama vive solo nel processo, e il 2026-10-22 un deploy a metà ha lasciato la richiesta
//     «inviato» per sempre (senza collegamenti né insegnante). Si rifanno con le stesse voci
//     (elenco salvato all'invio); oltre RIPRESA_LOCALI_ORE si chiudono in errore.
const RIPRESA_LOCALI_ORE = 48;
async function riprendiLocali(report, esiti) {
  const righe = (await db.query(
    `SELECT id, tenant_id::text AS tenant_id, user_id::text AS user_id, project_id::text AS project_id, client_id::text AS client_id, created_at
       FROM pm_associazioni WHERE stato = 'inviato' AND batch_id IS NULL AND ai = 'Projexa' ORDER BY created_at`)).rows;
  for (const a of righe) {
    if (inCorsoLocali.has(String(a.id))) continue;
    const u = { tenant_id: a.tenant_id, user_id: a.user_id };
    try {
      if (Date.now() - new Date(a.created_at).getTime() > RIPRESA_LOCALI_ORE * 3600000) {
        throw new Error(`associazione con Projexa interrotta (riavvio del server) e non ripresa entro ${RIPRESA_LOCALI_ORE} ore`);
      }
      const voci = await vociInviate(u, a.id);
      let perPrompt = voci;
      let insegnante = false;
      try {
        const el = (await db.query('SELECT elenco FROM pm_associazioni WHERE id = $1', [a.id])).rows[0];
        if (el && el.elenco) {
          perPrompt = JSON.parse(el.elenco);
          insegnante = await insegnanteAttivo(u).catch(() => false);
        }
      } catch (e) {
        if (e.code !== '42703') throw e; // analisi_associazioni.sql non eseguito: voci attuali
      }
      const esempi = await esempiValutati(u).catch(() => '');
      console.log(`[ASSOCIAZIONE] Riprendo con Projexa la richiesta ${a.id} (progetto ${a.project_id}) interrotta da un riavvio`);
      await associaConProjexa(a, u, { perPrompt, voci, esempi, insegnante }, report, esiti);
    } catch (e) {
      report.errori.push(`Projexa progetto ${a.project_id}: ${e.message}`);
      await db.query(`UPDATE pm_associazioni SET stato = 'errore', errore = $2, concluso_il = now() WHERE id = $1`, [a.id, String(e.message).slice(0, 1000)]);
    }
  }
}

// 2. Invio della mattina: un progetto alla volta per ogni utente.
async function invia(report, esiti) {
  const giorno = oggiRoma();
  const dopoLeNove = oraRoma() >= ORA_ULTIMO_INVIO;
  for (const u of await utentiAttivi()) {
    // Dopo le 9 si invia solo se oggi per questo utente non è ancora partito nessun invio
    // (VM spenta alle 5, primo giorno, «Esegui ora» dalla pagina Schedulazioni): le modifiche
    // fatte durante la giornata aspettano l'invio della mattina dopo (2026-10-20).
    if (dopoLeNove && (await db.query('SELECT 1 FROM pm_associazioni WHERE tenant_id = $1 AND user_id = $2 AND giorno = $3 LIMIT 1',
      [u.tenant_id, u.user_id, giorno])).rowCount) continue;
    const nome = u.ai.toLowerCase();
    // «Projexa» e «Projexa 14B» sono la stessa cosa qui: le associazioni usano già il 14B.
    const locale = /^projexa\b/.test(nome);
    const ai = AI[nome];
    let esempi = '';
    let insegnante = false;
    if (locale) {
      esempi = await esempiValutati(u).catch(() => '');
      insegnante = await insegnanteAttivo(u).catch(() => false);
    }
    if (!locale && !ai) {
      await notifica(u, 'ai', 'Associazione To-Do e RAID non eseguita',
        `«${u.ai}» non è utilizzabile per l'associazione automatica: scegli ChatGPT, Claude, Gemini (a pagamento), Mistral o Projexa in Impostazioni › AI › «Associazione automatica To-Do e RAID».`);
      report.saltati++;
      continue;
    }
    const tutte = await vociAperte(u);
    const ultimo = new Map((await db.query(
      `SELECT project_id::text AS p, max(created_at) AS t FROM pm_associazioni WHERE tenant_id = $1 AND user_id = $2 GROUP BY 1`,
      [u.tenant_id, u.user_id])).rows.map((x) => [x.p, new Date(x.t).getTime()]));
    const perProgetto = new Map();
    for (const v of tutte) {
      if (!perProgetto.has(v.project_id)) perProgetto.set(v.project_id, []);
      perProgetto.get(v.project_id).push(v);
    }
    for (const [projectId, voci] of perProgetto) {
      // Già fatto oggi, oppure niente di nuovo o modificato dall'ultimo invio.
      const giaOggi = (await db.query('SELECT 1 FROM pm_associazioni WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND giorno = $4',
        [u.tenant_id, u.user_id, projectId, giorno])).rowCount;
      if (giaOggi) continue;
      const da = ultimo.get(projectId) || 0;
      if (da && !voci.some((v) => new Date(v.mod).getTime() > da)) continue;
      const scelte = candidate(voci).slice(0, MAX_VOCI);
      if (scelte.length < 2) continue;
      const valori = [u.tenant_id, u.user_id, scelte.find((v) => v.client_id)?.client_id || null, projectId, giorno, locale ? 'Projexa' : ai, scelte.length,
        scelte.map((v) => `${v.tabella}|${v.id}`)];
      let rich;
      try {
        rich = (await db.query(
          `INSERT INTO pm_associazioni (tenant_id, user_id, client_id, project_id, giorno, ai, voci, ordine, elenco)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, user_id, project_id, giorno) DO NOTHING
           RETURNING id, project_id::text AS project_id, client_id::text AS client_id`,
          [...valori, encryptValue(JSON.stringify(fotografia(scelte)))])).rows[0];
      } catch (e) {
        if (e.code !== '42703') throw e;
        // analisi_associazioni.sql non ancora eseguito: come prima, senza fotografia.
        rich = (await db.query(
          `INSERT INTO pm_associazioni (tenant_id, user_id, client_id, project_id, giorno, ai, voci, ordine)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, user_id, project_id, giorno) DO NOTHING
           RETURNING id, project_id::text AS project_id, client_id::text AS client_id`, valori)).rows[0];
        insegnante = false;
      }
      if (!rich) continue;
      try {
        if (locale) {
          await associaConProjexa(rich, u, { perPrompt: scelte, voci: scelte, esempi, insegnante }, report, esiti);
        } else {
          const b = await inviaBatchAi(u.user_id, ai, prompt(scelte), { json: true });
          await db.query('UPDATE pm_associazioni SET batch_id = $2 WHERE id = $1', [rich.id, b.batchId]);
          report.inviati++;
        }
      } catch (e) {
        await db.query(`UPDATE pm_associazioni SET stato = 'errore', errore = $2, concluso_il = now() WHERE id = $1`, [rich.id, String(e.message).slice(0, 1000)]);
        if (isBatchNonDisponibile(e)) {
          // Gemini gratuito (o piano senza Batch): niente associazione, si avvisa e si passa
          // all'utente successivo (gli altri progetti darebbero lo stesso errore).
          await notifica(u, 'batch', 'Associazione To-Do e RAID non eseguita',
            `${e.message.replace(/, eseguito in modalità Immediata$/, '')}. L'associazione automatica usa sempre il Batch: scegli un'altra AI (o Projexa, gratuita) in Impostazioni › AI › «Associazione automatica To-Do e RAID».`);
          report.errori.push(`${u.user_id}: Batch non disponibile (${ai})`);
          break;
        }
        report.errori.push(`${u.user_id} progetto ${projectId}: ${e.message}`);
        if (e.status === 428 || e.status === 400) {
          await notifica(u, 'chiave', 'Associazione To-Do e RAID non eseguita', e.message);
          break;
        }
      }
    }
  }
}

// 3. Insegnante (Analisi PM › Associazioni): lo stesso compito, senza i casi d'esempio, all'AI
//    della pagina Analisi PM. Gemini subito, ChatGPT in Batch raccolto ai giri successivi. La
//    risposta serve solo al confronto: non collega niente.
async function insegnante(report) {
  let righe;
  try {
    righe = (await db.query(
      `SELECT id, tenant_id::text AS tenant_id, user_id::text AS user_id, elenco, insegnante_ai, insegnante_stato,
              insegnante_batch_id, created_at
         FROM pm_associazioni WHERE insegnante_stato IN ('da_inviare', 'inviato') ORDER BY created_at`)).rows;
  } catch (e) {
    if (e.code === '42703') return; // analisi_associazioni.sql non eseguito
    throw e;
  }
  const salva = async (id, ai, testo) => {
    leggiGruppi(testo); // risposta senza JSON = errore
    await db.query(`UPDATE pm_associazioni SET insegnante_ai = $2, insegnante_stato = 'pronto', insegnante_risposta = $3, insegnante_errore = NULL WHERE id = $1`,
      [id, ai, encryptValue(String(testo).slice(0, 20000))]);
    report.insegnante++;
  };
  for (const a of righe) {
    try {
      if (a.insegnante_stato === 'da_inviare') {
        const ai = await aiScelta(a);
        const compito = prompt(JSON.parse(a.elenco));
        if (ai === 'ChatGPT') {
          const b = await inviaBatchAi(a.user_id, 'ChatGPT', compito, { json: true });
          await db.query(`UPDATE pm_associazioni SET insegnante_ai = $2, insegnante_stato = 'inviato', insegnante_batch_id = $3 WHERE id = $1`, [a.id, ai, b.batchId]);
        } else {
          await salva(a.id, ai, (await askAiProvider(a.user_id, 'Gemini', compito, { json: true })).text);
        }
        continue;
      }
      const s = await statoBatchAi(a.user_id, a.insegnante_ai || 'ChatGPT', a.insegnante_batch_id);
      if (s.stato === 'in_corso') {
        if (Date.now() - new Date(a.created_at).getTime() > SCADENZA_BATCH_ORE * 3600000) throw new Error('nessuna risposta del Batch entro 26 ore');
        continue;
      }
      if (s.stato !== 'pronto') throw new Error(s.errore || 'Batch non riuscito');
      await salva(a.id, a.insegnante_ai || 'ChatGPT', s.text);
    } catch (e) {
      report.errori.push(`insegnante ${a.id}: ${e.message}`);
      await db.query(`UPDATE pm_associazioni SET insegnante_stato = 'errore', insegnante_errore = $2 WHERE id = $1`, [a.id, String(e.message).slice(0, 1000)]);
    }
  }
}

export async function eseguiAssociaTodoRaid() {
  const report = { inviati: 0, locali: 0, raccolti: 0, inAttesa: 0, collegate: 0, saltati: 0, insegnante: 0, issueDoppie: 0, errori: [] };
  const esiti = [];
  await raccogli(report, esiti);
  try { await riprendiLocali(report, esiti); } catch (e) { report.errori.push(`ripresa Projexa: ${e.message}`); }
  await invia(report, esiti);
  try { await insegnante(report); } catch (e) { report.errori.push(`insegnante: ${e.message}`); }
  try { await completaDescrizioni(report); } catch (e) { report.errori.push(`descrizioni «Collegato a»: ${e.message}`); }
  // Issue doppie dello stesso cliente (jobs/issueDoppie.js, 2026-10-26): stessa AI, a ogni giro.
  try {
    const utenti = (await utentiAttivi()).map((u) => ({ ...u, aiNome: /^projexa/i.test(u.ai) ? 'Projexa' : AI[u.ai.toLowerCase()] })).filter((u) => u.aiNome);
    await controllaIssueDoppie(utenti, report);
  } catch (e) { report.errori.push(`issue doppie: ${e.message}`); }
  await notificaEsiti(esiti);
  const testo = `Batch inviati ${report.inviati}, Projexa ${report.locali}, risultati raccolti ${report.raccolti}, in attesa ${report.inAttesa}, voci collegate ${report.collegate}${report.insegnante ? `, risposte dell'insegnante ${report.insegnante}` : ''}${report.issueDoppie ? `, Issue doppie messe in revisione ${report.issueDoppie}` : ''}${report.saltati ? `, utenti con AI non utilizzabile ${report.saltati}` : ''}${report.errori.length ? ` · errori: ${report.errori.slice(0, 5).join(' | ')}` : ''}`;
  console.log(`[ASSOCIAZIONE] ${testo}`);
  // ok:false = esito «errori» nella pagina Schedulazioni (dettaglio in ultimo_report).
  return { ok: report.errori.length === 0, riepilogo: testo, ...report };
}

// Per le prove: voci candidate e prompt di un utente, senza chiamare l'AI né scrivere nulla.
export async function anteprimaAssociazione(u) {
  const perProgetto = new Map();
  for (const v of await vociAperte(u)) {
    if (!perProgetto.has(v.project_id)) perProgetto.set(v.project_id, []);
    perProgetto.get(v.project_id).push(v);
  }
  return [...perProgetto].map(([projectId, voci]) => {
    const scelte = candidate(voci).slice(0, MAX_VOCI);
    return { projectId, aperte: voci.length, candidate: scelte.length, prompt: scelte.length >= 2 ? prompt(scelte) : null, scelte };
  });
}
