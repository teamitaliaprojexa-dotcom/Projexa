// === INTEGRAZIONE JIRA CLOUD (SOLA LETTURA) ===
//
// Flusso OAuth 2.0 3LO di Atlassian con soli scope di lettura: l'app non può
// creare né modificare nulla su Jira. I dati di autenticazione vengono salvati
// sul progetto Neon "Projexa-Auth", tabella integr_tok_auth, una riga per elemento
// (vedi config/integrations.js) con provider_integrazione = 'Jira'.
//
// L'integrazione è subordinata al flag booleano in settings (campo = 'Jira',
// valore1 = true) dell'utente/tenant del login: se il flag è false, le righe
// dell'utente su integr_tok_auth vengono cancellate e per riattivare l'integrazione
// occorre rifare tutta la procedura di autorizzazione.
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db from '../config/database.js';
import JWT_SECRET from '../config/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { isAllowedOrigin } from '../config/origins.js';
import {
  getIntegration,
  saveIntegration,
  updateIntegrationElements,
  deleteIntegration
} from '../config/integrations.js';

const router = express.Router();

const PROVIDER = 'Jira';
const TIPO_INTEGRAZIONE = 'issue_tracking';

// Scope di sola lettura + offline_access (necessario per il refresh token, cioè
// per non dover rifare l'autorizzazione a ogni accesso dell'utente).
const SCOPES = ['read:jira-work', 'read:jira-user', 'offline_access'];

const AUTH_BASE = 'https://auth.atlassian.com';
const API_BASE = 'https://api.atlassian.com';
const PAGE_SIZE = 100;

const CLIENT_ID = process.env.JIRA_CLIENT_ID;
const CLIENT_SECRET = process.env.JIRA_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://projexa-4mix.onrender.com';
const REDIRECT_URI = `${BACKEND_URL}/api/jira/callback`;

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ==========================================
// FLAG IN SETTINGS
// ==========================================

// L'integrazione è attiva se esiste una riga settings con campo = 'Jira' e
// valore1 = true per il tenant/utente del token (confronto case-insensitive sul campo).
async function isJiraEnabled(user) {
  const result = await db.query(
    `SELECT 1 FROM settings
      WHERE tenant_id = $1 AND user_id = $2 AND lower(campo) = 'jira' AND valore1 = true
      LIMIT 1`,
    [user.tenant_id, user.user_id]
  );
  return result.rows.length > 0;
}

