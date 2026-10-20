// ============================================================================
// ANALISI PM (pagina sito/analisi-pm.html, 2026-10-20) - solo utenti in ANALISI_PM_EMAILS
// ----------------------------------------------------------------------------
//   - segno «Analisi PM» sulla riunione (finestra della trascrizione): GET/POST /flag;
//   - AI dell'analisi notturna (Gemini gratuito / ChatGPT Batch): GET/PUT /impostazioni;
//   - domande proposte dal job (jobs/analisiPm.js) da valutare: GET /domande, PUT /domande/:id;
//   - download del file per l'addestramento (JSONL) e del notebook di Google Colab;
//   - domande corrette subito come esempi di Pm projexa (pm_projexa_esempi): POST /esempi;
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
import { encryptRowForWrite } from '../config/crypto.js';
import { analisiPmAbilitata, pezzi, aiScelta, AI_AMMESSE, FORMATO_RE } from '../jobs/analisiPm.js';

const router = express.Router();
const QUI = path.dirname(fileURLToPath(import.meta.url));
const NOTEBOOK = path.join(QUI, '..', 'prompts', 'colab_pm_projexa.ipynb');
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODELLO = process.env.OLLAMA_PM_MODEL || 'pm-projexa';
const BASE = process.env.OLLAMA_RECAP_MODEL || 'qwen2.5:7b';
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

router.get('/scarica', async (req, res) => {
  try {
    const { esempi } = await esempiAddestramento(req);
    if (!esempi.length) throw errore(400, 'Nessuna domanda valutata: segna prima le domande corrette ed errate');
    const righe = esempi.map((x) => JSON.stringify({ messages: [
      { role: 'system', content: SISTEMA }, { role: 'user', content: utenteMsg(x.tratto) }, { role: 'assistant', content: x.risposta }] }));
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pm_projexa_addestramento_${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(righe.join('\n') + '\n');
  } catch (e) { rispondiErrore(res, e, 'download'); }
});

router.get('/notebook', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ipynb+json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="addestra_pm_projexa.ipynb"');
  fs.createReadStream(NOTEBOOK).on('error', (e) => rispondiErrore(res, e, 'notebook')).pipe(res);
});

