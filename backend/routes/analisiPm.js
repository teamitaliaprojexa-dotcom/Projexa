// ============================================================================
// ANALISI PM (pagina sito/analisi-pm.html, 2026-10-20) - solo utenti in ANALISI_PM_EMAILS
// ----------------------------------------------------------------------------
//   - segno «Analisi PM» sulla riunione (finestra della trascrizione): GET/POST /flag;
//   - AI dell'analisi notturna (Gemini gratuito / ChatGPT Batch): GET/PUT /impostazioni;
//   - domande proposte dal job (jobs/analisiPm.js) da valutare: GET /domande, PUT /domande/:id;
//   - download del file per l'addestramento (JSONL) e del notebook di Google Colab;
//   - domande corrette subito come esempi di Pm projexa (pm_projexa_esempi): POST /esempi;
//   - Analisi Recap (insegnante notturno di recap-projexa, jobs/analisiRecap.js): /recap/...;
//   - Analisi Associazioni (insegnante dell'associazione To-Do e RAID, jobs/associaTodoRaid.js):
//     confronto Projexa / AI insegnante, gruppi giusti e sbagliati, file per assoc-projexa-14b;
//   - modello addestrato (adattatore LoRA .gguf) caricato su Ollama della VM con backup del
//     precedente, ripristino ed eliminazione dei backup: /modelli...
// ============================================================================
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { encryptRowForWrite, encryptValue } from '../config/crypto.js';
import { analisiPmAbilitata, pezzi, aiScelta, AI_AMMESSE, FORMATO_RE } from '../jobs/analisiPm.js';
import { prompt as promptAssoc, gruppiDa, vociDaChiavi, collegaVoci, scollegaVoci, REGISTRI, OLLAMA_ADDESTRATO } from '../jobs/associaTodoRaid.js';
import { nomiClientiProgetti } from '../jobs/notifiche.js';
import { TIPI as TIPI_RECAP } from '../jobs/analisiRecap.js';
import { proponiRevisione, applicaProposta } from '../jobs/revisionePrompt.js';
import { istruzioniRecapProjexa } from './ai.js';
import { pmProjexaInCorso } from '../config/ollamaPrecedenza.js';
import { getPromptFor } from '../config/prompts.js';

const router = express.Router();
const QUI = path.dirname(fileURLToPath(import.meta.url));
const NOTEBOOK = path.join(QUI, '..', 'prompts', 'colab_pm_projexa.ipynb');
const NOTEBOOK_FILTRO = path.join(QUI, '..', 'prompts', 'colab_pm_projexa_filtro.ipynb');
const NOTEBOOK_RECAP = path.join(QUI, '..', 'prompts', 'colab_recap_projexa.ipynb');
const NOTEBOOK_RECAP_14B = path.join(QUI, '..', 'prompts', 'colab_recap_projexa_14b.ipynb');
const NOTEBOOK_ASSOC = path.join(QUI, '..', 'prompts', 'colab_assoc_projexa_14b.ipynb');
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODELLO = process.env.OLLAMA_PM_MODEL || 'pm-projexa';
const MODELLO_RECAP = process.env.OLLAMA_RECAP_PROJEXA_MODEL || 'recap-projexa';
const BASE = process.env.OLLAMA_RECAP_MODEL || 'qwen3:8b';
// Base del 14B (Qwen3, 2026-10-20) per recap-projexa-14b addestrato.
const BASE_14B = process.env.OLLAMA_FUNZIONI_14B_MODEL || 'qwen3:14b';
const MODELLO_RECAP_14B = process.env.OLLAMA_RECAP_PROJEXA_14B_MODEL || 'recap-projexa-14b';
// Filtro veloce addestrato dell'Assistente PM (voce «Projexa 4B + 8B», 2026-10-21).
const MODELLO_FILTRO = process.env.OLLAMA_PM_FILTRO_4B_MODEL || 'pm-projexa-filtro';
const BASE_FILTRO = process.env.OLLAMA_PM_FILTRO_4B_BASE || 'qwen3:4b-instruct';
const CARTELLA_MODELLI = process.env.OLLAMA_MODELLI_DIR || path.join(os.homedir(), 'projexa-modelli');
const MAX_ADATTATORE = 1.5 * 1024 * 1024 * 1024; // 1,5 GB
const PEZZO_UPLOAD = 16 * 1024 * 1024;           // ogni parte del file caricato
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errore = (status, msg) => Object.assign(new Error(msg), { status });
const rispondiErrore = (res, e, cosa) => {
  if (!e.status) console.error(`❌ [ANALISI PM] ${cosa}:`, e.message);
  res.status(e.status || 500).json({ error: e.code === '42P01' ? 'Analisi PM non attiva: manca Supporto/CreaDB/analisi_pm.sql' : e.message });
};

// Configurazione per la dashboard (voce di menu e pulsante nella trascrizione).
router.get('/config', requireAuth, (req, res) => res.json({ abilitato: analisiPmAbilitata(req.user.email) }));

// Da qui in poi solo gli utenti abilitati.
router.use(requireAuth, (req, res, next) => (analisiPmAbilitata(req.user.email)
  ? next() : res.status(403).json({ error: 'Analisi PM non abilitata per il tuo utente' })));
const chi = (req) => [req.user.tenant_id, req.user.user_id];

// --- Segno sulla riunione -------------------------------------------------------------------
router.get('/flag', async (req, res) => {
  try {
    const id = String(req.query.id_calendar || '').slice(0, 300);
    const m = (await db.query('SELECT analisi_pm FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3', [...chi(req), id])).rows[0];
    const a = (await db.query('SELECT stato, completata_il FROM pm_analisi_riunioni WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3', [...chi(req), id])).rows[0];
    res.json({ flag: !!(m && m.analisi_pm), stato: a ? a.stato : null, completata_il: a ? a.completata_il : null, ai: await aiScelta(req.user) });
  } catch (e) { rispondiErrore(res, e, 'flag'); }
});
router.post('/flag', async (req, res) => {
  try {
    const id = String((req.body || {}).id_calendar || '').slice(0, 300);
    const r = await db.query('UPDATE rec_meeting SET analisi_pm = $4 WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
      [...chi(req), id, !!req.body.flag]);
    if (!r.rowCount) throw errore(404, 'Riunione non trovata');
    res.json({ ok: true, flag: !!req.body.flag });
  } catch (e) { rispondiErrore(res, e, 'flag'); }
});