// Middleware: blocca la richiesta se il flag è disattivato e, contestualmente,
// cancella i dati di autenticazione dell'utente (requisito: flag false => dati rimossi).
async function requireJiraEnabled(req, res, next) {
  try {
    if (await isJiraEnabled(req.user)) return next();
    const removed = await deleteIntegration(req.user.user_id, PROVIDER);
    if (removed) console.log(`[JIRA] Flag disattivato: rimosse ${removed} righe per l'utente ${req.user.user_id}`);
    return res.status(403).json({ error: 'Integrazione Jira non abilitata nelle impostazioni', code: 'JIRA_DISABLED' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ==========================================
// OAUTH
// ==========================================

async function exchangeToken(body) {
  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body })
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Atlassian token endpoint ${response.status}: ${text.slice(0, 300)}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

// Salva la coppia di token e la relativa scadenza. Il refresh token di Atlassian è
// rotante: a ogni refresh ne arriva uno nuovo e il precedente non è più valido.
function tokenElements(tokenData) {
  const expiresAt = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();
  return {
    elements: {
      jira_access_token: tokenData.access_token,
      jira_refresh_token: tokenData.refresh_token,
      jira_token_expires_at: expiresAt,
      jira_scopes: tokenData.scope || SCOPES.join(' ')
    },
    // Il refresh token rotante scade dopo 90 giorni di inutilizzo: la data serve
    // solo come promemoria leggibile nella tabella.
    expiry: { jira_refresh_token: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) }
  };
}

// Restituisce un access token valido, rinnovandolo se scaduto o in scadenza.
// Se il refresh fallisce (consenso revocato, token ruotato altrove) cancella
// l'integrazione e segnala che serve rifare l'autorizzazione.
async function getJiraSession(userId) {
  const el = await getIntegration(userId, PROVIDER);
  if (!el.jira_refresh_token || !el.jira_cloud_id) {
    const err = new Error('Jira non collegato');
    err.status = 428;
    err.code = 'JIRA_NOT_CONNECTED';
    throw err;
  }

  const expiresAt = Date.parse(el.jira_token_expires_at || '');
  const stillValid = el.jira_access_token && Number.isFinite(expiresAt) && expiresAt - Date.now() > 60000;

  if (!stillValid) {
    let tokenData;
    try {
      tokenData = await exchangeToken({ grant_type: 'refresh_token', refresh_token: el.jira_refresh_token });
    } catch (error) {
      console.error('[JIRA] Refresh token non più valido:', error.message);
      await deleteIntegration(userId, PROVIDER);
      const err = new Error('Autorizzazione Jira scaduta: ricollega il tuo account');
      err.status = 428;
      err.code = 'JIRA_REAUTH_REQUIRED';
      throw err;
    }
    const { elements, expiry } = tokenElements(tokenData);
    await updateIntegrationElements(userId, PROVIDER, TIPO_INTEGRAZIONE, elements, expiry);
    el.jira_access_token = elements.jira_access_token;
    console.log(`[JIRA] Access token rinnovato per l'utente ${userId}`);
  }

  const session = {
    accessToken: el.jira_access_token,
    cloudId: el.jira_cloud_id,
    siteUrl: el.jira_site_url || '',
    accountId: el.jira_account_id || ''
  };

  // Se al momento del collegamento /myself non aveva risposto, l'accountId è rimasto
  // vuoto e l'elenco dei filtri ripiega su /filter/my (solo quelli di proprietà).
  // Si recupera qui, una volta sola, e si salva: al giro dopo è già a posto.
  if (!session.accountId) {
    try {
      const me = await jiraApi(session, '/rest/api/3/myself');
      if (me && me.accountId) {
        session.accountId = me.accountId;
        await updateIntegrationElements(userId, PROVIDER, TIPO_INTEGRAZIONE, {
          jira_account_id: me.accountId,
          ...(me.displayName ? { jira_display_name: me.displayName } : {})
        });
        console.log(`[JIRA] accountId recuperato per l'utente ${userId}`);
      }
    } catch (e) {
      console.warn('[JIRA] accountId non recuperabile:', e.message);
    }
  }

  return session;
}

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Quanto attendere prima di riprovare dopo un 429/503. Jira indica l'attesa con
// l'header Retry-After (secondi); se manca si usa un ritardo crescente. Il tetto
// evita che una richiesta resti appesa troppo a lungo.
const MAX_ATTESA_MS = 60000;

function attesaPrimaDiRiprovare(response, tentativo) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_ATTESA_MS);
  return Math.min(2000 * Math.pow(3, tentativo), MAX_ATTESA_MS); // 2s, 6s, 18s, 54s
}