// Domande corrette subito come esempi di Pm projexa (senza addestramento): nuova versione attiva
// in pm_projexa_esempi (letta da routes/assistentePm.js, esempiAddestramento). Max 24 + 10 silenzi.
router.post('/esempi', async (req, res) => {
  try {
    const { esempi, riunioni } = await esempiAddestramento(req);
    const corti = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > 350 ? `…${s.slice(-350)}` : s; };
    const utili = esempi.filter((x) => FORMATO_RE.test(x.risposta)).slice(0, 24);
    const silenzi = esempi.filter((x) => !FORMATO_RE.test(x.risposta)).slice(0, 10);
    const pacchetto = [...utili, ...silenzi].map((x) => ({ tratto: corti(x.tratto), risposta: x.risposta }));
    if (!utili.length) throw errore(400, 'Nessuna domanda segnata come corretta');
    const { data } = await encryptRowForWrite(db, 'pm_projexa_esempi', { esempi: JSON.stringify(pacchetto), note: 'Da Analisi PM' });
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
      res.json({ ok: true, versione: v, esempi: pacchetto.length });
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

// --- Modello su Ollama della VM -------------------------------------------------------------
const soloVm = () => { if (process.platform !== 'linux') throw errore(400, 'Disponibile solo sulla VM (non in locale)'); };
const NOME_BK = /^pm-projexa-bk-\d{8}-\d{4}(:latest)?$/;
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
    const d = await ollamaApi('/api/tags');
    const nomi = (d.models || []).filter((m) => /^pm-projexa/.test(m.name)).map((m) => ({
      nome: m.name.replace(/:latest$/, ''), dimensione: m.size, modificato: m.modified_at, attuale: m.name.replace(/:latest$/, '') === MODELLO, backup: NOME_BK.test(m.name)
    }));
    let note = {};
    try { note = JSON.parse(fs.readFileSync(path.join(CARTELLA_MODELLI, 'versioni.json'), 'utf8')); } catch { /* nessuna installazione */ }
    res.json({ modelli: nomi.sort((a, b) => String(b.modificato).localeCompare(String(a.modificato))), note, base: BASE });
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

// Installazione: backup del modello attuale (pm-projexa-bk-AAAAMMGG-HHMM), creazione del nuovo
// pm-projexa = base + adattatore + parametri attuali, prova di risposta; se la prova fallisce si
// torna al backup da soli. Body: { upload_id, nota }.
router.post('/modelli/installa', async (req, res) => {
  try {
    soloVm();
    const id = String((req.body || {}).upload_id || '');
    if (!UUID.test(id)) throw errore(400, 'Caricamento non valido');
    const caricato = path.join(CARTELLA_MODELLI, 'caricamenti', `${id}.gguf`);
    if (!fs.existsSync(caricato)) throw errore(404, 'File non trovato: caricalo di nuovo');
    const testa = Buffer.alloc(4);
    const fd = fs.openSync(caricato, 'r'); fs.readSync(fd, testa, 0, 4, 0); fs.closeSync(fd);
    if (testa.toString('latin1') !== 'GGUF') throw errore(400, 'Il file non è un .gguf valido');

    const ora = new Date();
    const stamp = `${ora.toISOString().slice(0, 10).replace(/-/g, '')}-${ora.toTimeString().slice(0, 5).replace(':', '')}`;
    const cartella = path.join(CARTELLA_MODELLI, `pm-projexa-${stamp}`);
    fs.mkdirSync(cartella, { recursive: true });
    const adattatore = path.join(cartella, 'adapter.gguf');
    fs.renameSync(caricato, adattatore);
    // Parametri del modello attuale (num_ctx, temperatura...): restano uguali.
    let parametri = ['PARAMETER num_ctx 8192', 'PARAMETER temperature 0.2', 'PARAMETER top_p 0.9', 'PARAMETER repeat_penalty 1.1', 'PARAMETER num_predict 90'];
    let haAttuale = false;
    try {
      const mf = await ollama(['show', MODELLO, '--modelfile'], 60000);
      haAttuale = true;
      const p = mf.split('\n').filter((l) => /^PARAMETER\s+(num_ctx|temperature|top_p|repeat_penalty|num_predict)\b/.test(l));
      if (p.length) parametri = p;
    } catch { /* pm-projexa non c'è: si crea da zero */ }
    fs.writeFileSync(path.join(cartella, 'Modelfile'), [`FROM ${BASE}`, `ADAPTER ${adattatore}`, ...parametri].join('\n') + '\n');

    const backup = `pm-projexa-bk-${stamp}`;
    if (haAttuale) await ollamaApi('/api/copy', { source: MODELLO, destination: backup });
    try {
      await ollama(['create', MODELLO, '-f', path.join(cartella, 'Modelfile')]);
      // Prova: il modello nuovo deve rispondere.
      const prova = await ollamaApi('/api/chat', { model: MODELLO, stream: false, keep_alive: '4h',
        messages: [{ role: 'user', content: 'TRASCRIZIONE (nuovo tratto della riunione):\nIl file delle causali ve lo mandiamo a breve.' }], options: { num_predict: 40 } });
      const versioni = (() => { try { return JSON.parse(fs.readFileSync(path.join(CARTELLA_MODELLI, 'versioni.json'), 'utf8')); } catch { return {}; } })();
      versioni[MODELLO] = { installato: ora.toISOString(), da: req.user.email, nota: String(req.body.nota || '').slice(0, 300), backup: haAttuale ? backup : null, cartella };
      fs.writeFileSync(path.join(CARTELLA_MODELLI, 'versioni.json'), JSON.stringify(versioni, null, 1));
      console.log(`[ANALISI PM] nuovo ${MODELLO} installato da ${req.user.email} (backup ${haAttuale ? backup : 'nessuno'})`);
      res.json({ ok: true, backup: haAttuale ? backup : null, prova: String((prova.message && prova.message.content) || '').slice(0, 300) });
    } catch (e) {
      if (haAttuale) await ollamaApi('/api/copy', { source: backup, destination: MODELLO }).catch(() => {});
      throw errore(500, `Installazione non riuscita, rimesso il modello precedente: ${e.message}`);
    }
  } catch (e) { rispondiErrore(res, e, 'installazione'); }
});

// Ripristino di un backup come pm-projexa (l'attuale diventa a sua volta un backup).
router.post('/modelli/ripristina', async (req, res) => {
  try {
    soloVm();
    const nome = String((req.body || {}).nome || '');
    if (!NOME_BK.test(nome)) throw errore(400, 'Si possono ripristinare solo i backup');
    const ora = new Date();
    const stamp = `${ora.toISOString().slice(0, 10).replace(/-/g, '')}-${ora.toTimeString().slice(0, 5).replace(':', '')}`;
    await ollamaApi('/api/copy', { source: MODELLO, destination: `pm-projexa-bk-${stamp}` }).catch(() => {});
    await ollamaApi('/api/copy', { source: nome, destination: MODELLO });
    console.log(`[ANALISI PM] ${MODELLO} ripristinato da ${nome} (${req.user.email})`);
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, 'ripristino'); }
});

// Eliminazione di un backup superato (mai il modello attuale).
router.delete('/modelli/:nome', async (req, res) => {
  try {
    soloVm();
    const nome = String(req.params.nome || '');
    if (!NOME_BK.test(nome)) throw errore(400, 'Si possono eliminare solo i backup');
    await DELETE(nome);
    console.log(`[ANALISI PM] backup ${nome} eliminato da ${req.user.email}`);
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, 'eliminazione'); }
});

export default router;