// --- Impostazioni e stato delle analisi -----------------------------------------------------
router.get('/impostazioni', async (req, res) => {
  try {
    const riunioni = (await db.query(
      `SELECT m.id_calendar, m.oggetto, m.data_calendar::text AS data, m.analisi_pm AS segnata,
              a.ai, a.stato, a.pezzi_tot, a.prossimo_da, a.errore, a.completata_il, a.updated_at,
              (SELECT count(*)::int FROM pm_analisi d WHERE d.tenant_id = m.tenant_id AND d.user_id = m.user_id AND d.id_calendar = m.id_calendar) AS domande,
              (SELECT count(*)::int FROM pm_analisi d WHERE d.tenant_id = m.tenant_id AND d.user_id = m.user_id AND d.id_calendar = m.id_calendar AND d.esito IS NULL) AS da_valutare
         FROM rec_meeting m
         LEFT JOIN pm_analisi_riunioni a ON a.tenant_id = m.tenant_id AND a.user_id = m.user_id AND a.id_calendar = m.id_calendar
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND (m.analisi_pm OR a.id IS NOT NULL)
        ORDER BY m.data_calendar DESC NULLS LAST LIMIT 200`, chi(req))).rows;
    const job = (await db.query(`SELECT attivo, prossima_esecuzione, ultima_esecuzione, ultimo_esito FROM job_schedules WHERE job = 'analisi_pm' LIMIT 1`)).rows[0] || null;
    res.json({ ai: await aiScelta(req.user), aiAmmesse: AI_AMMESSE, riunioni, job });
  } catch (e) { rispondiErrore(res, e, 'impostazioni'); }
});
router.put('/impostazioni', async (req, res) => {
  try {
    const ai = String((req.body || {}).ai || '');
    if (!AI_AMMESSE.includes(ai)) throw errore(400, 'AI non valida');
    await db.query(
      `INSERT INTO pm_analisi_config (tenant_id, user_id, ai) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET ai = EXCLUDED.ai, updated_at = now()`, [...chi(req), ai]);
    res.json({ ok: true, ai });
  } catch (e) { rispondiErrore(res, e, 'impostazioni'); }
});

// --- Domande da valutare --------------------------------------------------------------------
// esito: 'da' (da valutare) | 'corretta' | 'errata' | '' (tutte); id_calendar facoltativo.
router.get('/domande', async (req, res) => {
  try {
    const p = [...chi(req)];
    let filtro = '';
    const esito = String(req.query.esito || '');
    if (esito === 'da') filtro += ' AND d.esito IS NULL';
    else if (esito === 'corretta' || esito === 'errata') { p.push(esito); filtro += ` AND d.esito = $${p.length}`; }
    if (req.query.mancate === '1') filtro += ' AND d.fatta = false';
    if (req.query.id_calendar) { p.push(String(req.query.id_calendar)); filtro += ` AND d.id_calendar = $${p.length}`; }
    const r = await db.query(
      `SELECT d.id, d.id_calendar, d.pezzo, d.ai, d.segnale, d.fatta, d.tratto, d.suggerimento, d.testo_corretto, d.esito,
              m.oggetto, m.data_calendar::text AS data
         FROM pm_analisi d
         LEFT JOIN rec_meeting m ON m.tenant_id = d.tenant_id AND m.user_id = d.user_id AND m.id_calendar = d.id_calendar
        WHERE d.tenant_id = $1 AND d.user_id = $2 ${filtro}
        ORDER BY m.data_calendar DESC NULLS LAST, d.id_calendar, d.pezzo LIMIT 500`, p);
    res.json({ domande: r.rows });
  } catch (e) { rispondiErrore(res, e, 'domande'); }
});

// Valutazione: { esito: 'corretta' | 'errata' | null, testo_corretto } (testo nel formato «DOMANDA [n]: …»).
router.put('/domande/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) throw errore(400, 'Id non valido');
    const b = req.body || {};
    const esito = b.esito === 'corretta' || b.esito === 'errata' ? b.esito : null;
    let testo = String(b.testo_corretto || '').replace(/\s+/g, ' ').trim();
    if (testo && !FORMATO_RE.test(testo)) throw errore(400, 'La domanda corretta deve essere nel formato «DOMANDA [n]: frase»');
    const { data } = await encryptRowForWrite(db, 'pm_analisi', { testo_corretto: testo || null });
    const r = await db.query(
      `UPDATE pm_analisi SET esito = $4, testo_corretto = $5, updated_at = now()
        WHERE id = $3 AND tenant_id = $1 AND user_id = $2`, [...chi(req), req.params.id, esito, data.testo_corretto]);
    if (!r.rowCount) throw errore(404, 'Domanda non trovata');
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, 'valutazione'); }
});

// --- File per l'addestramento ---------------------------------------------------------------
// Istruzioni brevi messe in ogni esempio (le regole complete restano nel prompt PM_PROJEXA,
// che Projexa manda a ogni call: il modello addestrato impara il comportamento).
const SISTEMA = 'Sei «Pm projexa», project manager senior di progetti HR TeamSystem. Durante la riunione ricevi un tratto di trascrizione e suggerisci al project manager UNA domanda o un punto da far notare adesso, nel formato "PAROLA [n]: frase" (PAROLA = DOMANDA, RISCHIO, CR, ATTENZIONE o AGENDA; n = segnale 1-13), oppure rispondi "Nessun suggerimento." se non serve.';
const utenteMsg = (tratto) => `TRASCRIZIONE (nuovo tratto della riunione):\n${tratto}`;

// Esempi: domande corrette (testo corretto se scritto) + «Nessun suggerimento.» per le errate e
// per una parte dei pezzi senza domanda (fino a 1,5 volte le corrette), dalle riunioni analizzate.
async function esempiAddestramento(req) {
  const valutate = (await db.query(
    `SELECT id_calendar, pezzo, tratto, suggerimento, testo_corretto, esito FROM pm_analisi
      WHERE tenant_id = $1 AND user_id = $2 AND esito IS NOT NULL`, chi(req))).rows;
  const corrette = valutate.filter((x) => x.esito === 'corretta');
  const out = corrette.map((x) => ({ tratto: x.tratto, risposta: x.testo_corretto || x.suggerimento }));
  out.push(...valutate.filter((x) => x.esito === 'errata').map((x) => ({ tratto: x.tratto, risposta: 'Nessun suggerimento.' })));
  // Pezzi senza domanda delle riunioni con almeno una valutazione.
  const conDomanda = new Set(valutate.map((x) => `${x.id_calendar}|${x.pezzo}`));
  const tutteDomande = new Set((await db.query('SELECT id_calendar, pezzo FROM pm_analisi WHERE tenant_id = $1 AND user_id = $2', chi(req))).rows.map((x) => `${x.id_calendar}|${x.pezzo}`));
  const riunioni = [...new Set(valutate.map((x) => x.id_calendar))];
  const silenzi = [];
  for (const id of riunioni) {
    const m = (await db.query('SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3', [...chi(req), id])).rows[0];
    pezzi(m && m.trascrizione).forEach((t, i) => {
      if (!conDomanda.has(`${id}|${i}`) && !tutteDomande.has(`${id}|${i}`)) silenzi.push({ tratto: t, risposta: 'Nessun suggerimento.' });
    });
  }
  // Scelta casuale ma ripetibile (stesso file a ogni download con gli stessi dati).
  const ordinati = silenzi.map((x) => ({ x, k: crypto.createHash('md5').update(x.tratto).digest('hex') })).sort((a, b) => a.k.localeCompare(b.k)).map((y) => y.x);
  out.push(...ordinati.slice(0, Math.ceil(corrette.length * 1.5)));
  return { esempi: out, corrette: corrette.length, riunioni: riunioni.length };
}

