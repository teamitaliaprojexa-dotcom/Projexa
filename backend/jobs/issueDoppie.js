// ============================================================================
// ISSUE DOPPIE DELLO STESSO CLIENTE (giro del job «associa_todo_raid», 2026-10-26)
// ----------------------------------------------------------------------------
// L'Add-in Outlook crea le Issue dalle segnalazioni dell'email e scarta i doppioni solo se la
// descrizione è molto simile: rilanciando la stessa email l'AI la riscrive con parole diverse e
// nasce una seconda Issue (MIROGLIO SPA, 2026-10-26). A ogni giro del job le Issue APERTE di un
// cliente che hanno qualcosa in comune (stesso ticket, stessa email d'origine, parole) vanno
// all'AI scelta per l'associazione To-Do e RAID, che dice quali sono la stessa segnalazione e
// quale è la più completa (master). Allora:
//   - sulla master si riportano i campi vuoti compilati sull'altra (progetto, modulo, richiedente,
//     owner, MySupport, Jira, deadline) e in fondo alla descrizione le informazioni in più;
//   - l'altra passa a «In revisione», con il motivo nelle note: la elimina il PM se è un doppione;
//   - notifica (campanella) sulla Issue in revisione.
// Ogni coppia valutata si salva in issue_doppioni (Supporto/CreaDB/issue_doppioni.sql): non torna
// più all'AI, anche se il PM rimette «Aperto» perché non erano doppioni.
// AI: chiamata immediata (non Batch: poche Issue, e il doppione va segnalato in giornata);
// «Projexa» = Ollama della VM.
// ============================================================================
import db from '../config/database.js';
import notifDb from '../config/notifDatabase.js';
import { encryptValue, encryptRowForWrite } from '../config/crypto.js';
import { askAiProvider, ollamaPost, ollamaConPrecedenza, senzaRagionamento } from '../routes/ai.js';
import { nomiClientiProgetti } from './notifiche.js';

export const STATO_REVISIONE = 'In revisione';
const CONFIDENZA_MIN = 80;
const MAX_ISSUE = 30; // Issue per richiesta (un cliente)
const CAMPI_DA_COMPLETARE = ['project_id', 'modulo', 'richiedente', 'owner', 'mysupport', 'tkt_jira', 'deadline'];
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODELLO = process.env.OLLAMA_ASSOCIAZIONI_MODEL || process.env.OLLAMA_FUNZIONI_14B_MODEL || 'qwen3:14b';

const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const giorno = (d) => (d ? new Date(d).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }) : '');
const corto = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const vuoto = (v) => v === null || v === undefined || String(v).trim() === '';
// Come l'Add-in Outlook (chiusa): «In revisione» non è chiusa ma è già in mano al PM.
const aperta = (stato) => !/chius|risolt|annull|complet|done|closed|resolved|revisione/i.test(String(stato || ''));

// Parole significative ridotte alla radice (6 lettere): «anagrafica» e «anagrafiche» coincidono.
const VUOTE = new Set(['della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'sulla', 'sulle', 'questo', 'questa', 'anche', 'perché', 'quindi', 'essere', 'fare', 'cliente', 'teamsystem', 'errore', 'problema', 'segnalato', 'segnalate', 'segnalati', 'circa', 'tutti', 'entro']);
const radici = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-zà-ú0-9 ]+/gi, ' ').split(/\s+/)
  .filter((w) => w.length >= 4 && !VUOTE.has(w)).map((w) => w.slice(0, 6)));