// Chiamata alle API di Jira Cloud. Sono usati solo endpoint di lettura: il POST
// serve unicamente per /search/jql e /search/approximate-count, che sono ricerche.
//
// Jira applica un limite di frequenza: con molte chiamate ravvicinate (la
// sincronizzazione ne fa centinaia) risponde 429. In quel caso non si fallisce
// subito, si aspetta e si riprova: un 429 è una richiesta di rallentare, non un
// errore vero. Stesso trattamento per il 503 (servizio momentaneamente occupato).
async function jiraApi(session, path, { method = 'GET', body, tentativiMax = 4 } = {}) {
  for (let tentativo = 0; ; tentativo++) {
    let response;
    try {
      response = await fetch(`${API_BASE}/ex/jira/${session.cloudId}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (e) {
      // La chiamata non è nemmeno partita (connessione caduta, DNS, timeout di rete):
      // fetch lancia invece di rispondere. Capita durante le attese lunghe imposte
      // da un 429, quindi va ritentata come gli altri errori temporanei.
      if (tentativo >= tentativiMax) {
        const err = new Error(`Jira non raggiungibile su ${path}: ${e.message}`);
        err.status = 503;
        throw err;
      }
      const attesa = Math.min(2000 * Math.pow(3, tentativo), MAX_ATTESA_MS);
      console.warn(`[JIRA] rete non disponibile su ${path} (${e.message}): attendo ${Math.round(attesa / 1000)}s e riprovo (${tentativo + 1}/${tentativiMax})`);
      await pausa(attesa);
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }

    if ((response.status === 429 || response.status === 503) && tentativo < tentativiMax) {
      const attesa = attesaPrimaDiRiprovare(response, tentativo);
      console.warn(`[JIRA] ${response.status} su ${path}: attendo ${Math.round(attesa / 1000)}s e riprovo (${tentativo + 1}/${tentativiMax})`);
      await pausa(attesa);
      continue;
    }

    const text = await response.text();
    const err = new Error(response.status === 429
      ? `Jira ha limitato le richieste (429) su ${path} anche dopo ${tentativiMax} tentativi: riprova fra qualche minuto.`
      : `Jira API ${response.status} su ${path}: ${text.slice(0, 300)}`);
    err.status = response.status === 401 ? 428 : response.status;
    err.jiraStatus = response.status;
    err.body = text;
    throw err;
  }
}

// ==========================================
// JQL: ordinamento e ricerca testuale
// ==========================================

// Trova la posizione dell'ultimo "ORDER BY" di primo livello (fuori dalle stringhe).
function findOrderByIndex(jql) {
  let quote = null;
  let found = -1;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    const boundary = i === 0 || !/[A-Za-z0-9_]/.test(jql[i - 1]);
    if ((ch === 'o' || ch === 'O') && boundary && /^order\s+by\b/i.test(jql.slice(i))) found = i;
  }
  return found;
}

function splitOrderBy(jql) {
  const text = String(jql || '').trim();
  const idx = findOrderByIndex(text);
  if (idx < 0) return { where: text, order: '' };
  return { where: text.slice(0, idx).trim(), order: text.slice(idx).trim() };
}

// Nome del campo così come lo accetta la clausola ORDER BY di JQL.
function jqlOrderField(field) {
  if (!/^[A-Za-z0-9_]+$/.test(field || '')) return null;
  if (field === 'issuekey') return 'key';
  const custom = /^customfield_(\d+)$/.exec(field);
  return custom ? `cf[${custom[1]}]` : field;
}

function escapeJqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Compone la JQL finale: filtro originale (+ ricerca testuale) + ordinamento scelto
// dall'utente; se non ne ha scelto uno, resta quello salvato nel filtro Jira.
function buildJql(filterJql, { search, orderBy, orderDir }) {
  const { where, order } = splitOrderBy(filterJql);
  let clause = where;
  const term = String(search || '').trim();
  if (term) {
    const escaped = `text ~ "${escapeJqlString(term)}"`;
    clause = clause ? `(${clause}) AND ${escaped}` : escaped;
  }
  const field = orderBy ? jqlOrderField(orderBy) : null;
  if (field) {
    const dir = String(orderDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    return { jql: `${clause} ORDER BY ${field} ${dir}`.trim(), custom: true };
  }
  return { jql: `${clause} ${order}`.trim(), custom: false };
}

// ==========================================
// COLONNE E VALORI
// ==========================================

const DEFAULT_COLUMNS = [
  { value: 'issuekey', label: 'Chiave' },
  { value: 'issuetype', label: 'Tipo' },
  { value: 'summary', label: 'Riepilogo' },
  { value: 'status', label: 'Stato' },
  { value: 'priority', label: 'Priorità' },
  { value: 'assignee', label: 'Assegnatario' },
  { value: 'reporter', label: 'Segnalatore' },
  { value: 'project', label: 'Progetto' },
  { value: 'created', label: 'Creato' },
  { value: 'updated', label: 'Aggiornato' },
  { value: 'duedate', label: 'Scadenza' },
  { value: 'resolution', label: 'Risoluzione' }
];

// Colonne configurate nel filtro che non corrispondono a un campo richiedibile via API.
const PSEUDO_COLUMNS = new Set(['issuekey', 'thumbnail']);

function fieldsFromColumns(columns) {
  return columns.map((c) => c.value).filter((v) => v && !PSEUDO_COLUMNS.has(v));
}

// Estrae il testo da un documento ADF (Atlassian Document Format), usato per
// descrizione, commenti e campi di testo ricco.
function adfToText(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) return node.content.map(adfToText).filter(Boolean).join(' ');
  return '';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}|$)/;

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return value.length > 10 ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

// Converte il valore di un campo Jira (spesso un oggetto) in testo per la griglia.
function formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return ISO_DATE.test(value) ? formatDate(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.type === 'doc') return adfToText(value);
    const direct = value.displayName || value.name || value.value || value.emailAddress || value.key;
    if (direct) return String(direct);
    if (typeof value.progress === 'number' && typeof value.total === 'number') {
      return value.total ? `${Math.round((value.progress / value.total) * 100)}%` : '';
    }
    return '';
  }
  return '';
}

function issueToRow(issue, columns, siteUrl) {
  const row = {
    _key: issue.key,
    _url: siteUrl ? `${siteUrl}/browse/${issue.key}` : ''
  };
  for (const col of columns) {
    row[col.value] = col.value === 'issuekey'
      ? (issue.key || '')
      : formatValue((issue.fields || {})[col.value]);
  }
  return row;
}

// ==========================================
// ENDPOINT
// ==========================================

// Stato dell'integrazione per l'utente del login. Chiamato all'apertura della
// dashboard: se il flag in settings è false, qui avviene anche la pulizia dei token.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const enabled = await isJiraEnabled(req.user);
    if (!enabled) {
      const removed = await deleteIntegration(req.user.user_id, PROVIDER);
      if (removed) console.log(`[JIRA] Flag disattivato: rimosse ${removed} righe per l'utente ${req.user.user_id}`);
      return res.json({ enabled: false, connected: false, configured: isConfigured() });
    }
    const el = await getIntegration(req.user.user_id, PROVIDER);
    res.json({
      enabled: true,
      configured: isConfigured(),
      connected: !!(el.jira_refresh_token && el.jira_cloud_id),
      email: el.jira_email || null,
      site_url: el.jira_site_url || null,
      account_id: el.jira_account_id || null
    });
  } catch (error) {
    console.error('❌ JIRA_STATUS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// URL a cui aprire la finestra di consenso Atlassian. Lo "state" è un JWT firmato
// che lega l'autorizzazione all'utente e all'origine da cui è partita: protegge da
// CSRF e dice al callback a chi inviare l'esito.
router.get('/authorize-url', requireAuth, requireJiraEnabled, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'JIRA_CLIENT_ID / JIRA_CLIENT_SECRET non configurati sul server' });
    }

    let origin = req.get('origin') || '';
    if (!origin && req.get('referer')) {
      try { origin = new URL(req.get('referer')).origin; } catch { origin = ''; }
    }
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(400).json({ error: 'Origine non consentita' });
    }
    if (!origin) origin = new URL(BACKEND_URL).origin; // richiesta same-origin

    const state = jwt.sign(
      { uid: req.user.user_id, tid: req.user.tenant_id, email: req.user.email, origin, nonce: crypto.randomBytes(8).toString('hex') },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
      redirect_uri: REDIRECT_URI,
      state,
      response_type: 'code',
      prompt: 'consent'
    });

    res.json({ url: `${AUTH_BASE}/authorize?${params.toString()}` });
  } catch (error) {
    console.error('❌ JIRA_AUTHORIZE_URL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Pagina restituita al termine del consenso: comunica l'esito alla finestra che
// ha aperto il popup e si chiude. I dati sono serializzati in JSON con "<" neutralizzato
// per evitare qualsiasi rottura del tag <script>.
function callbackPage(origin, payload) {
  const json = JSON.stringify({ source: 'projexa-jira', ...payload }).replace(/</g, '\\u003c');
  const safeOrigin = JSON.stringify(origin).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><title>Jira</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; color: #1F2937;">
<p>${payload.ok ? 'Collegamento a Jira completato. Puoi chiudere questa finestra.' : 'Collegamento a Jira non riuscito. Puoi chiudere questa finestra.'}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${json}, ${safeOrigin}); } catch (e) {}
  setTimeout(function () { window.close(); }, 800);
</script>
</body></html>`;
}

// Callback OAuth: arriva da Atlassian, quindi senza il JWT di Projexa nell'header.
// L'identità dell'utente viene dallo "state" firmato all'avvio del flusso.
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  let origin = new URL(BACKEND_URL).origin;

  try {
    if (!state) return res.status(400).send(callbackPage(origin, { ok: false, error: 'state mancante' }));

    let claims;
    try {
      claims = jwt.verify(state, JWT_SECRET);
    } catch {
      return res.status(400).send(callbackPage(origin, { ok: false, error: 'state non valido o scaduto' }));
    }
    if (claims.origin && isAllowedOrigin(claims.origin)) origin = claims.origin;

    if (error) {
      return res.status(400).send(callbackPage(origin, { ok: false, error: error_description || error }));
    }
    if (!code) {
      return res.status(400).send(callbackPage(origin, { ok: false, error: 'codice di autorizzazione mancante' }));
    }

    // Il flag potrebbe essere stato disattivato mentre l'utente autorizzava: in quel
    // caso non si salva nulla, altrimenti resterebbero token per un'integrazione spenta.
    if (!(await isJiraEnabled({ tenant_id: claims.tid, user_id: claims.uid }))) {
      await deleteIntegration(claims.uid, PROVIDER);
      return res.status(403).send(callbackPage(origin, { ok: false, error: 'Integrazione Jira non abilitata nelle impostazioni' }));
    }

    // 1) Codice -> token
    const tokenData = await exchangeToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });
    const session = { accessToken: tokenData.access_token, cloudId: null };

    // 2) Sito Jira autorizzato (cloudId + url). Se l'utente ne ha più di uno viene
    //    preso il primo: l'integrazione lavora su un sito alla volta.
    const resourcesRes = await fetch(`${API_BASE}/oauth/token/accessible-resources`, {
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' }
    });
    const resources = resourcesRes.ok ? await resourcesRes.json() : [];
    if (!Array.isArray(resources) || resources.length === 0) {
      return res.status(400).send(callbackPage(origin, { ok: false, error: 'Nessun sito Jira accessibile con questo account' }));
    }
    session.cloudId = resources[0].id;

    // 3) Identità dell'account Atlassian (accountId, email quando non è nascosta
    //    dalle impostazioni privacy di Atlassian).
    let me = {};
    try {
      me = await jiraApi(session, '/rest/api/3/myself');
    } catch (e) {
      console.warn('[JIRA] /myself non disponibile:', e.message);
    }

    const { elements, expiry } = tokenElements(tokenData);
    await saveIntegration(claims.uid, PROVIDER, TIPO_INTEGRAZIONE, {
      projexa_email: claims.email || '',
      jira_email: me.emailAddress || claims.email || '',
      jira_account_id: me.accountId || '',
      jira_display_name: me.displayName || '',
      jira_cloud_id: session.cloudId,
      jira_site_url: resources[0].url || '',
      jira_site_name: resources[0].name || '',
      ...elements
    }, expiry);

    console.log(`[JIRA] ✓ Account collegato per l'utente ${claims.uid} sul sito ${resources[0].url}`);
    res.send(callbackPage(origin, {
      ok: true,
      site_url: resources[0].url || '',
      email: me.emailAddress || claims.email || ''
    }));
  } catch (err) {
    console.error('❌ JIRA_CALLBACK:', err.message);
    res.status(500).send(callbackPage(origin, { ok: false, error: err.message }));
  }
});