// --- Filtro veloce 4B (2026-10-21) ------------------------------------------------------------
// Il filtro dell'Assistente («Projexa 4B + 8B») legge ogni pezzo e dice solo «SI n» / «NO»: le
// etichette vengono dalle stesse valutazioni. Pezzo con domanda Corretta = «SI n» (n = segnale);
// solo domande Errate o nessuna domanda = «NO»; domande ancora da valutare = pezzo escluso.
// Stesso messaggio che il filtro riceve durante la call (routes/assistentePm.js).
const FILTRO_PREC_CHARS = 500;
const msgFiltro = (prec, nuovo) => `PEZZO PRECEDENTE (solo contesto):\n${prec || '(inizio riunione)'}\n\nPEZZO NUOVO:\n${nuovo}`;
const chiavePezzo = (x) => `${x.id_calendar}|${x.pezzo}`;
const md5 = (t) => crypto.createHash('md5').update(String(t)).digest('hex');

async function esempiFiltro(req) {
  const valutate = (await db.query(
    `SELECT id_calendar, pezzo, segnale, suggerimento, testo_corretto, esito FROM pm_analisi
      WHERE tenant_id = $1 AND user_id = $2 AND esito IS NOT NULL`, chi(req))).rows;
  const tutte = new Set((await db.query('SELECT id_calendar, pezzo FROM pm_analisi WHERE tenant_id = $1 AND user_id = $2', chi(req))).rows.map(chiavePezzo));
  const etichette = new Map(); // pezzo -> 'SI n' | 'NO' (una Corretta vale più di un'Errata)
  for (const x of valutate) {
    if (x.esito === 'corretta') {
      const m = String(x.testo_corretto || x.suggerimento || '').match(FORMATO_RE);
      const n = m ? Number(m[2]) : Number(x.segnale) || 0;
      etichette.set(chiavePezzo(x), n ? `SI ${n}` : 'SI');
    } else if (!etichette.has(chiavePezzo(x))) etichette.set(chiavePezzo(x), 'NO');
  }
  const si = [];
  const no = [];
  const riunioni = [...new Set(valutate.map((x) => x.id_calendar))];
  for (const id of riunioni) {
    const m = (await db.query('SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3', [...chi(req), id])).rows[0];
    const lista = pezzi(m && m.trascrizione);
    lista.forEach((t, i) => {
      const k = `${id}|${i}`;
      const risposta = etichette.get(k) || (tutte.has(k) ? null : 'NO');
      if (!risposta) return;
      (risposta === 'NO' ? no : si).push({ precedente: i ? lista[i - 1].slice(-FILTRO_PREC_CHARS) : '', nuovo: t, risposta });
    });
  }
  // NO in ordine casuale ma ripetibile; al massimo il doppio dei SI (il filtro deve imparare a
  // NON perdere i segnali: troppi NO lo renderebbero muto).
  const ordinati = no.sort((a, b) => md5(a.nuovo).localeCompare(md5(b.nuovo)));
  return { si, no: ordinati.slice(0, Math.max(si.length * 2, 20)), riunioni: riunioni.length };
}

// Pochi esempi brevi per le istruzioni del filtro (pm_projexa_esempi, campo «filtro»): segnali
// diversi a rotazione + qualche NO. Stanno nel contesto del 4B (num_ctx 6144).
function esempiFiltroBrevi({ si, no }) {
  const corto = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > 500 ? `…${s.slice(-500)}` : s; };
  const perSegnale = new Map();
  for (const x of si) { const n = x.risposta; if (!perSegnale.has(n)) perSegnale.set(n, []); perSegnale.get(n).push(x); }
  const scelti = [];
  for (let giro = 0; scelti.length < 6 && [...perSegnale.values()].some((l) => l.length > giro); giro++) {
    for (const l of perSegnale.values()) if (l[giro] && scelti.length < 6) scelti.push(l[giro]);
  }
  return [...scelti, ...no.slice(0, 5)].map((x) => ({ pezzo: corto(x.nuovo), risposta: x.risposta }));
}