const codici = (t) => new Set(String(t || '').toUpperCase().match(/[A-Z0-9][A-Z0-9-]{3,}/g) || []);
// Email d'origine scritta nelle note dall'Add-in («…dall'email di X del gg/mm/aaaa, oggetto «…»»).
const emailOrigine = (note) => { const m = String(note || '').match(/dall'email di (.+)$/m); return m ? m[1].trim().toLowerCase() : ''; };

// Coppie plausibili: stesso ticket, stessa email d'origine, ≥2 radici in comune nella
// descrizione, oppure stessa data di segnalazione e ≥1 radice.
export function coppieCandidate(issue) {
  const R = issue.map((x) => radici(x.descrizione));
  const out = [];
  for (let i = 0; i < issue.length; i++) {
    for (let j = i + 1; j < issue.length; j++) {
      const a = issue[i]; const b = issue[j];
      let comuni = 0;
      for (const w of R[i]) if (R[j].has(w)) comuni++;
      const stessoTicket = ['mysupport', 'tkt_jira'].some((f) => [...codici(a[f])].some((c) => codici(b[f]).has(c)));
      const stessaEmail = emailOrigine(a.note) && emailOrigine(a.note) === emailOrigine(b.note);
      const stessoGiorno = a.data_segnalazione && giorno(a.data_segnalazione) === giorno(b.data_segnalazione);
      if (stessoTicket || stessaEmail || comuni >= 2 || (stessoGiorno && comuni >= 1)) out.push([a, b]);
    }
  }
  return out;
}

const chiaveCoppia = (a, b) => (a.id < b.id ? [a.id, b.id] : [b.id, a.id]);

export function prompt(issue) {
  const elenco = issue.map((x, i) => ({
    n: i + 1, data: giorno(x.data_segnalazione), categoria: x.categoria, priorita: x.priorita, stato: x.stato,
    descrizione: corto(x.descrizione, 700), progetto: vuoto(x.project_id) ? 'no' : 'sì', modulo: vuoto(x.modulo) ? 'no' : 'sì',
    richiedente: vuoto(x.richiedente) ? 'no' : 'sì', owner: vuoto(x.owner) ? 'no' : 'sì',
    mysupport: x.mysupport || null, jira: x.tkt_jira || null, deadline: giorno(x.deadline) || null, note: corto(x.note, 250) || null
  }));
  return `Sei un project manager. Queste sono le Issue APERTE di un solo cliente. A volte la stessa segnalazione è stata inserita due volte (per esempio la stessa email elaborata due volte), descritta con parole e dettagli diversi.

Trova i GRUPPI di Issue che sono la STESSA segnalazione: stesso problema o stessa richiesta, anche se una descrizione aggiunge dettagli che l'altra non ha. NON raggruppare Issue che riguardano lo stesso modulo o argomento ma problemi diversi. Nel dubbio NON raggruppare: la Issue scartata finisce in revisione per essere eliminata.
Per ogni gruppo scegli la "master": la più completa (descrizione più chiara e dettagliata, più campi compilati: progetto, modulo, richiedente, owner, ticket MySupport/Jira, deadline).
In "integrazione" scrivi in una o due frasi le informazioni presenti nelle descrizioni delle altre Issue del gruppo e ASSENTI in quella della master ("" se non ce ne sono).

Rispondi SOLO con JSON in questa forma:
{"gruppi":[{"issue":[1,3],"master":1,"confidenza":90,"motivo":"breve spiegazione","integrazione":""}]}
confidenza da 0 a 100 (100 = certamente la stessa segnalazione). Se non ci sono doppioni: {"gruppi":[]}

ISSUE:
${JSON.stringify(elenco, null, 0)}`;
}

export function leggiGruppi(testo) {
  const m = String(testo || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('risposta dell\'AI senza JSON');
  const j = JSON.parse(m[0]);
  return Array.isArray(j.gruppi) ? j.gruppi : [];
}

async function chiediAi(u, aiNome, testo) {
  if (aiNome === 'Projexa') {
    const r = await ollamaConPrecedenza([OLLAMA_MODELLO], (model, signal) => ollamaPost(`${OLLAMA_URL}/api/chat`, {
      model, stream: false, format: 'json', think: false, keep_alive: '10m',
      messages: [{ role: 'user', content: testo }],
      options: { num_ctx: 8192, temperature: 0, num_predict: 800 }
    }, 20 * 60000, { signal }));
    if (!r.ok) throw new Error((r.data && r.data.error) || `Ollama: errore ${r.status}`);
    return senzaRagionamento(r.data && r.data.message && r.data.message.content);
  }
  return (await askAiProvider(u.user_id, aiNome, testo, { json: true })).text;
}

async function issueAperte(u) {
  return (await db.query(
    `SELECT id::text AS id, client_id::text AS client_id, project_id::text AS project_id, modulo::text AS modulo,
            richiedente::text AS richiedente, data_segnalazione, descrizione, categoria, stato, priorita, owner,
            mysupport, tkt_jira, deadline, note
       FROM issue
      WHERE tenant_id = $1 AND user_id = $2 AND data_chiusura IS NULL
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`, [u.tenant_id, u.user_id])).rows
    .filter((x) => aperta(x.stato));
}

async function scrivi(u, id, set) {
  const { data } = await encryptRowForWrite(db, 'issue', set, { id });
  const cols = Object.keys(data);
  await db.query(`UPDATE issue SET ${cols.map((c, i) => `"${c}" = $${i + 4}`).join(', ')}
                   WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
  [id, u.tenant_id, u.user_id, ...cols.map((c) => data[c])]);
}

async function notifica(u, issueId, titolo, messaggio) {
  try {
    await notifDb.query(
      `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id, chiave_dedup)
       VALUES ($1, $2, 'ai', $3, $4, 'issue', $5, $6)
       ON CONFLICT (tenant_id, user_id, chiave_dedup) WHERE chiave_dedup IS NOT NULL
       DO UPDATE SET titolo = EXCLUDED.titolo, messaggio = EXCLUDED.messaggio, letta = false, letta_il = NULL, aggiornata_il = now()`,
      [u.tenant_id, u.user_id, encryptValue(titolo), encryptValue(String(messaggio).slice(0, 2000)), issueId, `ai|issue_doppia|${issueId}`]
    );
  } catch (e) {
    console.error(`[ISSUE DOPPIE] notifica non creata per ${u.user_id}: ${e.message}`);
  }
}

// Master completata con l'altra, altra «In revisione», notifica. Le Issue si rileggono: l'AI
// lavora su una fotografia e nel frattempo il PM può averle chiuse.
async function unisci(u, master, altre, g, clienteNome) {
  const attuali = new Map((await issueAperte(u)).map((x) => [x.id, x]));
  const m = attuali.get(master.id);
  const doppie = altre.map((x) => attuali.get(x.id)).filter(Boolean);
  if (!m || !doppie.length) return 0;
  const set = {};
  for (const f of CAMPI_DA_COMPLETARE) {
    const da = doppie.find((x) => vuoto(m[f]) && !vuoto(x[f]));
    if (da) set[f] = da[f];
  }
  const integrazione = corto(g.integrazione, 1000);
  if (integrazione) set.descrizione = `${m.descrizione || ''}\n\n[Integrato dal doppione, Projexa ${giorno(new Date())}] ${integrazione}`.trim();
  const campi = Object.keys(set).map((f) => ({ project_id: 'progetto', tkt_jira: 'Jira', mysupport: 'MySupport', descrizione: 'descrizione' }[f] || f));
  if (Object.keys(set).length) await scrivi(u, m.id, set);
  for (const d of doppie) {
    const nota = `[Projexa ${giorno(new Date())}] Possibile doppione dell'Issue «${corto(m.descrizione, 120)}» (tenuta come principale: ${corto(g.motivo, 300)}). Se è un doppione eliminala.`;
    await scrivi(u, d.id, { stato: STATO_REVISIONE, note: `${nota}${d.note ? `\n${d.note}` : ''}`.slice(0, 4000) });
    await notifica(u, d.id, `Issue doppia: ${clienteNome || 'cliente'}`,
      `«${corto(d.descrizione, 200)}» sembra la stessa segnalazione di «${corto(m.descrizione, 200)}».\nQuesta è passata a «${STATO_REVISIONE}»: se è un doppione eliminala.${campi.length ? ` Sull'altra ho completato: ${campi.join(', ')}.` : ''}`);
  }
  return doppie.length;
}

async function registra(u, clientId, coppie, ai, esito = () => ({})) {
  for (const [a, b] of coppie) {
    const [x, y] = chiaveCoppia(a, b);
    const e = esito(x, y);
    await db.query(
      `INSERT INTO issue_doppioni (tenant_id, user_id, client_id, issue_a, issue_b, esito, master_id, confidenza, motivo, ai)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (tenant_id, issue_a, issue_b) DO NOTHING`,
      [u.tenant_id, u.user_id, clientId, x, y, e.esito || 'diverse', e.master || null, e.confidenza ?? null,
        e.motivo ? encryptValue(corto(e.motivo, 500)) : null, ai]);
  }
}

// utenti: quelli dell'associazione To-Do e RAID ({ tenant_id, user_id, ai }), aiNome già risolto.
export async function controllaIssueDoppie(utenti, report) {
  try {
    await db.query('SELECT 1 FROM issue_doppioni LIMIT 0');
  } catch (e) {
    if (e.code === '42P01') return; // issue_doppioni.sql non ancora eseguito
    throw e;
  }
  for (const u of utenti) {
    const valutate = new Set((await db.query('SELECT issue_a::text AS a, issue_b::text AS b FROM issue_doppioni WHERE tenant_id = $1 AND user_id = $2',
      [u.tenant_id, u.user_id])).rows.map((r) => `${r.a}|${r.b}`));
    const perCliente = new Map();
    for (const x of await issueAperte(u)) {
      if (!perCliente.has(x.client_id)) perCliente.set(x.client_id, []);
      perCliente.get(x.client_id).push(x);
    }
    for (const [clientId, tutte] of perCliente) {
      const nuove = coppieCandidate(tutte).filter(([a, b]) => !valutate.has(chiaveCoppia(a, b).join('|')));
      if (!nuove.length) continue;
      const ids = new Set(nuove.flat().map((x) => x.id));
      const issue = tutte.filter((x) => ids.has(x.id)).slice(0, MAX_ISSUE);
      const dentro = new Set(issue.map((x) => x.id));
      const coppie = nuove.filter(([a, b]) => dentro.has(a.id) && dentro.has(b.id));
      let gruppi;
      try {
        gruppi = leggiGruppi(await chiediAi(u, u.aiNome, prompt(issue)));
      } catch (e) {
        // Niente registrato: si riprova al giro successivo. Chiave mancante = inutile insistere.
        report.errori.push(`issue doppie ${u.user_id} cliente ${clientId}: ${e.message}`);
        if (e.status === 428 || e.status === 400) break;
        continue;
      }
      const { clienti } = await nomiClientiProgetti([clientId], []);
      const esiti = new Map(); // «a|b» -> esito della coppia
      const usate = new Set(); // una Issue in un solo gruppo
      for (const g of gruppi) {
        const conf = Number(g && g.confidenza) || 0;
        const n = [...new Set((Array.isArray(g && g.issue) ? g.issue : []).map(Number))].filter((k) => Number.isInteger(k) && k >= 1 && k <= issue.length);
        const master = Number(g && g.master);
        if (conf < CONFIDENZA_MIN || n.length < 2 || !n.includes(master) || n.some((k) => usate.has(k))) continue;
        n.forEach((k) => usate.add(k));
        const m = issue[master - 1];
        const altre = n.filter((k) => k !== master).map((k) => issue[k - 1]);
        for (let i = 0; i < n.length; i++) {
          for (let j = i + 1; j < n.length; j++) {
            esiti.set(chiaveCoppia(issue[n[i] - 1], issue[n[j] - 1]).join('|'), { esito: 'doppione', master: m.id, confidenza: conf, motivo: g.motivo });
          }
        }
        report.issueDoppie += await unisci(u, m, altre, g, clienti.get(String(clientId)));
        console.log(`[ISSUE DOPPIE] master «${corto(m.descrizione, 50)}» ← ${altre.map((x) => `«${corto(x.descrizione, 50)}»`).join(', ')}`);
      }
      await registra(u, clientId, coppie, u.aiNome, (x, y) => esiti.get(`${x}|${y}`) || {});
      // Coppie con una Issue rimasta fuori (oltre MAX_ISSUE): al giro successivo.
    }
  }
}
