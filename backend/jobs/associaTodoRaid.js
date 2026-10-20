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
// ============================================================================
import db from '../config/database.js';
import notifDb from '../config/notifDatabase.js';
import { encryptValue } from '../config/crypto.js';
import { inviaBatchAi, statoBatchAi, isBatchNonDisponibile, ollamaPost } from '../routes/ai.js';
import { nomiClientiProgetti } from './notifiche.js';

const CAMPO = 'associazione autom. todolist e raid';
const AI = { chatgpt: 'chatgpt', gpt: 'chatgpt', claude: 'claude', gemini: 'gemini', mistral: 'mistral' };
const CONFIDENZA_MIN = 80;     // sotto, l'abbinamento non si scrive
const MAX_VOCI = 60;           // voci per richiesta (un progetto)
const ORA_ULTIMO_INVIO = 9;    // dopo le 9 si invia solo a chi oggi non ha ancora avuto un invio (vedi invia)
const SCADENZA_BATCH_ORE = 26; // i fornitori garantiscono la risposta entro 24 ore
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODELLO = process.env.OLLAMA_RECAP_MODEL || 'qwen2.5:7b';

const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const oraRoma = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
const corto = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const REGISTRI = { todo: 'To-Do', rischio: 'Rischio', decisione: 'Decisione', dipendenza: 'Dipendenza', assunzione: 'Assunzione' };
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

export function prompt(voci) {
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

VOCI:
${JSON.stringify(elenco, null, 0)}`;
}

// JSON della risposta (anche se l'AI aggiunge testo o ```json intorno).
function leggiGruppi(testo) {
  const t = String(testo || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('risposta dell\'AI senza JSON');
  const j = JSON.parse(m[0]);
  return Array.isArray(j.gruppi) ? j.gruppi : [];
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
    collegate += valide.length;
    righe.push(`${valide.map((v) => `${REGISTRI[v.registro] || v.registro} «${corto(v.titolo, 60)}»`).join(' ↔ ')}`);
  }
  return { collegate, righe };
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
      WHERE lower(btrim(campo)) IN ($1, '(*) ' || $1)
        AND coalesce(btrim(valore2), '') <> ''
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY tenant_id, user_id, id`, [CAMPO])).rows;
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
    const locale = nome === 'projexa';
    const ai = AI[nome];
    if (!locale && !ai) {
      await notifica(u, 'ai', 'Associazione To-Do e RAID non eseguita',
        `«${u.ai}» non è utilizzabile per l'associazione automatica: scegli ChatGPT, Claude, Gemini (a pagamento), Mistral o Projexa in Impostazioni › AI › «Associazione Autom. ToDoList e RAID».`);
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
      const rich = (await db.query(
        `INSERT INTO pm_associazioni (tenant_id, user_id, client_id, project_id, giorno, ai, voci, ordine)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, user_id, project_id, giorno) DO NOTHING
         RETURNING id, project_id::text AS project_id, client_id::text AS client_id`,
        [u.tenant_id, u.user_id, scelte.find((v) => v.client_id)?.client_id || null, projectId, giorno, locale ? 'Projexa' : ai, scelte.length,
         scelte.map((v) => `${v.tabella}|${v.id}`)])).rows[0];
      if (!rich) continue;
      try {
        if (locale) {
          // Projexa: Ollama della VM, subito (gratuito, niente Batch).
          const r = await ollamaPost(`${OLLAMA_URL}/api/chat`, {
            model: OLLAMA_MODELLO, stream: false, format: 'json', keep_alive: '10m',
            messages: [{ role: 'user', content: prompt(scelte) }],
            options: { num_ctx: 8192, temperature: 0, num_predict: 800 }
          }, 20 * 60000);
          if (!r.ok) throw new Error((r.data && r.data.error) || `Ollama: errore ${r.status}`);
          report.collegate += await chiudiRichiesta(rich, u, scelte, r.data && r.data.message && r.data.message.content, esiti);
          report.locali++;
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
            `${e.message.replace(/, eseguito in modalità Immediata$/, '')}. L'associazione automatica usa sempre il Batch: scegli un'altra AI (o Projexa, gratuita) in Impostazioni › AI › «Associazione Autom. ToDoList e RAID».`);
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

export async function eseguiAssociaTodoRaid() {
  const report = { inviati: 0, locali: 0, raccolti: 0, inAttesa: 0, collegate: 0, saltati: 0, errori: [] };
  const esiti = [];
  await raccogli(report, esiti);
  await invia(report, esiti);
  await notificaEsiti(esiti);
  const testo = `Batch inviati ${report.inviati}, Projexa ${report.locali}, risultati raccolti ${report.raccolti}, in attesa ${report.inAttesa}, voci collegate ${report.collegate}${report.saltati ? `, utenti con AI non utilizzabile ${report.saltati}` : ''}${report.errori.length ? ` · errori: ${report.errori.slice(0, 5).join(' | ')}` : ''}`;
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