// Scollega l'account: rimuove tutte le righe dell'utente su integr_tok_auth.
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const removed = await deleteIntegration(req.user.user_id, PROVIDER);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('❌ JIRA_DISCONNECT:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Elenco dei filtri salvati DELL'UTENTE (owner = account collegato).
// Estratta dalla route perché la usa anche la sincronizzazione delle integrazioni,
// che deve ritrovare un filtro partendo dal suo nome (jobs/jiraSyncEngine.js).
async function listFilters(session) {
  const filters = [];

  if (session.accountId) {
    let startAt = 0;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({
        accountId: session.accountId,
        expand: 'jql',
        orderBy: 'name',
        maxResults: '50',
        startAt: String(startAt)
      });
      const data = await jiraApi(session, `/rest/api/3/filter/search?${params.toString()}`);
      for (const f of data.values || []) filters.push({ id: String(f.id), name: f.name, jql: f.jql || '' });
      if (data.isLast !== false) break;
      startAt += (data.values || []).length || 50;
    }
  } else {
    // Ripiego (accountId non disponibile): oltre ai filtri di proprietà si prendono
    // anche quelli preferiti, altrimenti un filtro condiviso da un collega non
    // comparirebbe e la sincronizzazione non lo troverebbe.
    const mine = await jiraApi(session, '/rest/api/3/filter/my?expand=jql&includeFavourites=true');
    for (const f of mine || []) filters.push({ id: String(f.id), name: f.name, jql: f.jql || '' });
  }

  return filters;
}