router.get('/scarica', async (req, res) => {
  try {
    if (req.query.famiglia === 'filtro') {
      const { si, no } = await esempiFiltro(req);
      if (!si.length) throw errore(400, 'Nessuna domanda segnata come corretta: il filtro non ha esempi di SI');
      const sistema = (await getPromptFor('PM_PROJEXA_FILTRO', req.user)).testo;
      const righe = [...si, ...no].map((x) => JSON.stringify({ messages: [
        { role: 'system', content: sistema }, { role: 'user', content: msgFiltro(x.precedente, x.nuovo) }, { role: 'assistant', content: x.risposta }] }));
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pm_projexa_filtro_addestramento_${new Date().toISOString().slice(0, 10)}.jsonl"`);
      return res.send(righe.join('\n') + '\n');
    }
    const { esempi } = await esempiAddestramento(req);
    if (!esempi.length) throw errore(400, 'Nessuna domanda valutata: segna prima le domande corrette ed errate');
    const righe = esempi.map((x) => JSON.stringify({ messages: [
      { role: 'system', content: SISTEMA }, { role: 'user', content: utenteMsg(x.tratto) }, { role: 'assistant', content: x.risposta }] }));
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pm_projexa_addestramento_${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(righe.join('\n') + '\n');
  } catch (e) { rispondiErrore(res, e, 'download'); }
});

// Query famiglia=filtro: notebook del filtro 4B (pm-projexa-filtro, Qwen3 4B Instruct).
router.get('/notebook', (req, res) => {
  const filtro = req.query.famiglia === 'filtro';
  res.setHeader('Content-Type', 'application/x-ipynb+json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="addestra_pm_projexa${filtro ? '_filtro' : ''}.ipynb"`);
  fs.createReadStream(filtro ? NOTEBOOK_FILTRO : NOTEBOOK).on('error', (e) => rispondiErrore(res, e, 'notebook')).pipe(res);
});

// Domande corrette subito come esempi di Pm projexa (senza addestramento): nuova versione attiva
// in pm_projexa_esempi (letta da routes/assistentePm.js, esempiAddestramento). Max 24 + 10 silenzi.
// Nella stessa versione gli esempi «SI n» / «NO» del filtro 4B (esempiFiltroBrevi): il campo
// esempi diventa { pm: [...], filtro: [...] } (le versioni vecchie restano un elenco = solo pm).
router.post('/esempi', async (req, res) => {
  try {
    const { esempi, riunioni } = await esempiAddestramento(req);
    const corti = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > 350 ? `…${s.slice(-350)}` : s; };
    const utili = esempi.filter((x) => FORMATO_RE.test(x.risposta)).slice(0, 24);
    const silenzi = esempi.filter((x) => !FORMATO_RE.test(x.risposta)).slice(0, 10);
    const pacchetto = [...utili, ...silenzi].map((x) => ({ tratto: corti(x.tratto), risposta: x.risposta }));
    if (!utili.length) throw errore(400, 'Nessuna domanda segnata come corretta');
    const filtro = esempiFiltroBrevi(await esempiFiltro(req));
    const { data } = await encryptRowForWrite(db, 'pm_projexa_esempi', { esempi: JSON.stringify({ pm: pacchetto, filtro }), note: 'Da Analisi PM' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const v = (await client.query('SELECT coalesce(max(versione), 0) + 1 AS v FROM pm_projexa_esempi WHERE tenant_id = $1', [req.user.tenant_id])).rows[0].v;
      await client.query('UPDATE pm_projexa_esempi SET attivo = false WHERE tenant_id = $1 AND attivo', [req.user.tenant_id]);
      await client.query(
        `INSERT INTO pm_projexa_esempi (tenant_id, versione, attivo, n_esempi, riunioni, note, esempi, creato_da, crypto)
         VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8)`,
        [req.user.tenant_id, v, pacchetto.length, riunioni, data.note, data.esempi, req.user.email, data.crypto ?? 0]);
      await client.query('COMMIT');
      res.json({ ok: true, versione: v, esempi: pacchetto.length, esempiFiltro: filtro.length });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) { rispondiErrore(res, e, 'esempi'); }
});

router.get('/esempi', async (req, res) => {
  try {
    const r = await db.query(`SELECT versione, attivo, n_esempi, riunioni, note, created_at FROM pm_projexa_esempi
                               WHERE tenant_id = $1 ORDER BY versione DESC LIMIT 20`, [req.user.tenant_id]);
    res.json({ versioni: r.rows });
  } catch (e) { rispondiErrore(res, e, 'esempi'); }
});
router.post('/esempi/attiva', async (req, res) => {
  try {
    const v = Number((req.body || {}).versione) || 0; // 0 = nessuna attiva
    await db.query('UPDATE pm_projexa_esempi SET attivo = false WHERE tenant_id = $1 AND attivo', [req.user.tenant_id]);
    if (v) await db.query('UPDATE pm_projexa_esempi SET attivo = true WHERE tenant_id = $1 AND versione = $2', [req.user.tenant_id, v]);
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, 'esempi'); }
});

// --- Analisi Recap: esempi per addestrare recap-projexa (jobs/analisiRecap.js) ---------------
// Segno «Analisi Recap» sulla riunione, risposte dell'AI insegnante da valutare, file per
// l'addestramento e notebook. Il modello si installa con /modelli?famiglia=recap.
const rispondiErroreRecap = (res, e, cosa) => {
  if (e.code === '42P01' || e.code === '42703') return res.status(503).json({ error: 'Analisi Recap non attiva: manca Supporto/CreaDB/analisi_recap.sql' });
  return rispondiErrore(res, e, cosa);
};

router.get('/recap/flag', async (req, res) => {
  try {
    const id = String(req.query.id_calendar || '').slice(0, 300);
    const m = (await db.query('SELECT analisi_recap FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3', [...chi(req), id])).rows[0];
    const a = (await db.query('SELECT stato, completata_il FROM recap_analisi_riunioni WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3', [...chi(req), id])).rows[0];
    res.json({ flag: !!(m && m.analisi_recap), stato: a ? a.stato : null, completata_il: a ? a.completata_il : null, ai: await aiScelta(req.user) });
  } catch (e) { rispondiErroreRecap(res, e, 'flag recap'); }
});
router.post('/recap/flag', async (req, res) => {
  try {
    const id = String((req.body || {}).id_calendar || '').slice(0, 300);
    const r = await db.query('UPDATE rec_meeting SET analisi_recap = $4 WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
      [...chi(req), id, !!req.body.flag]);
    if (!r.rowCount) throw errore(404, 'Riunione non trovata');
    res.json({ ok: true, flag: !!req.body.flag });
  } catch (e) { rispondiErroreRecap(res, e, 'flag recap'); }
});

router.get('/recap/riunioni', async (req, res) => {
  try {
    const riunioni = (await db.query(
      `SELECT m.id_calendar, m.oggetto, m.data_calendar::text AS data, m.analisi_recap AS segnata,
              a.ai, a.stato, a.fase, a.prossimo, a.pezzi_tot, a.errore, a.completata_il,
              (SELECT count(*)::int FROM recap_analisi d WHERE d.tenant_id = m.tenant_id AND d.user_id = m.user_id AND d.id_calendar = m.id_calendar) AS risposte,
              (SELECT count(*)::int FROM recap_analisi d WHERE d.tenant_id = m.tenant_id AND d.user_id = m.user_id AND d.id_calendar = m.id_calendar AND d.esito IS NULL) AS da_valutare
         FROM rec_meeting m
         LEFT JOIN recap_analisi_riunioni a ON a.tenant_id = m.tenant_id AND a.user_id = m.user_id AND a.id_calendar = m.id_calendar
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND (m.analisi_recap OR a.id IS NOT NULL)
        ORDER BY m.data_calendar DESC NULLS LAST LIMIT 200`, chi(req))).rows;
    const job = (await db.query(`SELECT attivo, prossima_esecuzione FROM job_schedules WHERE job = 'analisi_recap' LIMIT 1`)).rows[0] || null;
    const conteggi = (await db.query(
      `SELECT tipo, count(*) FILTER (WHERE esito = 'corretta')::int AS corrette, count(*) FILTER (WHERE esito IS NULL)::int AS da_valutare
         FROM recap_analisi WHERE tenant_id = $1 AND user_id = $2 GROUP BY tipo`, chi(req))).rows;
    res.json({ riunioni, job, conteggi });
  } catch (e) { rispondiErroreRecap(res, e, 'riunioni recap'); }
});

// esito: 'da' | 'corretta' | 'errata' | '' (tutte); tipo e id_calendar facoltativi.
router.get('/recap/risposte', async (req, res) => {
  try {
    const p = [...chi(req)];
    let filtro = '';
    const esito = String(req.query.esito || '');
    if (esito === 'da') filtro += ' AND d.esito IS NULL';
    else if (esito === 'corretta' || esito === 'errata') { p.push(esito); filtro += ` AND d.esito = $${p.length}`; }
    if (TIPI_RECAP.includes(req.query.tipo)) { p.push(req.query.tipo); filtro += ` AND d.tipo = $${p.length}`; }
    if (req.query.id_calendar) { p.push(String(req.query.id_calendar)); filtro += ` AND d.id_calendar = $${p.length}`; }
    const r = await db.query(
      `SELECT d.id, d.id_calendar, d.tipo, d.pezzo, d.ai, d.ingresso, d.risposta, d.testo_corretto, d.esito,
              m.oggetto, m.data_calendar::text AS data
         FROM recap_analisi d
         LEFT JOIN rec_meeting m ON m.tenant_id = d.tenant_id AND m.user_id = d.user_id AND m.id_calendar = d.id_calendar
        WHERE d.tenant_id = $1 AND d.user_id = $2 ${filtro}
        ORDER BY m.data_calendar DESC NULLS LAST, d.id_calendar, array_position(ARRAY['appunti','recap','interno'], d.tipo), d.pezzo
        LIMIT 300`, p);
    res.json({ risposte: r.rows });
  } catch (e) { rispondiErroreRecap(res, e, 'risposte recap'); }
});

// Valutazione: { esito: 'corretta' | 'errata' | null, testo_corretto } (vuoto = testo dell'AI).
router.put('/recap/risposte/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) throw errore(400, 'Id non valido');
    const b = req.body || {};
    const esito = b.esito === 'corretta' || b.esito === 'errata' ? b.esito : null;
    const testo = String(b.testo_corretto || '').replace(/\r\n?/g, '\n').trim().slice(0, 30000);
    const { data } = await encryptRowForWrite(db, 'recap_analisi', { testo_corretto: testo || null });
    const r = await db.query(
      `UPDATE recap_analisi SET esito = $4, testo_corretto = $5, updated_at = now()
        WHERE id = $3 AND tenant_id = $1 AND user_id = $2`, [...chi(req), req.params.id, esito, data.testo_corretto]);
    if (!r.rowCount) throw errore(404, 'Risposta non trovata');
    res.json({ ok: true });
  } catch (e) { rispondiErroreRecap(res, e, 'valutazione recap'); }
});

