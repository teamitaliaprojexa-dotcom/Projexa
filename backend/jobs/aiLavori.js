// ============================================================================
// LAVORI AI IN MODALITÀ BATCH (2026-10-09) - tabella ai_lavori, Supporto/CreaDB/ai_lavori.sql
// ----------------------------------------------------------------------------
// Le funzioni AI (Kick-off, Offerta, Dossier, Email attività, funzioni PM) si registrano con
// rottaAi(operazione, handler): un middleware legge AI ed esecuzione dalle Impostazioni
// (config/aiFunzioni.js) e
//   - Immediato: passa all'handler, che chiede subito all'AI scelta (req.aiScelta);
//   - Batch: salva la richiesta come "lavoro" e risponde 202. In background lo stesso handler
//     viene RIGIOCATO con una richiesta finta: ogni chiamata all'AI (askAiProvider) passa dalla
//     Batch API del fornitore (attendiBatch: metà prezzo, risposta entro 24 ore). Funzioni con
//     più passaggi (Kick-off: stesura, correzione, revisione) fanno più batch in fila; i
//     passaggi già pagati restano in ai_lavori_passi, così un riavvio del server non li ripete.
// Risultato: file (Kick-off, Offerta, Word dei documenti PM) nella cartella temporanea
// AI_TEMP_DIR/<tenant>/<utente>/, cancellato appena scaricato; oppure dati (JSON cifrato in
// ai_lavori.risultato) che la finestra «Risultati AI» mostra. Al termine: notifica in campanella.
// I file stanno sul disco del server che ha eseguito il lavoro (colonna server): solo lui lo
// riprende dopo un riavvio. Lavori e file vengono cancellati dopo GIORNI_CONSERVAZIONE giorni.
// ============================================================================
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import db from '../config/database.js';
import { encryptValue, hasEncryptionKey, isEncrypted } from '../config/crypto.js';
import { contestoAi } from '../config/aiContesto.js';
import { conContestoAudit } from '../config/auditContext.js';
import { risolviAi, OPERAZIONI } from '../config/aiFunzioni.js';
import { inviaBatchAi, statoBatchAi, askAiProvider, isBatchNonDisponibile } from '../routes/ai.js';
import { notificaLavoroAi } from './notifiche.js';