router.get('/filters', requireAuth, requireJiraEnabled, async (req, res) => {
  try {
    const session = await getJiraSession(req.user.user_id);
    const filters = await listFilters(session);
    res.json({ filters });
  } catch (error) {
    console.error('❌ JIRA_FILTERS:', error.message);
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});

// Legge JQL e colonne configurate di un filtro. Le colonne del filtro diventano
// le colonne della griglia; se non ne ha, si usa un set predefinito.
async function loadFilter(session, filterId) {
  const filter = await jiraApi(session, `/rest/api/3/filter/${encodeURIComponent(filterId)}?expand=jql`);
  let columns = [];
  try {
    const cols = await jiraApi(session, `/rest/api/3/filter/${encodeURIComponent(filterId)}/columns`);
    columns = (cols || [])
      .filter((c) => c && c.value && /^[A-Za-z0-9_]+$/.test(c.value))
      .map((c) => ({ value: c.value, label: c.label || c.value }));
  } catch (e) {
    console.warn(`[JIRA] Colonne del filtro ${filterId} non disponibili:`, e.message);
  }
  if (columns.length === 0) columns = [...DEFAULT_COLUMNS];
  // La chiave dell'issue è sempre utile come prima colonna.
  if (!columns.some((c) => c.value === 'issuekey')) columns.unshift({ value: 'issuekey', label: 'Chiave' });
  return { name: filter.name, jql: filter.jql || '', columns };
}

// Esegue la ricerca del filtro. Pagine da 100 righe con i token di paginazione
// dell'API Jira (nextPageToken): il frontend tiene lo storico per tornare indietro.
router.post('/search', requireAuth, requireJiraEnabled, async (req, res) => {
  try {
    const { filterId, search = '', orderBy = '', orderDir = 'ASC', pageToken = null } = req.body || {};
    if (!filterId) return res.status(400).json({ error: 'filterId richiesto' });

    const session = await getJiraSession(req.user.user_id);
    const filter = await loadFilter(session, filterId);

    let columns = filter.columns;
    let { jql, custom } = buildJql(filter.jql, { search, orderBy, orderDir });
    let orderApplied = true;
    let data = null;

    // Tentativi in cascata: se Jira rifiuta le colonne del filtro (campo non più
    // esistente) si ripiega sulle colonne standard; se rifiuta l'ordinamento
    // (campo non ordinabile in JQL) si ripiega sull'ordine originale del filtro.
    const attempts = [
      () => ({ cols: columns, q: jql }),
      () => ({ cols: DEFAULT_COLUMNS, q: jql }),
      () => ({ cols: DEFAULT_COLUMNS, q: buildJql(filter.jql, { search }).jql, noOrder: true })
    ];

    let lastError = null;
    for (const attempt of attempts) {
      const { cols, q, noOrder } = attempt();
      try {
        data = await jiraApi(session, '/rest/api/3/search/jql', {
          method: 'POST',
          body: {
            jql: q,
            maxResults: PAGE_SIZE,
            fields: fieldsFromColumns(cols),
            ...(pageToken ? { nextPageToken: pageToken } : {})
          }
        });
        columns = cols;
        jql = q;
        if (noOrder && custom) orderApplied = false;
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (e.jiraStatus !== 400) break; // 401/403/... non si risolvono riprovando
      }
    }
    if (!data) throw lastError || new Error('Ricerca Jira non riuscita');

    const issues = data.issues || [];
    const rows = issues.map((issue) => issueToRow(issue, columns, session.siteUrl));

    // Conteggio approssimativo dell'intero risultato (best effort: se non
    // disponibile la griglia mostra solo il numero di pagina).
    let approxTotal = null;
    if (!pageToken) {
      try {
        const count = await jiraApi(session, '/rest/api/3/search/approximate-count', {
          method: 'POST',
          body: { jql }
        });
        if (typeof count.count === 'number') approxTotal = count.count;
      } catch (e) {
        console.warn('[JIRA] Conteggio approssimato non disponibile:', e.message);
      }
    }

    res.json({
      filterName: filter.name,
      columns,
      rows,
      pageSize: PAGE_SIZE,
      nextPageToken: data.nextPageToken || null,
      isLast: !data.nextPageToken,
      approxTotal,
      orderApplied,
      siteUrl: session.siteUrl,
      jql
    });
  } catch (error) {
    console.error('❌ JIRA_SEARCH:', error.message);
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});

export default router;

// Esportate per poterle verificare in isolamento (composizione JQL e resa dei valori).
export { splitOrderBy, jqlOrderField, buildJql, formatValue, issueToRow };

// Esportate per la sincronizzazione delle integrazioni (backend/jobs/*): sono le
// stesse funzioni usate dalle route, così il job vede Jira esattamente come il
// pannello a video (stessa sessione, stessi filtri, stessa resa dei valori).
export { getJiraSession, jiraApi, loadFilter, listFilters, isJiraEnabled, fieldsFromColumns, PAGE_SIZE };