// Recap salvato della riunione (quello modificato a mano, se c'è), da usare come testo corretto.
router.get('/recap/salvato', async (req, res) => {
  try {
    const m = (await db.query('SELECT recap, recap_html FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
      [...chi(req), String(req.query.id_calendar || '').slice(0, 300)])).rows[0];
    if (!m || !(m.recap_html || m.recap)) throw errore(404, 'La riunione non ha un recap salvato');
    const testo = m.recap_html
      ? String(m.recap_html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      : String(m.recap).trim();
    res.json({ testo });
  } catch (e) { rispondiErroreRecap(res, e, 'recap salvato'); }
});

// File per l'addestramento: solo le risposte corrette, con le STESSE istruzioni di sistema e lo
// stesso compito che recap-projexa riceve in produzione (routes/ai.js, askRecapProjexa).
router.get('/recap/scarica', async (req, res) => {
  try {
    const righe = (await db.query(
      `SELECT ingresso, coalesce(testo_corretto, risposta) AS risposta FROM recap_analisi
        WHERE tenant_id = $1 AND user_id = $2 AND esito = 'corretta' ORDER BY id_calendar, tipo, pezzo`, chi(req))).rows;
    if (!righe.length) throw errore(400, 'Nessuna risposta segnata come corretta');
    const sistema = await istruzioniRecapProjexa();
    const jsonl = righe.map((x) => JSON.stringify({ messages: [
      ...(sistema ? [{ role: 'system', content: sistema }] : []), { role: 'user', content: x.ingresso }, { role: 'assistant', content: x.risposta }] }));
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="recap_projexa_addestramento_${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(jsonl.join('\n') + '\n');
  } catch (e) { rispondiErroreRecap(res, e, 'download recap'); }
});

// Query famiglia=recap14: notebook per recap-projexa-14b (Qwen3 14B, esempi fino a 4.096 token).
router.get('/recap/notebook', (req, res) => {
  const da14 = req.query.famiglia === 'recap14';
  res.setHeader('Content-Type', 'application/x-ipynb+json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="addestra_recap_projexa${da14 ? '_14b' : ''}.ipynb"`);
  fs.createReadStream(da14 ? NOTEBOOK_RECAP_14B : NOTEBOOK_RECAP).on('error', (e) => rispondiErrore(res, e, 'notebook')).pipe(res);
});

// --- Proposte di revisione dei prompt del recap (jobs/revisionePrompt.js) --------------------
// Nate di notte (o con «Proponi ora») dai recap corretti qui; si applicano o si scartano.
router.get('/recap/proposte', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, funzione, testo_attuale, testo_proposto, motivazione, modifiche, esempi, ai, stato, created_at, decisa_il
         FROM prompt_proposte WHERE tenant_id = $1 AND user_id = $2
        ORDER BY (stato = 'proposta') DESC, created_at DESC LIMIT 20`, chi(req));
    const disponibili = (await db.query(
      `SELECT tipo, count(*)::int AS n FROM recap_analisi
        WHERE tenant_id = $1 AND user_id = $2 AND tipo IN ('recap', 'interno') AND usata_revisione IS NULL
          AND (esito = 'errata' OR (esito = 'corretta' AND testo_corretto IS NOT NULL)) GROUP BY tipo`, chi(req))).rows;
    res.json({ proposte: r.rows, disponibili: Object.fromEntries(disponibili.map((x) => [x.tipo, x.n])) });
  } catch (e) { rispondiErroreRecap(res, e, 'proposte'); }
});

// Proposta subito, senza aspettare la notte (anche con meno di 3 testi rivisti). Body: { tipo }.
router.post('/recap/proposte/genera', async (req, res) => {
  try {
    const r = await proponiRevisione(req.user, String((req.body || {}).tipo || ''), { forza: true });
    res.json(r);
  } catch (e) { rispondiErroreRecap(res, e, 'proposta'); }
});

// Applica: body { testo } (vuoto = testo proposto). Copia del prompt in uso, poi salvataggio.
router.post('/recap/proposte/:id/applica', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) throw errore(400, 'Id non valido');
    res.json({ ok: true, ...(await applicaProposta(req.user, req.params.id, String((req.body || {}).testo || ''), req.user.email)) });
  } catch (e) { rispondiErroreRecap(res, e, 'applica proposta'); }
});

router.post('/recap/proposte/:id/scarta', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) throw errore(400, 'Id non valido');
    const r = await db.query(
      `UPDATE prompt_proposte SET stato = 'scartata', decisa_il = now() WHERE id = $3 AND tenant_id = $1 AND user_id = $2 AND stato = 'proposta'`,
      [...chi(req), req.params.id]);
    if (!r.rowCount) throw errore(404, 'Proposta non trovata o già decisa');
    res.json({ ok: true });
  } catch (e) { rispondiErroreRecap(res, e, 'scarta proposta'); }
});

// --- Analisi Associazioni: insegnante dell'associazione To-Do e RAID (2026-10-21) -------------
// Ogni riga di pm_associazioni fatta da Projexa con l'insegnante attivo: le voci inviate
// (fotografia), i gruppi di Projexa e quelli dell'AI insegnante uniti per insieme di voci, e la
// valutazione dell'utente (JSON { gruppi: [{ voci, esito, tu }] }, cifrato). Giusto = le voci si
// collegano; Sbagliato = se sono collegate tra loro si scollegano. Valutazione completa = esempio
// per addestrare assoc-projexa-14b.
const rispondiErroreAssoc = (res, e, cosa) => {
  if (e.code === '42P01' || e.code === '42703') return res.status(503).json({ error: 'Analisi Associazioni non attiva: manca Supporto/CreaDB/analisi_associazioni.sql' });
  return rispondiErrore(res, e, cosa);
};
const json = (t, vuoto = null) => { try { return t ? JSON.parse(t) : vuoto; } catch { return vuoto; } };
const chiaveGruppo = (voci) => voci.join(',');

async function rigaAssoc(req) {
  if (!UUID.test(req.params.id)) throw errore(400, 'Id non valido');
  const r = (await db.query(
    `SELECT id, risposta, elenco, insegnante_ai, insegnante_stato, insegnante_risposta, valutazione, valutata_il
       FROM pm_associazioni WHERE id = $3 AND tenant_id = $1 AND user_id = $2 AND elenco IS NOT NULL`, [...chi(req), req.params.id])).rows[0];
  if (!r) throw errore(404, 'Associazione non trovata');
  return r;
}

// Gruppi di Projexa e dell'insegnante (stesso insieme di voci = un solo gruppo con più fonti),
// più quelli aggiunti a mano, con l'esito della valutazione.
function gruppiAssoc(r) {
  const n = (json(r.elenco, []) || []).length;
  const val = json(r.valutazione, { gruppi: [] });
  const gruppi = new Map();
  const prendi = (voci) => {
    const k = chiaveGruppo(voci);
    if (!gruppi.has(k)) gruppi.set(k, { voci, fonti: [], esito: null });
    return gruppi.get(k);
  };
  for (const g of gruppiDa(r.risposta, n) || []) prendi(g.voci).fonti.push({ ai: 'Projexa', confidenza: g.confidenza, motivo: g.motivo });
  if (r.insegnante_stato === 'pronto') {
    for (const g of gruppiDa(r.insegnante_risposta, n) || []) prendi(g.voci).fonti.push({ ai: r.insegnante_ai || 'Insegnante', confidenza: g.confidenza, motivo: g.motivo });
  }
  for (const g of (val && Array.isArray(val.gruppi) ? val.gruppi : [])) {
    const x = prendi(g.voci);
    x.esito = g.esito || null;
    if (!x.fonti.length) x.fonti.push({ ai: 'Tu' });
  }
  return [...gruppi.values()];
}

router.get('/associazioni', async (req, res) => {
  try {
    const esito = String(req.query.esito || 'da');
    const filtro = esito === 'da' ? ' AND valutata_il IS NULL' : esito === 'fatte' ? ' AND valutata_il IS NOT NULL' : '';
    const righe = (await db.query(
      `SELECT id, client_id::text AS client_id, project_id::text AS project_id, giorno::text AS giorno, risposta, elenco,
              insegnante_ai, insegnante_stato, insegnante_risposta, insegnante_errore, valutazione, valutata_il
         FROM pm_associazioni
        WHERE tenant_id = $1 AND user_id = $2 AND ai = 'Projexa' AND stato = 'applicato'
          AND elenco IS NOT NULL AND insegnante_stato IS NOT NULL ${filtro}
        ORDER BY giorno DESC, created_at DESC LIMIT 60`, chi(req))).rows;
    const { clienti, progetti } = await nomiClientiProgetti(righe.map((r) => r.client_id), righe.map((r) => r.project_id));
    const elenchi = new Map(righe.map((r) => [r.id, json(r.elenco, []) || []]));
    const ora = new Map((await vociDaChiavi(req.user, [...new Set([...elenchi.values()].flat().map((v) => v.k))])).map((v) => [v.k, v]));
    const associazioni = righe.map((r) => {
      const elenco = elenchi.get(r.id);
      const gruppi = gruppiAssoc(r).map((g) => {
        const colls = g.voci.map((n) => (ora.get((elenco[n - 1] || {}).k) || {}).coll);
        return { ...g, collegate: !!colls[0] && colls.every((c) => c === colls[0]) };
      });
      return {
        id: r.id, giorno: r.giorno, cliente: clienti.get(String(r.client_id || '')) || '', progetto: progetti.get(String(r.project_id || '')) || '',
        voci: elenco.map((v, i) => ({ n: i + 1, registro: REGISTRI[v.registro] || v.registro, titolo: v.titolo, descrizione: v.descrizione, owner: v.owner,
          stato: !ora.has(v.k) ? 'eliminata' : ora.get(v.k).aperta ? 'aperta' : 'chiusa' })),
        gruppi, insegnante: { ai: r.insegnante_ai, stato: r.insegnante_stato, errore: r.insegnante_errore }, completa: !!r.valutata_il
      };
    });
    const conteggi = (await db.query(
      `SELECT count(*) FILTER (WHERE valutata_il IS NULL)::int AS da_valutare, count(valutata_il)::int AS valutate
         FROM pm_associazioni WHERE tenant_id = $1 AND user_id = $2 AND ai = 'Projexa' AND stato = 'applicato'
          AND elenco IS NOT NULL AND insegnante_stato IS NOT NULL`, chi(req))).rows[0];
    const job = (await db.query(`SELECT attivo, prossima_esecuzione FROM job_schedules WHERE job = 'associa_todo_raid' LIMIT 1`)).rows[0] || null;
    res.json({ associazioni, conteggi, job, ai: await aiScelta(req.user) });
  } catch (e) { rispondiErroreAssoc(res, e, 'associazioni'); }
});

// Esito di un gruppo. Body: { voci: [n, ...], esito: 'giusto' | 'sbagliato' | null }.
// Un gruppo nuovo (voci scelte a mano) entra come «Tu». Risposta: { azione } con quanto fatto
// sulle voci vere: 'collegate', 'scollegate' o null.
router.put('/associazioni/:id/gruppo', async (req, res) => {
  try {
    const r = await rigaAssoc(req);
    const elenco = json(r.elenco, []) || [];
    const b = req.body || {};
    const voci = [...new Set((Array.isArray(b.voci) ? b.voci : []).map(Number))].filter((x) => Number.isInteger(x) && x >= 1 && x <= elenco.length).sort((a, c) => a - c);
    if (voci.length < 2) throw errore(400, 'Un gruppo ha almeno 2 voci');
    const esito = b.esito === 'giusto' || b.esito === 'sbagliato' ? b.esito : null;
    const val = json(r.valutazione, { gruppi: [] });
    val.gruppi = (Array.isArray(val.gruppi) ? val.gruppi : []).filter((g) => chiaveGruppo(g.voci) !== chiaveGruppo(voci));
    if (esito) val.gruppi.push({ voci, esito });
    // Un gruppo di Projexa o dell'insegnante tornato senza esito: la valutazione non è più completa.
    const completa = !!r.valutata_il && gruppiAssoc({ ...r, valutazione: JSON.stringify(val) }).every((g) => g.esito);
    await db.query('UPDATE pm_associazioni SET valutazione = $2, valutata_il = CASE WHEN $3 THEN valutata_il END WHERE id = $1',
      [r.id, encryptValue(JSON.stringify(val)), completa]);

    const chiavi = voci.map((n) => elenco[n - 1].k);
    let azione = null;
    if (esito === 'giusto') {
      const ora = await vociDaChiavi(req.user, chiavi);
      if (!(ora.length === chiavi.length && ora[0].coll && ora.every((v) => v.coll === ora[0].coll))) {
        await collegaVoci(req.user, chiavi);
        azione = 'collegate';
      }
    } else if (esito === 'sbagliato') {
      const ora = await vociDaChiavi(req.user, chiavi);
      if (ora.length >= 2 && ora[0].coll && ora.every((v) => v.coll === ora[0].coll)) {
        await scollegaVoci(req.user, chiavi);
        azione = 'scollegate';
      }
    }
    res.json({ ok: true, azione });
  } catch (e) { rispondiErroreAssoc(res, e, 'gruppo associazione'); }
});

// Valutazione completa (o riaperta). Body: { completa: true | false }. Completa solo con tutti i
// gruppi valutati e l'insegnante arrivato (o in errore).
router.post('/associazioni/:id/completa', async (req, res) => {
  try {
    const r = await rigaAssoc(req);
    const completa = !!(req.body || {}).completa;
    if (completa) {
      if (['da_inviare', 'inviato'].includes(r.insegnante_stato)) throw errore(409, 'Aspetta la risposta dell\'AI insegnante');
      if (gruppiAssoc(r).some((g) => !g.esito)) throw errore(409, 'Segna prima ogni gruppo come giusto o sbagliato');
    }
    // Nessun gruppo: «niente da collegare» è un esempio valido, la valutazione resta {gruppi: []}.
    const val = encryptValue(r.valutazione || JSON.stringify({ gruppi: [] })); // letta già in chiaro dal pool
    await db.query(`UPDATE pm_associazioni SET valutazione = $2, valutata_il = ${completa ? 'now()' : 'NULL'} WHERE id = $1`, [r.id, val]);
    res.json({ ok: true });
  } catch (e) { rispondiErroreAssoc(res, e, 'completa associazione'); }
});

// File per l'addestramento: per ogni valutazione completa il compito ESATTO (senza i casi
// d'esempio) e come risposta i soli gruppi giusti, nello stesso JSON che il job legge.
router.get('/associazioni/scarica', async (req, res) => {
  try {
    const righe = (await db.query(
      `SELECT risposta, elenco, insegnante_ai, insegnante_stato, insegnante_risposta, valutazione, valutata_il
         FROM pm_associazioni WHERE tenant_id = $1 AND user_id = $2 AND valutata_il IS NOT NULL AND elenco IS NOT NULL
        ORDER BY giorno, created_at`, chi(req))).rows;
    if (!righe.length) throw errore(400, 'Nessuna valutazione completa: segna i gruppi e premi «Valutazione completa»');
    const jsonl = righe.map((r) => {
      const giusti = gruppiAssoc(r).filter((g) => g.esito === 'giusto').map((g) => ({
        voci: g.voci, confidenza: 95,
        motivo: (g.fonti.find((f) => f.ai !== 'Projexa' && f.motivo) || g.fonti.find((f) => f.motivo) || {}).motivo || 'stesso impegno concreto'
      }));
      return JSON.stringify({ messages: [
        { role: 'user', content: promptAssoc(json(r.elenco, [])) }, { role: 'assistant', content: JSON.stringify({ gruppi: giusti }) }] });
    });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assoc_projexa_addestramento_${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(jsonl.join('\n') + '\n');
  } catch (e) { rispondiErroreAssoc(res, e, 'download associazioni'); }
});

router.get('/associazioni/notebook', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ipynb+json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="addestra_assoc_projexa_14b.ipynb"');
  fs.createReadStream(NOTEBOOK_ASSOC).on('error', (e) => rispondiErrore(res, e, 'notebook')).pipe(res);
});

// --- Modelli su Ollama della VM -------------------------------------------------------------
// famiglia (query, body): 'pm' = pm-projexa (Assistente PM), 'filtro' = pm-projexa-filtro (filtro
// 4B dell'Assistente, base qwen3:4b-instruct), 'recap' = recap-projexa (Recap
// cliente e interno, 7B), 'recap14' = recap-projexa-14b (voce «Projexa 14B», base Qwen3 14B),
// 'assoc' = assoc-projexa-14b (associazione To-Do e RAID con «Projexa», base Qwen3 14B).
// Stessa procedura: backup, creazione da base + adattatore, prova.
const PROVA_RECAP = [{ role: 'user', content: 'Scrivi in una riga gli appunti di questo pezzo di riunione:\nMario Rossi: il file delle causali ve lo mandiamo entro venerdì.' }];
const FAMIGLIE = {
  // Stessi parametri delle chiamate di jobs/associaTodoRaid.js (risposta JSON, temperatura 0).
  assoc: {
    nome: OLLAMA_ADDESTRATO, base: BASE_14B,
    parametri: ['PARAMETER num_ctx 8192', 'PARAMETER temperature 0', 'PARAMETER num_predict 800'],
    prova: [{ role: 'user', content: promptAssoc([
      { registro: 'decisione', titolo: 'Sessioni di formazione presenze il 16 e 26 novembre', descrizione: '', owner: 'Mario Rossi' },
      { registro: 'todo', titolo: 'Organizzare le sessioni di formazione presenze', descrizione: '', owner: 'Mario Rossi' }]) }]
  },
  recap14: {
    nome: MODELLO_RECAP_14B, base: BASE_14B,
    parametri: ['PARAMETER num_ctx 16384', 'PARAMETER temperature 0.3', 'PARAMETER top_p 0.9', 'PARAMETER repeat_penalty 1.1'],
    prova: PROVA_RECAP
  },
  pm: {
    nome: MODELLO, base: BASE,
    parametri: ['PARAMETER num_ctx 8192', 'PARAMETER temperature 0.2', 'PARAMETER top_p 0.9', 'PARAMETER repeat_penalty 1.1', 'PARAMETER num_predict 90'],
    prova: [{ role: 'user', content: 'TRASCRIZIONE (nuovo tratto della riunione):\nIl file delle causali ve lo mandiamo a breve.' }]
  },
  // Filtro 4B: stessi parametri delle chiamate di routes/assistentePm.js (contesto fisso 6144,
  // risposta di pochi token). La prova è un pezzo con un segnale evidente.
  filtro: {
    nome: MODELLO_FILTRO, base: BASE_FILTRO,
    parametri: ['PARAMETER num_ctx 6144', 'PARAMETER temperature 0', 'PARAMETER num_predict 6'],
    prova: [{ role: 'user', content: msgFiltro('', 'Cliente: il file delle causali ve lo mandiamo a breve.') }]
  },
  recap: {
    nome: MODELLO_RECAP, base: BASE,
    parametri: ['PARAMETER num_ctx 16384', 'PARAMETER temperature 0.3', 'PARAMETER top_p 0.9', 'PARAMETER repeat_penalty 1.1'],
    prova: [{ role: 'user', content: 'Scrivi in una riga gli appunti di questo pezzo di riunione:\nMario Rossi: il file delle causali ve lo mandiamo entro venerdì.' }]
  }
};
const famiglia = (req) => {
  const f = FAMIGLIE[String((req.query && req.query.famiglia) || (req.body && req.body.famiglia) || 'pm')];
  if (!f) throw errore(400, 'Famiglia di modelli non valida');
  return { ...f, bk: new RegExp(`^${f.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-bk-\\d{8}-\\d{4}(:latest)?$`) };
};
const soloVm = () => { if (process.platform !== 'linux') throw errore(400, 'Disponibile solo sulla VM (non in locale)'); };
// La prova carica il modello in RAM: durante una call toglierebbe posto all'Assistente PM.
const noDuranteCall = () => { if (pmProjexaInCorso()) throw errore(409, 'L\'Assistente PM (Pm projexa) è in uso: riprova a call finita'); };
const stampOra = (ora) => `${ora.toISOString().slice(0, 10).replace(/-/g, '')}-${ora.toTimeString().slice(0, 5).replace(':', '')}`;
const ollama = (args, timeout = 30 * 60000) => new Promise((resolve, reject) => {
  execFile('ollama', args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().slice(-500) || 'comando ollama non riuscito'));
    else resolve(String(stdout || ''));
  });
});
const ollamaApi = async (p, body) => {
  const r = await fetch(`${OLLAMA_URL}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10 * 60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw errore(502, `Ollama: ${d.error || r.status}`);
  return d;
};
const DELETE = async (model) => {
  const r = await fetch(`${OLLAMA_URL}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
  if (!r.ok) throw errore(502, `Ollama: eliminazione non riuscita (${r.status})`);
};

router.get('/modelli', async (req, res) => {
  try {
    soloVm();
    const f = famiglia(req);
    const d = await ollamaApi('/api/tags');
    const pulito = (n) => n.replace(/:latest$/, '');
    const nomi = (d.models || []).filter((m) => pulito(m.name) === f.nome || f.bk.test(m.name)).map((m) => ({
      nome: pulito(m.name), dimensione: m.size, modificato: m.modified_at, attuale: pulito(m.name) === f.nome, backup: f.bk.test(m.name)
    }));
    let note = {};
    try { note = JSON.parse(fs.readFileSync(path.join(CARTELLA_MODELLI, 'versioni.json'), 'utf8')); } catch { /* nessuna installazione */ }
    res.json({ modelli: nomi.sort((a, b) => String(b.modificato).localeCompare(String(a.modificato))), note, base: f.base, nome: f.nome });
  } catch (e) { rispondiErrore(res, e, 'modelli'); }
});

// Caricamento del file .gguf a parti (PEZZO_UPLOAD): header x-upload-id (uuid), x-parte, x-parti.
router.post('/modelli/carica', async (req, res) => {
  try {
    soloVm();
    const id = String(req.headers['x-upload-id'] || '');
    const parte = Number(req.headers['x-parte']);
    const parti = Number(req.headers['x-parti']);
    if (!UUID.test(id) || !Number.isInteger(parte) || !Number.isInteger(parti) || parte < 0 || parte >= parti || parti * PEZZO_UPLOAD > MAX_ADATTATORE + PEZZO_UPLOAD) throw errore(400, 'Caricamento non valido');
    fs.mkdirSync(path.join(CARTELLA_MODELLI, 'caricamenti'), { recursive: true });
    const file = path.join(CARTELLA_MODELLI, 'caricamenti', `${id}.gguf`);
    if (parte === 0 && fs.existsSync(file)) fs.unlinkSync(file);
    const dim = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (dim !== parte * PEZZO_UPLOAD) throw errore(409, 'Parti fuori ordine: ricomincia il caricamento');
    let letti = 0;
    const out = fs.createWriteStream(file, { flags: 'a' });
    for await (const c of req) {
      letti += c.length;
      if (letti > PEZZO_UPLOAD) { out.destroy(); throw errore(413, 'Parte troppo grande'); }
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    res.json({ ok: true, ricevuti: dim + letti });
  } catch (e) { rispondiErrore(res, e, 'caricamento'); }
});

// Installazione: backup del modello attuale (<nome>-bk-AAAAMMGG-HHMM), creazione del nuovo
// <nome> = base + adattatore + parametri attuali, prova di risposta; se la prova fallisce si
// torna al backup da soli. Body: { upload_id, nota, famiglia }.
router.post('/modelli/installa', async (req, res) => {
  try {
    soloVm();
    const f = famiglia(req);
    noDuranteCall();
    const id = String((req.body || {}).upload_id || '');
    if (!UUID.test(id)) throw errore(400, 'Caricamento non valido');
    const caricato = path.join(CARTELLA_MODELLI, 'caricamenti', `${id}.gguf`);
    if (!fs.existsSync(caricato)) throw errore(404, 'File non trovato: caricalo di nuovo');
    const testa = Buffer.alloc(4);
    const fd = fs.openSync(caricato, 'r'); fs.readSync(fd, testa, 0, 4, 0); fs.closeSync(fd);
    if (testa.toString('latin1') !== 'GGUF') throw errore(400, 'Il file non è un .gguf valido');

    const ora = new Date();
    const stamp = stampOra(ora);
    const cartella = path.join(CARTELLA_MODELLI, `${f.nome}-${stamp}`);
    fs.mkdirSync(cartella, { recursive: true });
    const adattatore = path.join(cartella, 'adapter.gguf');
    fs.renameSync(caricato, adattatore);
    // Parametri del modello attuale (num_ctx, temperatura...): restano uguali.
    let parametri = f.parametri;
    let haAttuale = false;
    try {
      const mf = await ollama(['show', f.nome, '--modelfile'], 60000);
      haAttuale = true;
      const p = mf.split('\n').filter((l) => /^PARAMETER\s+(num_ctx|temperature|top_p|repeat_penalty|num_predict)\b/.test(l));
      if (p.length) parametri = p;
    } catch { /* il modello non c'è: si crea da zero */ }
    fs.writeFileSync(path.join(cartella, 'Modelfile'), [`FROM ${f.base}`, `ADAPTER ${adattatore}`, ...parametri].join('\n') + '\n');

    const backup = `${f.nome}-bk-${stamp}`;
    if (haAttuale) await ollamaApi('/api/copy', { source: f.nome, destination: backup });
    try {
      await ollama(['create', f.nome, '-f', path.join(cartella, 'Modelfile')]);
      // Prova: il modello nuovo deve rispondere (poi esce subito dalla RAM).
      const prova = await ollamaApi('/api/chat', { model: f.nome, stream: false, think: false, keep_alive: f.nome === MODELLO ? '4h' : 0,
        messages: f.prova, options: { num_predict: 60 } });
      const versioni = (() => { try { return JSON.parse(fs.readFileSync(path.join(CARTELLA_MODELLI, 'versioni.json'), 'utf8')); } catch { return {}; } })();
      versioni[f.nome] = { installato: ora.toISOString(), da: req.user.email, nota: String(req.body.nota || '').slice(0, 300), backup: haAttuale ? backup : null, cartella };
      fs.writeFileSync(path.join(CARTELLA_MODELLI, 'versioni.json'), JSON.stringify(versioni, null, 1));
      console.log(`[ANALISI PM] nuovo ${f.nome} installato da ${req.user.email} (backup ${haAttuale ? backup : 'nessuno'})`);
      res.json({ ok: true, backup: haAttuale ? backup : null, prova: String((prova.message && prova.message.content) || '').slice(0, 300) });
    } catch (e) {
      if (haAttuale) await ollamaApi('/api/copy', { source: backup, destination: f.nome }).catch(() => {});
      throw errore(500, `Installazione non riuscita, rimesso il modello precedente: ${e.message}`);
    }
  } catch (e) { rispondiErrore(res, e, 'installazione'); }
});

// Ripristino di un backup come modello in uso (l'attuale diventa a sua volta un backup).
router.post('/modelli/ripristina', async (req, res) => {
  try {
    soloVm();
    const f = famiglia(req);
    const nome = String((req.body || {}).nome || '');
    if (!f.bk.test(nome)) throw errore(400, 'Si possono ripristinare solo i backup');
    await ollamaApi('/api/copy', { source: f.nome, destination: `${f.nome}-bk-${stampOra(new Date())}` }).catch(() => {});
    await ollamaApi('/api/copy', { source: nome, destination: f.nome });
    console.log(`[ANALISI PM] ${f.nome} ripristinato da ${nome} (${req.user.email})`);
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, 'ripristino'); }
});

// Eliminazione di un backup superato (mai il modello attuale). Query: famiglia.
router.delete('/modelli/:nome', async (req, res) => {
  try {
    soloVm();
    const f = famiglia(req);
    const nome = String(req.params.nome || '');
    if (!f.bk.test(nome)) throw errore(400, 'Si possono eliminare solo i backup');
    await DELETE(nome);
    console.log(`[ANALISI PM] backup ${nome} eliminato da ${req.user.email}`);
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, 'eliminazione'); }
});

export default router;