const SERVER = os.hostname();
const GIORNI_CONSERVAZIONE = 7;
const SCADENZA_ORE = 26;              // i fornitori garantiscono la risposta entro 24 ore
const ATTESA_PRIMO_CONTROLLO = 20000; // ms
const ATTESA_CONTROLLI = 60000;       // ms
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cartella dei file temporanei: AI_TEMP_DIR, altrimenti /opt/projexa/ai-temp sulla VM (fuori
// da backend/, che il deploy sincronizza) o la cartella temporanea di Windows in locale.
export const AI_TEMP_DIR = process.env.AI_TEMP_DIR
  || (process.platform === 'win32' ? path.join(os.tmpdir(), 'projexa-ai-temp') : '/opt/projexa/ai-temp');

const cifra = (v) => {
  if (v === null || v === undefined || v === '') return v;
  if (!hasEncryptionKey()) return String(v);
  return isEncrypted(v) ? v : encryptValue(String(v));
};
const errore = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cartella(tenantId, userId) {
  if (!UUID_RE.test(String(tenantId)) || !UUID_RE.test(String(userId))) throw new Error('Tenant o utente non validi per la cartella temporanea');
  return path.join(AI_TEMP_DIR, String(tenantId), String(userId));
}
const fileInput = (l) => path.join(cartella(l.tenant_id, l.user_id), `${l.id}.input`);

// ----------------------------------------------------------------------------
// REGISTRAZIONE DELLE ROTTE
// ----------------------------------------------------------------------------
const REGISTRO = new Map(); // operazione -> handler(req, res)

// Scelte della finestra "Chiedi sempre" e titolo: in query (_ai, _esecuzione, _titolo) o nel
// corpo JSON; extra = dati che servono solo alla finestra Risultati (es. destinatari email).
function leggiScelte(req) {
  const q = req.query || {};
  const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  return {
    ai: String(q._ai || b._ai || '').trim(),
    esecuzione: String(q._esecuzione || b._esecuzione || '').trim(),
    titolo: String(q._titolo || b._titolo || '').trim().slice(0, 300),
    extra: b._extra && typeof b._extra === 'object' ? b._extra : null
  };
}

export function rottaAi(operazione, handler) {
  if (!OPERAZIONI[operazione]) throw new Error(`Operazione AI sconosciuta: ${operazione}`);
  REGISTRO.set(operazione, handler);
  const scelta = async (req, res, next) => {
    try {
      const scelte = leggiScelte(req);
      try {
        req.aiScelta = await risolviAi(req.user, operazione, scelte);
      } catch (e) {
        // Funzioni che vanno anche senza AI (Dossier, anteprima dei documenti PM): si prosegue
        // con i soli dati e il motivo come avviso. La scelta mancante ("Chiedi sempre") no.
        if (!OPERAZIONI[operazione].facoltativa || e.code === 'AI_SCELTA') throw e;
        req.aiScelta = { nome: '', label: '', locale: false, esecuzione: 'immediato', errore: e.message };
      }
      if (req.aiScelta.esecuzione !== 'batch') return next();
      const id = await creaLavoro(req, operazione, scelte);
      res.status(202).json({
        batch: true, lavoro: id, provider: req.aiScelta.label,
        messaggio: `${OPERAZIONI[operazione].etichetta}: richiesta inviata a ${req.aiScelta.label} in modalità Batch (costo dimezzato). Il risultato arriva entro 24 ore, di solito in pochi minuti: riceverai la notifica in campanella e lo trovi in «Risultati AI».`
      });
    } catch (e) {
      if (!e.status) console.error(`❌ AI_LAVORO ${operazione}:`, e.message);
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  };
  return [scelta, handler];
}

async function creaLavoro(req, operazione, scelte) {
  const user = req.user;
  const bodyFile = Buffer.isBuffer(req.body);
  const query = { ...(req.query || {}) };
  delete query._ai; delete query._esecuzione; delete query._titolo;
  let body = bodyFile ? null : (req.body || null);
  if (body && typeof body === 'object') { body = { ...body }; delete body._ai; delete body._esecuzione; delete body._titolo; delete body._extra; }
  const parametri = {
    method: req.method, path: (req.originalUrl || req.url || '').split('?')[0], query, body, bodyFile,
    params: req.params || {}, user, ai: req.aiScelta, extra: scelte.extra
  };
  let r;
  try {
    r = await db.query(
      `INSERT INTO ai_lavori (tenant_id, user_id, operazione, titolo, provider, parametri, server)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [user.tenant_id, user.user_id, operazione, cifra(scelte.titolo || null), req.aiScelta.nome, cifra(JSON.stringify(parametri)), SERVER]
    );
  } catch (e) {
    if (e.code === '42P01') throw errore(503, 'Modalità Batch non ancora attiva: va eseguito lo script Supporto/CreaDB/ai_lavori.sql');
    throw e;
  }
  const lav = { id: r.rows[0].id, tenant_id: user.tenant_id, user_id: user.user_id };
  if (bodyFile) {
    await fs.mkdir(cartella(lav.tenant_id, lav.user_id), { recursive: true });
    await fs.writeFile(fileInput(lav), req.body);
  }
  console.log(`[AI BATCH] Lavoro ${lav.id} (${operazione}) creato per l'utente ${user.user_id} con ${req.aiScelta.label}`);
  eseguiLavoro(lav.id).catch((e) => console.error(`❌ [AI BATCH] ${lav.id}:`, e.message));
  return lav.id;
}

// ----------------------------------------------------------------------------
// ESECUZIONE IN BACKGROUND
// ----------------------------------------------------------------------------
class RispostaFinta {
  constructor() { this.statusCode = 200; this.headers = {}; this.corpo = undefined; }
  status(c) { this.statusCode = c; return this; }
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; }
  set(k, v) { if (typeof k === 'object') Object.entries(k).forEach(([a, b]) => this.setHeader(a, b)); else this.setHeader(k, v); return this; }
  getHeader(k) { return this.headers[String(k).toLowerCase()]; }
  type(t) { return this.setHeader('content-type', t); }
  json(o) { this.corpo = o; return this; }
  send(b) { this.corpo = b; return this; }
  end(b) { if (b !== undefined) this.corpo = b; return this; }
}

const inEsecuzione = new Set();

// Una chiamata all'AI dentro un lavoro: batch inviato una volta (chiave = hash del prompt),
// poi si controlla finché il fornitore risponde. Restituisce { text, label, model }.
async function attendiBatch(lavoro, providerName, prompt, opzioni = {}) {
  const chiave = crypto.createHash('sha256').update(`${providerName}|${opzioni.json ? 1 : 0}|${prompt}`).digest('hex');
  let passo = (await db.query(
    `SELECT batch_id, model, stato, testo, errore, inviato_il < now() - ($3 || ' hours')::interval AS scaduto
       FROM ai_lavori_passi WHERE lavoro_id = $1 AND chiave = $2`,
    [lavoro.id, chiave, String(SCADENZA_ORE)]
  )).rows[0];
  // Piano senza Batch (es. Gemini gratuito): tutto il lavoro prosegue in modalità Immediata.
  const subito = () => askAiProvider(lavoro.user_id, providerName, prompt, { ...opzioni, immediato: true });
  if (!passo && lavoro.ripiego) return subito();
  if (!passo) {
    let inv;
    try {
      inv = await inviaBatchAi(lavoro.user_id, providerName, prompt, opzioni);
    } catch (e) {
      if (!isBatchNonDisponibile(e)) throw e;
      lavoro.ripiego = e.message;
      console.warn(`[AI BATCH] Lavoro ${lavoro.id}: ${e.message} (${e.dettaglio || ''})`);
      return subito();
    }
    await db.query(
      `INSERT INTO ai_lavori_passi (lavoro_id, chiave, provider, model, batch_id) VALUES ($1, $2, $3, $4, $5)`,
      [lavoro.id, chiave, providerName, inv.model, inv.batchId]
    );
    console.log(`[AI BATCH] Lavoro ${lavoro.id}: passaggio inviato a ${inv.label} (${inv.model})`);
    passo = { batch_id: inv.batchId, model: inv.model, stato: 'in_corso' };
    await sleep(ATTESA_PRIMO_CONTROLLO);
  }
  for (;;) {
    if (passo.stato === 'pronto') return { text: passo.testo || '', label: providerName, model: passo.model };
    if (passo.stato === 'fallito') throw errore(502, passo.errore || 'Batch non riuscito');
    if (passo.scaduto) {
      await db.query(`UPDATE ai_lavori_passi SET stato = 'fallito', errore = $3, concluso_il = now() WHERE lavoro_id = $1 AND chiave = $2`,
        [lavoro.id, chiave, `Nessuna risposta entro ${SCADENZA_ORE} ore`]);
      throw errore(504, `${providerName}: nessuna risposta entro ${SCADENZA_ORE} ore`);
    }
    try {
      const esito = await statoBatchAi(lavoro.user_id, providerName, passo.batch_id);
      if (esito.stato === 'pronto') {
        await db.query(`UPDATE ai_lavori_passi SET stato = 'pronto', testo = $3, concluso_il = now() WHERE lavoro_id = $1 AND chiave = $2`,
          [lavoro.id, chiave, cifra(esito.text)]);
        return { text: esito.text, label: esito.label || providerName, model: passo.model };
      }
      if (esito.stato === 'fallito') {
        await db.query(`UPDATE ai_lavori_passi SET stato = 'fallito', errore = $3, concluso_il = now() WHERE lavoro_id = $1 AND chiave = $2`,
          [lavoro.id, chiave, String(esito.errore || '').slice(0, 1000)]);
        throw errore(502, esito.errore || 'Batch non riuscito');
      }
    } catch (e) {
      // Chiave scollegata o non valida: inutile aspettare. Rete o fornitore irraggiungibili: si riprova.
      if (e.status === 400 || e.status === 428 || e.status === 502 || e.status === 504) throw e;
      console.warn(`[AI BATCH] Lavoro ${lavoro.id}: controllo non riuscito (${e.message}), riprovo`);
    }
    await db.query(`UPDATE ai_lavori SET heartbeat = now() WHERE id = $1`, [lavoro.id]).catch(() => {});
    await sleep(ATTESA_CONTROLLI);
    const r = (await db.query(
      `SELECT inviato_il < now() - ($3 || ' hours')::interval AS scaduto FROM ai_lavori_passi WHERE lavoro_id = $1 AND chiave = $2`,
      [lavoro.id, chiave, String(SCADENZA_ORE)])).rows[0];
    passo.scaduto = r && r.scaduto;
  }
}

function nomeDaHeader(cd, operazione) {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(String(cd || ''));
  let nome = '';
  try { nome = m ? decodeURIComponent(m[1]) : ''; } catch { nome = ''; }
  return (nome || `${OPERAZIONI[operazione].etichetta}.bin`).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 200);
}

export async function eseguiLavoro(id) {
  if (inEsecuzione.has(id)) return;
  inEsecuzione.add(id);
  let l;
  try {
    // Prenotazione: un lavoro lo esegue solo il server che lo ha creato, una volta sola.
    l = (await db.query(
      `UPDATE ai_lavori SET heartbeat = now() WHERE id = $1 AND stato = 'in_corso' AND server = $2
       RETURNING id::text AS id, tenant_id, user_id, operazione, titolo, parametri`,
      [id, SERVER]
    )).rows[0];
    if (!l) return;
    const p = JSON.parse(l.parametri);
    const handler = REGISTRO.get(l.operazione);
    if (!handler) throw new Error(`Funzione «${l.operazione}» non disponibile su questo server`);
    const body = p.bodyFile ? await fs.readFile(fileInput(l)) : p.body;
    const req = {
      user: p.user, query: p.query || {}, body, params: p.params || {}, method: p.method, url: p.path, originalUrl: p.path,
      headers: {}, ip: '', aiScelta: { ...p.ai, esecuzione: 'batch' },
      get: () => undefined, header: () => undefined
    };
    const res = new RispostaFinta();
    await conContestoAudit({ userId: l.user_id, tenantId: l.tenant_id, origine: `job:ai_batch ${l.operazione}` },
      () => contestoAi.run({ attendiBatch: (prov, prompt, opz) => attendiBatch(l, prov, prompt, opz) }, () => handler(req, res)));

    if (res.statusCode >= 400) {
      const msg = (res.corpo && res.corpo.error) || `Errore ${res.statusCode}`;
      throw errore(res.statusCode, msg);
    }
    if (Buffer.isBuffer(res.corpo)) {
      const nome = nomeDaHeader(res.getHeader('content-disposition'), l.operazione);
      const dir = cartella(l.tenant_id, l.user_id);
      await fs.mkdir(dir, { recursive: true });
      const percorso = path.join(dir, `${l.id}${path.extname(nome) || '.bin'}`);
      await fs.writeFile(percorso, res.corpo);
      // Intestazioni utili alla finestra (es. AI usata, revisione del Kick-off).
      const info = Object.fromEntries(Object.entries(res.headers).filter(([k]) => k.startsWith('x-')).map(([k, v]) => {
        try { return [k, decodeURIComponent(String(v))]; } catch { return [k, String(v)]; }
      }));
      await db.query(
        `UPDATE ai_lavori SET stato = 'pronto', file_path = $2, file_nome = $3, file_mime = $4, risultato = $5, errore = $6, concluso_il = now(), heartbeat = now() WHERE id = $1`,
        [l.id, percorso, cifra(nome), String(res.getHeader('content-type') || 'application/octet-stream'), cifra(JSON.stringify({ info })), l.ripiego || null]
      );
    } else {
      await db.query(
        `UPDATE ai_lavori SET stato = 'pronto', risultato = $2, errore = $3, concluso_il = now(), heartbeat = now() WHERE id = $1`,
        [l.id, cifra(JSON.stringify(res.corpo === undefined ? {} : res.corpo)), l.ripiego || null]
      );
    }
    console.log(`[AI BATCH] ✓ Lavoro ${l.id} (${l.operazione}) pronto${l.ripiego ? ' (eseguito Immediato: Batch non disponibile)' : ''}`);
    await notificaLavoroAi({ tenantId: l.tenant_id, userId: l.user_id, lavoroId: l.id, operazione: OPERAZIONI[l.operazione].etichetta, titolo: l.titolo, ok: true, nota: l.ripiego });
  } catch (e) {
    if (!l) throw e;
    console.error(`❌ [AI BATCH] Lavoro ${l.id} (${l.operazione}):`, e.message);
    await db.query(`UPDATE ai_lavori SET stato = 'errore', errore = $2, concluso_il = now() WHERE id = $1`, [l.id, String(e.message || e).slice(0, 1000)]).catch(() => {});
    await notificaLavoroAi({ tenantId: l.tenant_id, userId: l.user_id, lavoroId: l.id, operazione: OPERAZIONI[l.operazione]?.etichetta || l.operazione, titolo: l.titolo, ok: false, errore: e.message });
  } finally {
    inEsecuzione.delete(id);
    if (l) await fs.rm(fileInput(l), { force: true }).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// RIPRESA DOPO UN RIAVVIO E PULIZIA (ogni 5 minuti, su ogni server per i suoi lavori)
// ----------------------------------------------------------------------------
// Restituisce il report (job «lavori_ai» dello schedulatore, pagina Monitor › Schedulazioni).
export async function eseguiGiroLavoriAi() {
  const report = { ok: true, server: SERVER, inCorso: 0, ripresi: 0, eliminati: 0 };
  try {
    report.inCorso = (await db.query(
      `SELECT count(*)::int AS n FROM ai_lavori WHERE stato = 'in_corso' AND server = $1`, [SERVER])).rows[0].n;
    const r = await db.query(
      `SELECT id::text AS id FROM ai_lavori WHERE stato = 'in_corso' AND server = $1
          AND (heartbeat IS NULL OR heartbeat < now() - interval '3 minutes')`,
      [SERVER]
    );
    report.ripresi = r.rows.filter((x) => !inEsecuzione.has(x.id)).length;
    for (const x of r.rows) eseguiLavoro(x.id).catch((e) => console.error(`❌ [AI BATCH] ripresa ${x.id}:`, e.message));
    // Pulizia: lavori (e file) più vecchi di GIORNI_CONSERVAZIONE giorni.
    const vecchi = await db.query(
      `SELECT id::text AS id, file_path FROM ai_lavori
        WHERE server = $1 AND stato <> 'in_corso' AND COALESCE(concluso_il, creato_il) < now() - ($2 || ' days')::interval`,
      [SERVER, String(GIORNI_CONSERVAZIONE)]
    );
    for (const v of vecchi.rows) {
      if (v.file_path) await fs.rm(v.file_path, { force: true }).catch(() => {});
      await db.query('DELETE FROM ai_lavori WHERE id = $1', [v.id]);
      report.eliminati += 1;
    }
  } catch (e) {
    if (e.code === '42P01') return { ...report, nota: 'Tabella ai_lavori non ancora creata (Supporto/CreaDB/ai_lavori.sql)' };
    console.error('❌ [AI BATCH] giro di controllo:', e.message);
    throw e;
  }
  return report;
}

// All'avvio si riprendono subito i lavori interrotti. Il giro periodico lo fa lo schedulatore
// (job «lavori_ai», sulla VM); dove lo schedulatore è spento (backend locale) un timer interno.
export function avviaLavoriAi({ conSchedulatore = false } = {}) {
  const giro = () => eseguiGiroLavoriAi().catch(() => {});
  setTimeout(giro, 15000);
  if (!conSchedulatore) setInterval(giro, 5 * 60 * 1000);
}
