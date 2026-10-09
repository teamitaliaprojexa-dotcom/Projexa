// === INTEGRAZIONE CALENDARIO (Google Calendar + Outlook/Microsoft 365, SOLA LETTURA) ===
//
// Stesso schema dell'integrazione Jira (vedi routes/jira.js): OAuth 2.0 con scope di
// sola lettura, i dati di autenticazione vengono salvati sul database
// "Projexa-Auth", tabella integr_tok_auth, una riga per elemento (vedi
// config/integrations.js) con tipo_integrazione = 'Calendar' e
// provider_integrazione = 'Google' oppure 'Outlook'.
//
// A differenza del vecchio calendar.js, il token NON arriva più dal login (via URL o
// localStorage): ogni provider ha una propria connessione OAuth dedicata, indipendente
// dal login applicativo, con refresh automatico del token quando scade.
//
// Riusa le stesse credenziali OAuth già configurate per il login (GOOGLE_CLIENT_ID/
// SECRET, MICROSOFT_CLIENT_ID/SECRET/TENANT_ID): sullo stesso client basta aggiungere
// il nuovo redirect URI e i nuovi scope (vedi fondo file / .env.example).
import express from 'express';
import ical from 'node-ical';
import jwt from 'jsonwebtoken';
import db from '../config/database.js';
import {
  encRec, enqueueChunk, enqueueLostNotes, enqueueFinalize, generateRecap, pendingChunks, queuedEndOffset, warmWhisperServices,
  recapInProgress, recapBatchInCorso, loadCorrections, applyCorrections, applyCorrectionsHtml, stripMarkdown, speakerName,
  copiaTrascrizioneCondivisa, recapAiImpostata, recapEsecuzione, isChiediSempre
} from '../jobs/meetingTranscription.js';
import { inviaRecapBatch, controllaRecapBatchUtente } from '../jobs/recapBatch.js';
import { parseRecapActions, parseDueDate, ownerVariants } from '../jobs/recapTasks.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { localRecapMode, aiCollegate, PROVIDERS as AI_PROVIDERS } from './ai.js';
import JWT_SECRET from '../config/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { startLinkState, checkLinkState } from '../config/oauthLinkState.js';
import { isAllowedOrigin } from '../config/origins.js';
import {
  getIntegration,
  saveIntegration,
  updateIntegrationElements,
  deleteIntegration
} from '../config/integrations.js';

const router = express.Router();

const TIPO_INTEGRAZIONE = 'Calendar';
const BACKEND_URL = process.env.BACKEND_URL || 'https://www.projexa.it';
const MS_TENANT = process.env.MICROSOFT_TENANT_ID || 'common';

// Configurazione dei due provider supportati. "prefix" è il prefisso degli elementi
// su integr_tok_auth (es. google_access_token, outlook_refresh_token).
const PROVIDERS = {
  google: {
    provider: 'Google',
    label: 'Google Calendar',
    prefix: 'google',
    // Stesso fallback del login Google (routes/auth.js): il client ID non è un segreto.
    clientId: process.env.GOOGLE_CLIENT_ID || '128379880931-guh70j47lsvplo9m1intpj9tt7escdn8.apps.googleusercontent.com',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: ['https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'],
    redirectUri: `${BACKEND_URL}/api/calendar/google/callback`,
    // access_type=offline + prompt=consent: indispensabili per ottenere un refresh_token
    // (senza, Google lo restituisce solo la primissima volta in assoluto).
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
  },
  outlook: {
    provider: 'Outlook',
    label: 'Outlook Calendar',
    prefix: 'outlook',
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authUrl: `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scope: ['offline_access', 'openid', 'email', 'https://graph.microsoft.com/Calendars.Read'],
    redirectUri: `${BACKEND_URL}/api/calendar/outlook/callback`,
    extraAuthParams: { prompt: 'consent' }
  }
};

function isConfigured(cfg) {
  return !!(cfg.clientId && cfg.clientSecret);
}

// Valida il parametro :provider delle route (solo google|outlook).
function requireProvider(req, res, next) {
  const cfg = PROVIDERS[req.params.provider];
  if (!cfg) return res.status(404).json({ error: 'Provider non supportato' });
  req.calendarProvider = cfg;
  next();
}

// ==========================================
// OAUTH: SCAMBIO E RINNOVO TOKEN
// ==========================================

async function postForm(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString()
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Token endpoint ${response.status}: ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  return JSON.parse(text);
}

function exchangeCode(cfg, code) {
  return postForm(cfg.tokenUrl, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code'
  });
}

function refreshAccessToken(cfg, refreshToken) {
  return postForm(cfg.tokenUrl, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
}

// Salva access token + scadenza; il refresh token viene incluso solo se il provider
// ne ha restituito uno nuovo (Google in refresh normalmente NON lo rimanda: in quel
// caso la chiave resta assente e updateIntegrationElements lascia intatto il vecchio).
function tokenElements(cfg, tokenData) {
  const p = cfg.prefix;
  const expiresAt = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();
  const elements = {
    [`${p}_access_token`]: tokenData.access_token,
    [`${p}_token_expires_at`]: expiresAt,
    [`${p}_scopes`]: tokenData.scope || cfg.scope.join(' ')
  };
  if (tokenData.refresh_token) elements[`${p}_refresh_token`] = tokenData.refresh_token;
  return elements;
}

async function fetchProfile(cfg, accessToken) {
  try {
    const res = await fetch(cfg.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (!res.ok) return {};
    const data = await res.json();
    // Google: email; Microsoft Graph /me: mail (o userPrincipalName se mail è vuoto).
    const email = data.email || data.mail || data.userPrincipalName || '';
    return { email };
  } catch (e) {
    return {};
  }
}

// Restituisce un access token valido per (utente, provider), rinnovandolo se scaduto.
// Se il refresh fallisce (consenso revocato) cancella l'integrazione: l'utente dovrà
// ricollegare il calendario.
async function getCalendarSession(userId, key) {
  const cfg = PROVIDERS[key];
  const p = cfg.prefix;
  const el = await getIntegration(userId, cfg.provider);
  if (!el[`${p}_refresh_token`]) {
    const err = new Error(`${cfg.label} non collegato`);
    err.status = 428;
    err.code = 'CALENDAR_NOT_CONNECTED';
    throw err;
  }

  const expiresAt = Date.parse(el[`${p}_token_expires_at`] || '');
  const stillValid = el[`${p}_access_token`] && Number.isFinite(expiresAt) && expiresAt - Date.now() > 60000;

  if (!stillValid) {
    let tokenData;
    try {
      tokenData = await refreshAccessToken(cfg, el[`${p}_refresh_token`]);
    } catch (error) {
      console.error(`[CALENDAR:${key}] Refresh token non più valido:`, error.message);
      await deleteIntegration(userId, cfg.provider);
      const err = new Error(`Autorizzazione ${cfg.label} scaduta: ricollega il calendario`);
      err.status = 428;
      err.code = 'CALENDAR_REAUTH_REQUIRED';
      throw err;
    }
    const elements = tokenElements(cfg, tokenData);
    await updateIntegrationElements(userId, cfg.provider, TIPO_INTEGRAZIONE, elements);
    el[`${p}_access_token`] = elements[`${p}_access_token`];
  }

  return { accessToken: el[`${p}_access_token`], email: el[`${p}_email`] || '' };
}

// ==========================================
// CALENDARIO PREDEFINITO (settings)
// ==========================================

// Calendario da mostrare all'ingresso: riga settings con campo = 'calendario default'
// (anche nella forma custom '(*) calendario default') per tenant/utente del token;
// valore2 contiene 'Google' oppure 'Outlook'. Restituisce 'google' | 'outlook' | null.
async function getDefaultCalendarProvider(user) {
  const result = await db.query(
    `SELECT valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND LOWER(BTRIM(campo)) IN ('calendario default', '(*) calendario default')
      LIMIT 1`,
    [user.tenant_id, user.user_id]
  );
  const v = String((result.rows[0] && result.rows[0].valore2) || '').toLowerCase();
  if (v.includes('google')) return 'google';
  if (v.includes('outlook')) return 'outlook';
  return null;
}

// ==========================================
// ENDPOINT: STATO CONNESSIONE
// ==========================================

router.get('/status', requireAuth, async (req, res) => {
  try {
    const out = {};
    for (const key of Object.keys(PROVIDERS)) {
      const cfg = PROVIDERS[key];
      const el = await getIntegration(req.user.user_id, cfg.provider);
      const ics = !!el[`${cfg.prefix}_ics_url`];
      out[key] = {
        configured: isConfigured(cfg),
        connected: !!el[`${cfg.prefix}_refresh_token`] || ics,
        mode: ics ? 'ics' : 'oauth',
        email: el[`${cfg.prefix}_email`] || null
      };
    }
    let defaultProvider = null;
    try {
      defaultProvider = await getDefaultCalendarProvider(req.user);
    } catch (e) {
      console.warn('⚠️ CALENDAR_DEFAULT:', e.message);
    }
    res.json({ providers: out, defaultProvider });
  } catch (error) {
    console.error('❌ CALENDAR_STATUS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT: AVVIO OAUTH
// ==========================================

// URL a cui aprire la finestra di consenso. Lo "state" è un JWT firmato che lega
// l'autorizzazione all'utente, al provider e all'origine da cui è partita (stessa
// tecnica usata da routes/jira.js): protegge da CSRF e dice al callback a chi
// inviare l'esito via postMessage. Il nonce dello state è anche in un cookie del browser
// che ha avviato il collegamento (config/oauthLinkState.js): un link di consenso generato
// da un altro account non viene accettato.
router.get('/:provider(google|outlook)/authorize-url', requireAuth, requireProvider, async (req, res) => {
  try {
    const cfg = req.calendarProvider;
    if (!isConfigured(cfg)) {
      return res.status(503).json({ error: `Credenziali OAuth di ${cfg.label} non configurate sul server` });
    }

    let origin = req.get('origin') || '';
    if (!origin && req.get('referer')) {
      try { origin = new URL(req.get('referer')).origin; } catch { origin = ''; }
    }
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(400).json({ error: 'Origine non consentita' });
    }
    if (!origin) origin = new URL(BACKEND_URL).origin;

    const state = jwt.sign(
      {
        typ: 'oauth-state', // non vale come token di sessione (e viceversa)
        uid: req.user.user_id,
        tid: req.user.tenant_id,
        provider: req.params.provider,
        origin,
        nonce: startLinkState(req, res, '/api/calendar')
      },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: cfg.scope.join(' '),
      state,
      ...cfg.extraAuthParams
    });

    res.json({ url: `${cfg.authUrl}?${params.toString()}` });
  } catch (error) {
    console.error('❌ CALENDAR_AUTHORIZE_URL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT: CALLBACK OAUTH
// ==========================================

// Pagina restituita al termine del consenso: comunica l'esito alla finestra che ha
// aperto il popup (window.opener) e si chiude, esattamente come per Jira.
function callbackPage(origin, payload) {
  const json = JSON.stringify({ source: 'projexa-calendar', ...payload }).replace(/</g, '\\u003c');
  const safeOrigin = JSON.stringify(origin).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><title>Calendario</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; color: #1F2937;">
<p>${payload.ok ? 'Collegamento al calendario completato. Puoi chiudere questa finestra.' : 'Collegamento al calendario non riuscito. Puoi chiudere questa finestra.'}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${json}, ${safeOrigin}); } catch (e) {}
  setTimeout(function () { window.close(); }, 800);
</script>
</body></html>`;
}

// Il callback arriva dal provider OAuth, quindi senza il JWT di Projexa nell'header:
// l'identità dell'utente viene dallo "state" firmato all'avvio del flusso.
router.get('/:provider(google|outlook)/callback', requireProvider, async (req, res) => {
  const cfg = req.calendarProvider;
  const { code, state, error, error_description } = req.query;
  let origin = new URL(BACKEND_URL).origin;

  try {
    if (!state) return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: 'state mancante' }));

    let claims;
    try {
      claims = jwt.verify(state, JWT_SECRET);
      if (claims.typ !== 'oauth-state') throw new Error('tipo');
    } catch {
      return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: 'state non valido o scaduto' }));
    }
    if (claims.origin && isAllowedOrigin(claims.origin)) origin = claims.origin;
    if (!checkLinkState(req, res, '/api/calendar', claims.nonce)) {
      console.warn(`[CALENDAR:${req.params.provider}] state non avviato da questo browser: collegamento rifiutato (utente ${claims.uid})`);
      return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: 'Collegamento non avviato da questo browser: riprova da Projexa' }));
    }
    if (claims.provider !== req.params.provider) {
      return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: 'provider non corrispondente' }));
    }

    if (error) {
      return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: error_description || error }));
    }
    if (!code) {
      return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: 'codice di autorizzazione mancante' }));
    }

    const tokenData = await exchangeCode(cfg, code);
    if (!tokenData.refresh_token) {
      // Capita se l'utente ha già dato il consenso in passato senza revocarlo mai
      // (Google/Microsoft non ne rimandano uno nuovo). Si chiede di riprovare
      // revocando l'accesso all'app dal proprio account, cosa che forza un nuovo
      // refresh_token al prossimo tentativo.
      return res.status(400).send(callbackPage(origin, {
        ok: false, provider: req.params.provider,
        error: 'Nessun refresh token ricevuto: revoca l\'accesso dell\'app dal tuo account e riprova'
      }));
    }
    const profile = await fetchProfile(cfg, tokenData.access_token);
    const elements = tokenElements(cfg, tokenData);

    await saveIntegration(claims.uid, cfg.provider, TIPO_INTEGRAZIONE, {
      [`${cfg.prefix}_email`]: profile.email || '',
      ...elements
    });

    console.log(`[CALENDAR:${req.params.provider}] ✓ Account collegato per l'utente ${claims.uid}`);
    res.send(callbackPage(origin, { ok: true, provider: req.params.provider, email: profile.email || '' }));
  } catch (err) {
    console.error(`❌ CALENDAR_CALLBACK (${req.params.provider}):`, err.message);
    res.status(500).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: err.message }));
  }
});

// Scollega l'account: rimuove tutte le righe dell'utente su integr_tok_auth per quel provider.
router.post('/:provider(google|outlook)/disconnect', requireAuth, requireProvider, async (req, res) => {
  try {
    const removed = await deleteIntegration(req.user.user_id, req.calendarProvider.provider);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('❌ CALENDAR_DISCONNECT:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// OUTLOOK VIA LINK ICS (alternativa senza OAuth)
// ==========================================
//
// Nei tenant che non permettono agli utenti di dare il consenso ad app esterne
// (serve l'approvazione dell'amministratore), l'utente può pubblicare il proprio
// calendario da Outlook web (Impostazioni > Calendario > Calendari condivisi >
// Pubblica un calendario) e incollare qui il link ICS. Il link è salvato cifrato
// su integr_tok_auth (elemento outlook_ics_url) al posto dei token OAuth.
//
// Per evitare che il backend venga usato per scaricare URL arbitrari (SSRF) sono
// accettati solo link https verso i domini di Outlook, senza redirect.
const ICS_ALLOWED_HOSTS = new Set(['outlook.office365.com', 'outlook.office.com', 'outlook.live.com']);
const ICS_MAX_BYTES = 5 * 1024 * 1024;

function normalizeIcsUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ICS_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.toString();
}

async function downloadIcs(url) {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { Accept: 'text/calendar' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const err = new Error(`Il link ICS ha risposto ${response.status}: verifica che il calendario sia ancora pubblicato`);
    err.status = 502;
    throw err;
  }
  const text = await response.text();
  if (text.length > ICS_MAX_BYTES) {
    const err = new Error('Il calendario pubblicato è troppo grande');
    err.status = 502;
    throw err;
  }
  if (!text.includes('BEGIN:VCALENDAR')) {
    const err = new Error('Il link non restituisce un calendario ICS valido');
    err.status = 502;
    throw err;
  }
  return text;
}

// I valori di node-ical possono essere stringhe o { params, val }.
function icalText(v) {
  if (v == null) return '';
  if (typeof v === 'object' && 'val' in v) return String(v.val ?? '');
  return String(v);
}

function icsAttendees(ev) {
  const list = ev.attendee == null ? [] : (Array.isArray(ev.attendee) ? ev.attendee : [ev.attendee]);
  return list.map((a) => {
    const email = icalText(a).replace(/^mailto:/i, '');
    const name = (a && a.params && a.params.CN) ? String(a.params.CN).replace(/^"|"$/g, '') : '';
    return { email, displayName: name || undefined };
  });
}

// Link Teams/Meet/Zoom: Outlook lo mette in una proprietà dedicata oppure nel testo.
function icsMeetingLink(ev) {
  const direct = icalText(ev['MICROSOFT-SKYPETEAMSMEETINGURL'] || ev['X-MICROSOFT-SKYPETEAMSMEETINGURL']);
  if (direct) return direct;
  const text = `${icalText(ev.location)} ${icalText(ev.description)}`;
  const m = text.match(/https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|[\w.-]*zoom\.us|[\w.-]*webex\.com|(?:[\w.-]*\.)?gotomeeting\.com|meet\.goto\.com)\/[^\s<>"')\]]+/i);
  return m ? m[0] : null;
}

// Converte gli eventi ICS nello stesso formato restituito per Google/Graph.
async function fetchIcsEvents(icsUrl, timeMin, timeMax) {
  const data = ical.sync.parseICS(await downloadIcs(icsUrl));
  const from = new Date(timeMin);
  const to = new Date(timeMax);
  const out = [];

  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT') continue;
    // Le occorrenze modificate (RECURRENCE-ID) sono già applicate dall'espansione dell'evento base.
    if (ev.recurrenceid) continue;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;

    const instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    for (const inst of instances) {
      if (inst.isFullDay) continue; // le giornate intere non sono riunioni
      const e = inst.event || ev;
      if (String(e.status || '').toUpperCase() === 'CANCELLED') continue;
      const busy = String(icalText(e['MICROSOFT-CDO-BUSYSTATUS'] || e['X-MICROSOFT-CDO-BUSYSTATUS'])).toUpperCase();
      const transparent = String(icalText(e.transparency)).toUpperCase() === 'TRANSPARENT' || busy === 'FREE';
      const link = icsMeetingLink(e);
      out.push({
        id: `${e.uid || ''}_${new Date(inst.start).toISOString()}`,
        summary: icalText(inst.summary || e.summary),
        start: { dateTime: new Date(inst.start).toISOString() },
        end: { dateTime: new Date(inst.end || inst.start).toISOString() },
        attendees: icsAttendees(e),
        conferenceData: link ? { entryPoints: [{ uri: link }] } : null,
        transparency: transparent ? 'transparent' : 'opaque',
        eventType: '',
        organizer: {
          email: icalText(e.organizer).replace(/^mailto:/i, '').trim(),
          displayName: (e.organizer && e.organizer.params && e.organizer.params.CN)
            ? String(e.organizer.params.CN).replace(/^"|"$/g, '') : ''
        }
      });
    }
  }

  return out
    .filter((e) => e.summary && new Date(e.end.dateTime) > from && new Date(e.start.dateTime) < to)
    .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
}

// Salva il link ICS (sostituisce un eventuale collegamento OAuth di Outlook).
// Il link viene scaricato subito, così un errore di copia emerge qui e non dopo.
router.post('/outlook/ics', requireAuth, async (req, res) => {
  try {
    const icsUrl = normalizeIcsUrl(req.body && req.body.url);
    if (!icsUrl) {
      return res.status(400).json({ error: 'Link non valido: incolla il link ICS pubblicato da Outlook (https://outlook.office365.com/owa/calendar/...)' });
    }
    await downloadIcs(icsUrl);
    await saveIntegration(req.user.user_id, PROVIDERS.outlook.provider, TIPO_INTEGRAZIONE, {
      outlook_ics_url: icsUrl,
      outlook_email: 'link ICS'
    });
    console.log(`[CALENDAR:outlook] ✓ Link ICS collegato per l'utente ${req.user.user_id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ CALENDAR_ICS:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ==========================================
// RIUNIONI GESTITE CON PROJEXA (tabella rec_meeting, database principale)
// ==========================================
//
// Il flag "Gestisci con Projexa" della dashboard crea (spuntato) o cancella (tolto)
// la riga di rec_meeting per tenant/utente del token e id della riunione
// (id_calendar = id dell'evento restituito da /events: id Google, id Graph oppure
// UID_istante per il link ICS, così ogni occorrenza di una ricorrente è distinta).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Righe rec_meeting delle riunioni indicate: Map id_calendar -> { client_id, project_id,
// has_trascrizione, has_recap, inviata }. Di trascrizione e recap si restituisce solo se
// contengono testo (non il testo, che può essere lungo).
async function getManagedMeetings(user, ids) {
  if (!ids.length) return new Map();
  const result = await db.query(
    `SELECT id_calendar, client_id, project_id,
            (trascrizione IS NOT NULL AND BTRIM(trascrizione) <> '') AS has_trascrizione,
            (recap IS NOT NULL AND BTRIM(recap) <> '') AS has_recap,
            (inviata IS TRUE) AS inviata
       FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = ANY($3::text[])`,
    [user.tenant_id, user.user_id, ids]
  );
  return new Map(result.rows.map((r) => [r.id_calendar, {
    client_id: r.client_id,
    project_id: r.project_id,
    has_trascrizione: r.has_trascrizione === true,
    has_recap: r.has_recap === true,
    inviata: r.inviata === true
  }]));
}

router.post('/meetings/managed', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    const oggetto = String(b.oggetto || '').trim().slice(0, 1000);
    const provider = b.provider ? String(b.provider).trim().slice(0, 50) : null;
    // Data e ora arrivano dal browser, già nel fuso orario in cui l'utente le vede.
    const data = String(b.data_calendar || '').trim();
    const orario = String(b.orario_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'data_calendar non valida (YYYY-MM-DD)' });
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(orario)) return res.status(400).json({ error: 'orario_calendar non valido (HH:MM)' });

    // Una sola riga per utente/riunione: se c'è già non se ne crea un'altra.
    const result = await db.query(
      `INSERT INTO rec_meeting (tenant_id, user_id, id_calendar, oggetto, provider, data_calendar, orario_calendar)
       SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::date, $7::time
        WHERE NOT EXISTS (
          SELECT 1 FROM rec_meeting WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id_calendar = $3::text
        )
       RETURNING id`,
      [req.user.tenant_id, req.user.user_id, idCalendar, encRec(oggetto), provider, data, orario]
    );
    res.json({ success: true, created: result.rowCount > 0 });
  } catch (error) {
    console.error('❌ REC_MEETING_INSERT:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// "Registra": prenota la registrazione della riunione, oppure la collega a quella di un
// collega dello stesso tenant che la sta già registrando. Stessa riunione = stesso
// provider, data, orario e titolo (l'id dell'evento non serve: con Outlook collegato
// via Microsoft ogni casella ha un id diverso per la stessa riunione).
//   - collega trovato  -> questa riga punta alla sua (trascrizione_da_*), niente audio:
//                         a fine registrazione la trascrizione viene copiata qui e il
//                         recap parte con l'utente di questa riga (jobs/meetingTranscription.js);
//   - nessun collega   -> registrazione_avviata_il = adesso: da qui in poi è lui la sorgente.
// Risposta: { shared: false } oppure { shared: true, by: 'Nome Cognome', copied: bool }.
const normTitolo = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

router.post('/meetings/managed/claim-recording', requireAuth, async (req, res) => {
  const idCalendar = String((req.body && req.body.id_calendar) || '').trim();
  if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
  const { tenant_id: tenantId, user_id: userId } = req.user;
  const client = await db.connect();
  let source = null;
  let copiaSubito = false;
  try {
    await client.query('BEGIN');
    const me = (await client.query(
      `SELECT oggetto, provider, data_calendar, orario_calendar, registrazione_avviata_il,
              trascrizione_da_user, trascrizione_da_calendar
         FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1 FOR UPDATE`,
      [tenantId, userId, idCalendar]
    )).rows[0];
    if (!me) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Riunione non gestita con Projexa' }); }

    // Una sola prenotazione alla volta per la stessa riunione: due "Registra" contemporanei
    // non diventano entrambi sorgente.
    const chiave = `${tenantId}|${normTitolo(me.provider)}|${me.data_calendar}|${me.orario_calendar}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [chiave]);

    // Già collegata a un collega: resta collegata finché la sua riga esiste.
    if (me.trascrizione_da_user) {
      const s = (await client.query(
        `SELECT user_id, id_calendar FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
        [tenantId, me.trascrizione_da_user, me.trascrizione_da_calendar]
      )).rows[0];
      if (s) source = s;
    }

    // Registrazioni libere (microfono) e chi ha già registrato questa riunione: nessun controllo.
    const libera = idCalendar.startsWith('manual:');
    if (!source && !libera && !(me.registrazione_avviata_il && !me.trascrizione_da_user)) {
      const candidati = (await client.query(
        `SELECT user_id, id_calendar, oggetto FROM rec_meeting
          WHERE tenant_id = $1 AND user_id <> $2
            AND LOWER(COALESCE(provider, '')) = LOWER(COALESCE($3, ''))
            AND data_calendar = $4 AND orario_calendar = $5
            AND registrazione_avviata_il IS NOT NULL AND trascrizione_da_user IS NULL
          ORDER BY registrazione_avviata_il`,
        [tenantId, userId, me.provider, me.data_calendar, me.orario_calendar]
      )).rows;
      // Il titolo è cifrato a riposo: il confronto si fa qui, sul testo già decifrato.
      source = candidati.find((c) => normTitolo(c.oggetto) === normTitolo(me.oggetto)) || null;
    }

    if (source) {
      await client.query(
        `UPDATE rec_meeting SET trascrizione_da_user = $1, trascrizione_da_calendar = $2
          WHERE tenant_id = $3 AND user_id = $4 AND id_calendar = $5`,
        [source.user_id, source.id_calendar, tenantId, userId, idCalendar]
      );
      // Registrazione del collega già finita (niente in coda): la copia si fa subito.
      const inCoda = (await client.query(
        `SELECT 1 FROM rec_meeting_chunks WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
        [tenantId, source.user_id, source.id_calendar]
      )).rows.length > 0;
      copiaSubito = !inCoda;
    } else {
      await client.query(
        `UPDATE rec_meeting SET registrazione_avviata_il = COALESCE(registrazione_avviata_il, now()),
                trascrizione_da_user = NULL, trascrizione_da_calendar = NULL
          WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
        [tenantId, userId, idCalendar]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('❌ REC_MEETING_CLAIM:', error.message);
    return res.status(500).json({ error: error.message });
  }
  client.release();

  if (!source) return res.json({ shared: false });
  let copied = false;
  if (copiaSubito) {
    try {
      copied = (await copiaTrascrizioneCondivisa({ tenant_id: tenantId, user_id: source.user_id }, source.id_calendar, userId)) > 0;
    } catch (e) {
      console.error('❌ REC_MEETING_CLAIM (copia):', e.message);
    }
  }
  res.json({ shared: true, by: await speakerName({ user_id: source.user_id }), copied });
});

// Associa cliente e progetto alla riga rec_meeting della riunione (UUID o null).
// Il progetto deve appartenere al cliente scelto (stessa regola della tendina in dashboard).
router.patch('/meetings/managed', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    const clientId = b.client_id ? String(b.client_id).trim() : null;
    const projectId = b.project_id ? String(b.project_id).trim() : null;
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    if (clientId && !UUID_RE.test(clientId)) return res.status(400).json({ error: 'client_id non valido' });
    if (projectId && !UUID_RE.test(projectId)) return res.status(400).json({ error: 'project_id non valido' });
    if (projectId && !clientId) return res.status(400).json({ error: 'Seleziona prima il cliente' });

    if (projectId) {
      const check = await db.query(
        `SELECT 1 FROM projects
          WHERE id = $1 AND client_id = $2 AND tenant_id = $3 AND user_id = $4
            AND argument = 'Progetto' AND campo = 'Progetto'
          LIMIT 1`,
        [projectId, clientId, req.user.tenant_id, req.user.user_id]
      );
      if (check.rows.length === 0) return res.status(400).json({ error: 'Il progetto non appartiene al cliente selezionato' });
    }

    const result = await db.query(
      `UPDATE rec_meeting SET client_id = $1, project_id = $2
        WHERE tenant_id = $3 AND user_id = $4 AND id_calendar = $5`,
      [clientId, projectId, req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ REC_MEETING_UPDATE:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Flag "Inviata" della griglia riunioni (rec_meeting.inviata): segna la riunione come gestita
// (recap inviato al cliente) o la riporta da gestire.
router.patch('/meetings/managed/inviata', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    if (typeof b.inviata !== 'boolean') return res.status(400).json({ error: 'inviata deve essere true o false' });
    const result = await db.query(
      `UPDATE rec_meeting SET inviata = $1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
      [b.inviata, req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    res.json({ success: true, inviata: b.inviata });
  } catch (error) {
    console.error('❌ REC_MEETING_INVIATA:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Caricamento di trascrizione o recap da file (.txt / .vtt, convertito in testo dal
// browser): SOSTITUISCE il contenuto della colonna ed è scritto cifrato.
const MAX_TEXT_UPLOAD = 2 * 1024 * 1024;

router.put('/meetings/managed/text', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    const field = String(b.field || '').trim();
    const text = String(b.text == null ? '' : b.text).replace(/\r\n?/g, '\n').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    if (field !== 'trascrizione' && field !== 'recap') return res.status(400).json({ error: 'Campo non valido' });
    if (!text) return res.status(400).json({ error: 'Il file non contiene testo' });
    if (text.length > MAX_TEXT_UPLOAD) return res.status(413).json({ error: 'Testo troppo lungo (max 2 MB)' });
    // Nome di colonna da una whitelist fissa: nessun input utente nella query.
    const col = field === 'recap' ? 'recap' : 'trascrizione';
    // Correzioni automatiche (rec_correzioni): anche sul recap generato nel browser e sui
    // file caricati, come sui blocchi trascritti dal server.
    let fixed = applyCorrections(text, await loadCorrections(req.user, idCalendar)).text;
    // Recap (anche quello generato nel browser): via la formattazione Markdown.
    if (col === 'recap') fixed = stripMarkdown(fixed).trim();
    // Un recap nuovo (file caricato) sostituisce anche l'eventuale versione formattata.
    const result = await db.query(
      `UPDATE rec_meeting SET ${col} = $1, crypto = 1${col === 'recap' ? ', recap_html = NULL' : ''}
        WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
      [encRec(fixed), req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    res.json({ success: true, length: text.length });
  } catch (error) {
    console.error('❌ REC_MEETING_UPLOAD:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// "Applica correzioni" (finestra della lente): applica le correzioni automatiche
// (rec_correzioni) al testo già salvato. Senza "field" corregge INSIEME trascrizione e
// recap (un clic, senza rigenerare il recap). Restituisce le sostituzioni fatte per campo;
// ogni testo si riscrive (cifrato) solo se è cambiato.
router.post('/meetings/managed/apply-corrections', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    const field = String(b.field || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    if (field && field !== 'trascrizione' && field !== 'recap') return res.status(400).json({ error: 'Campo non valido' });
    const cur = await db.query(
      `SELECT trascrizione, recap, recap_html FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    const rules = await loadCorrections(req.user, idCalendar);
    // Recap modificato a mano (formattato): le correzioni valgono anche lì.
    if ((!field || field === 'recap') && cur.rows[0].recap_html && rules.length) {
      const h = applyCorrectionsHtml(cur.rows[0].recap_html, rules);
      if (h.count > 0) {
        await db.query(
          `UPDATE rec_meeting SET recap_html = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
          [encRec(h.html), req.user.tenant_id, req.user.user_id, idCalendar]
        );
      }
    }
    const counts = { trascrizione: 0, recap: 0 };
    let markdown = false; // recap ripulito dalla formattazione Markdown
    // Nomi di colonna da una whitelist fissa: nessun input utente nella query.
    for (const col of field ? [field] : ['trascrizione', 'recap']) {
      const original = cur.rows[0][col] || '';
      let { text, count } = applyCorrections(original, rules);
      counts[col] = count;
      if (col === 'recap' && original.trim()) {
        const clean = stripMarkdown(text).trim();
        if (clean !== text.trim()) { markdown = true; text = clean; }
      }
      if (count > 0 || (col === 'recap' && markdown)) {
        await db.query(
          `UPDATE rec_meeting SET ${col === 'recap' ? 'recap' : 'trascrizione'} = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
          [encRec(text), req.user.tenant_id, req.user.user_id, idCalendar]
        );
      }
    }
    res.json({ success: true, count: counts.trascrizione + counts.recap, counts, rules: rules.length, markdown });
  } catch (error) {
    console.error('❌ REC_MEETING_CORRECTIONS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// "CREA TASK" DAL RECAP (finestra del recap)
// ==========================================
// GET: proposta dei task (righe "AZIONI IN CARICO" dei blocchi dell'utente, vedi
// jobs/recapTasks.js), da rivedere in una finestra. POST: inserisce in tasks le righe
// confermate. Cliente, progetto, data della call e assegnatario ("me" = contatto di rubrica
// con l'email dell'utente) si ricavano SEMPRE qui dal database, mai dal browser.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function recapTaskContext(req, idCalendar) {
  const r = await db.query(
    `SELECT oggetto, recap, data_calendar, client_id, project_id FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [req.user.tenant_id, req.user.user_id, idCalendar]
  );
  if (r.rows.length === 0) throw Object.assign(new Error('Riunione non gestita con Projexa'), { status: 404 });
  const m = r.rows[0];
  // "me": contatto di rubrica con l'email dell'utente (confronto dopo la decifratura, come
  // il pulsante "me" dei task).
  const myEmail = String(req.user.email || '').trim().toLowerCase();
  let me = null;
  if (myEmail) {
    const rb = await db.query(
      `SELECT id::text AS id, nominativo, email FROM rubrica
        WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
      [req.user.tenant_id, req.user.user_id]
    );
    const row = rb.rows.find((x) => String(x.email || '').trim().toLowerCase() === myEmail);
    if (row) me = { id: row.id, name: row.nominativo || myEmail };
  }
  return { meeting: m, me };
}

router.get('/meetings/managed/recap-tasks', requireAuth, async (req, res) => {
  try {
    const idCalendar = String(req.query.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    const { meeting: m, me } = await recapTaskContext(req, idCalendar);
    if (!m.recap || !String(m.recap).trim()) return res.status(400).json({ error: 'La riunione non ha ancora un recap' });
    const callDate = m.data_calendar ? String(m.data_calendar).slice(0, 10) : null;
    const variants = ownerVariants(await speakerName(req.user));
    // Task già creati per questa riunione (stessa data di inizio): segnalati per non duplicarli.
    const existing = new Set();
    if (callDate) {
      const t = await db.query(
        `SELECT description FROM tasks WHERE tenant_id = $1 AND user_id = $2 AND data_inizio = $3::date`,
        [req.user.tenant_id, req.user.user_id, callDate]
      );
      t.rows.forEach((x) => existing.add(String(x.description || '').trim().toLowerCase()));
    }
    const items = parseRecapActions(stripMarkdown(m.recap), variants).map((it) => ({
      description: it.description,
      due_date: parseDueDate(it.description, callDate),
      exists: existing.has(it.description.trim().toLowerCase())
    }));
    // Nomi di cliente e progetto solo per la finestra (riga identità EAV, valore2).
    const name = async (table, id) => {
      if (!id) return null;
      const x = await db.query(`SELECT valore2 FROM ${table} WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, req.user.tenant_id]);
      return x.rows[0] ? x.rows[0].valore2 : null;
    };
    res.json({
      titile: `${String(m.oggetto || 'Riunione').trim()} - Azioni in carico`.slice(0, 200),
      data_inizio: callDate,
      client: m.client_id ? { id: m.client_id, name: await name('clients', m.client_id) } : null,
      project: m.project_id ? { id: m.project_id, name: await name('projects', m.project_id) } : null,
      assigned_to: me,
      owners: variants,
      items
    });
  } catch (error) {
    console.error('❌ REC_MEETING_TASKS_PREVIEW:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/meetings/managed/recap-tasks', requireAuth, async (req, res) => {
  let client;
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    const titile = String(b.titile || '').trim().slice(0, 200);
    if (!titile) return res.status(400).json({ error: 'Il titolo è obbligatorio' });
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((x) => ({ description: String((x && x.description) || '').trim().slice(0, 4000), due_date: x && x.due_date ? String(x.due_date).trim() : null }))
      .filter((x) => x.description);
    if (!items.length) return res.status(400).json({ error: 'Nessun task da creare' });
    if (items.length > 50) return res.status(400).json({ error: 'Al massimo 50 task per volta' });
    if (items.some((x) => x.due_date && !DATE_RE.test(x.due_date))) return res.status(400).json({ error: 'Data di scadenza non valida' });

    const { meeting: m, me } = await recapTaskContext(req, idCalendar);
    const role = Number.isFinite(Number(req.user.id_roles)) ? Number(req.user.id_roles) : 90;
    client = await db.connect();
    await client.query('BEGIN');
    for (const it of items) {
      const row = {
        tenant_id: req.user.tenant_id,
        user_id: req.user.user_id,
        client_id: m.client_id || null,
        project_id: m.project_id || null,
        tipo_task: 'Automatica',
        titile,
        description: it.description,
        status: 'in_progress',   // "In corso"
        priority: 'medium',      // "Media"
        assigned_to: me ? me.id : null,
        due_date: it.due_date || null,
        data_inizio: m.data_calendar ? String(m.data_calendar).slice(0, 10) : null,
        scadenza: '2099-12-31',
        id_roles: role,
        id_roles_write: role,
        created_by: req.user.user_id,
        crypto: 1
      };
      const { data } = await encryptRowForWrite(db, 'tasks', row);
      const cols = Object.keys(data);
      await client.query(
        `INSERT INTO tasks (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => data[c])
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, created: items.length, assigned: !!me });
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch { /* già chiusa */ } }
    console.error('❌ REC_MEETING_TASKS_CREATE:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// "Svuota" (finestra della lente): cancella completamente il recap della riunione.
// Solo il recap: la trascrizione non si svuota da qui.
router.delete('/meetings/managed/recap', requireAuth, async (req, res) => {
  try {
    const idCalendar = String((req.body && req.body.id_calendar) || req.query.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    const result = await db.query(
      `UPDATE rec_meeting SET recap = NULL, recap_html = NULL WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
      [req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ REC_MEETING_CLEAR_RECAP:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Registrazioni libere (pulsante microfono nella barra laterale): righe rec_meeting con
// id_calendar "manual:<uuid>", non legate al calendario. Restituite nello stesso formato
// degli eventi (/events) per i giorni indicati (date locali YYYY-MM-DD), così la
// dashboard le mostra sotto le riunioni del calendario.
router.get('/meetings/manual', requireAuth, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || from).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from/to non validi (YYYY-MM-DD)' });
    }
    const r = await db.query(
      `SELECT id_calendar, oggetto, data_calendar, orario_calendar, client_id, project_id,
              (trascrizione IS NOT NULL AND BTRIM(trascrizione) <> '') AS has_trascrizione,
              (recap IS NOT NULL AND BTRIM(recap) <> '') AS has_recap,
              (inviata IS TRUE) AS inviata
         FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar LIKE 'manual:%'
          AND data_calendar BETWEEN $3::date AND $4::date
        ORDER BY data_calendar, orario_calendar`,
      [req.user.tenant_id, req.user.user_id, from, to]
    );
    const events = r.rows.map((x) => {
      const time = x.orario_calendar ? String(x.orario_calendar).slice(0, 8) : '00:00:00';
      // Data/ora locali dell'utente, senza fuso: il browser le interpreta come ora locale.
      const start = `${x.data_calendar}T${time.length === 5 ? time + ':00' : time}`;
      return {
        id: x.id_calendar,
        manual: true,
        summary: x.oggetto || 'Registrazione',
        start: { dateTime: start },
        end: { dateTime: start },
        attendees: [],
        conferenceData: null,
        managed: true,
        client_id: x.client_id,
        project_id: x.project_id,
        has_trascrizione: x.has_trascrizione === true,
        has_recap: x.has_recap === true,
        inviata: x.inviata === true
      };
    });
    res.json({ events });
  } catch (error) {
    console.error('❌ REC_MEETING_MANUAL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Rinomina una registrazione libera (doppio clic sul titolo in dashboard). Solo righe
// "manual:<uuid>": le riunioni del calendario prendono il titolo dal calendario.
router.patch('/meetings/manual/title', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    const oggetto = String(b.oggetto || '').trim().slice(0, 1000);
    if (!idCalendar.startsWith('manual:')) return res.status(400).json({ error: 'Solo le registrazioni libere si possono rinominare' });
    if (!oggetto) return res.status(400).json({ error: 'Il nome non può essere vuoto' });
    const result = await db.query(
      `UPDATE rec_meeting SET oggetto = $1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
      [encRec(oggetto), req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Registrazione non trovata' });
    res.json({ success: true, oggetto });
  } catch (error) {
    console.error('❌ REC_MEETING_RENAME:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stato leggero delle riunioni a video (aggiornamento periodico della griglia, senza
// rileggere il calendario): per ogni id_calendar indicato restituisce se la riunione è
// gestita, se trascrizione/recap contengono testo, inviata, cliente e progetto.
router.post('/meetings/managed/status', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 200)
      : [];
    const map = await getManagedMeetings(req.user, ids);
    const pending = await pendingChunks(req.user, ids);
    const recapRunning = await recapInProgress(req.user, ids);
    const recapBatch = await recapBatchInCorso(req.user, ids);
    // Recap Batch in attesa: si controllano subito presso l'AI (in background); il recap
    // pronto compare al prossimo aggiornamento della lista.
    if (recapBatch.size) controllaRecapBatchUtente(req.user);
    const out = {};
    for (const [id, row] of map) {
      out[id] = { ...row, pending: pending.get(id) || 0, recap_running: recapRunning.has(id), recap_batch: recapBatch.has(id) };
    }
    res.json({ meetings: out });
  } catch (error) {
    console.error('❌ REC_MEETING_STATUS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Testo completo di trascrizione o recap di una riunione (finestra "lente" della dashboard).
// Le righe delle riunioni ricevono solo "presente sì/no": il testo si carica qui, su richiesta.
router.get('/meetings/managed/text', requireAuth, async (req, res) => {
  try {
    const idCalendar = String(req.query.id_calendar || '').trim();
    const field = String(req.query.field || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    if (field !== 'trascrizione' && field !== 'recap') return res.status(400).json({ error: 'Campo non valido' });
    // Nome di colonna da una whitelist fissa: nessun input utente nella query.
    const result = await db.query(
      `SELECT ${field === 'recap' ? 'recap' : 'trascrizione'} AS testo, oggetto, data_calendar, orario_calendar,
              recap_html, mittente, email_a, email_cc
         FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    const r = result.rows[0];
    const out = { text: r.testo || '', oggetto: r.oggetto || '', data: r.data_calendar, orario: r.orario_calendar };
    // Recap: versione formattata (se modificata a mano) e dati dell'email.
    if (field === 'recap') {
      out.html = r.recap_html || '';
      out.mittente = r.mittente || '';
      out.email_a = r.email_a || '';
      out.email_cc = r.email_cc || '';
    }
    res.json(out);
  } catch (error) {
    console.error('❌ REC_MEETING_TEXT:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Salvataggio del recap modificato nella finestra del recap: testo semplice (colonna recap,
// usato da Crea task, correzioni, .txt), versione formattata (recap_html, già ripulita dal
// browser; qui si tolgono comunque script, eventi e link javascript:) e dati dell'email
// (mittente, A, Cc). Le correzioni automatiche NON si applicano: è un testo scelto a mano.
const MAX_RECAP_HTML = 1024 * 1024;
const cleanEmails = (v) => String(v || '').split(/[;,\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 100).join('; ').slice(0, 4000);

function scrubHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"');
}

router.put('/meetings/managed/recap-edit', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    const text = String(b.text == null ? '' : b.text).replace(/\r\n?/g, '\n').trim();
    const html = scrubHtml(b.html).trim();
    if (!text) return res.status(400).json({ error: 'Il recap è vuoto: per cancellarlo usa "Svuota"' });
    if (text.length > MAX_TEXT_UPLOAD || html.length > MAX_RECAP_HTML) return res.status(413).json({ error: 'Recap troppo lungo' });
    const mittente = String(b.mittente || '').trim().slice(0, 320);
    const result = await db.query(
      `UPDATE rec_meeting
          SET recap = $1, recap_html = $2, mittente = $3, email_a = $4, email_cc = $5, crypto = 1
        WHERE tenant_id = $6 AND user_id = $7 AND id_calendar = $8`,
      [encRec(text), html ? encRec(html) : null, mittente ? encRec(mittente) : null,
        encRec(cleanEmails(b.email_a)) || null, encRec(cleanEmails(b.email_cc)) || null,
        req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ REC_MEETING_RECAP_EDIT:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Trascrizione: il browser registra la riunione e invia blocchi WAV di circa 30 secondi,
// in ordine, su DUE tracce: audio_mic (il microfono dell'utente) e audio_system (l'audio
// del PC, cioè gli altri partecipanti). Ogni blocco viene messo IN CODA sul server
// (tabella rec_meeting_chunks, audio cifrato) e trascritto in background da
// jobs/meetingTranscription.js: la pagina si può chiudere dopo "Ferma".
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

async function isTrascrizioneCondivisa(user, idCalendar) {
  try {
    const r = await db.query(
      `SELECT 1 FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND trascrizione_da_user IS NOT NULL LIMIT 1`,
      [user.tenant_id, user.user_id, idCalendar]
    );
    return r.rows.length > 0;
  } catch (e) {
    return false; // colonne non ancora create (Supporto/CreaDB/rec_meeting_condivisa.sql)
  }
}

function checkAudio(b64) {
  if (!b64) return null;
  const s = String(b64);
  // stima della dimensione decodificata (base64: 4 caratteri = 3 byte)
  if (Math.floor(s.length * 3 / 4) > MAX_AUDIO_BYTES) {
    const err = new Error('Blocco audio troppo grande');
    err.status = 413;
    throw err;
  }
  return s.length ? s : null;
}

// Punto di ripresa degli orari: una nuova registrazione della stessa riunione continua
// dall'ultimo orario già presente in trascrizione (+1 s) o prenotato dai blocchi ancora in
// coda, invece di ripartire da 00:00:00.
router.get('/meetings/managed/offset', requireAuth, async (req, res) => {
  try {
    const idCalendar = String(req.query.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    // Chiamato all'avvio della registrazione: si svegliano subito i servizi Whisper.
    warmWhisperServices();
    const r = await db.query(
      `SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, idCalendar]
    );
    let last = -1;
    const re = /^\[(\d{1,3}):(\d{2}):(\d{2})\]/gm;
    const text = (r.rows[0] && r.rows[0].trascrizione) || '';
    for (let m = re.exec(text); m; m = re.exec(text)) {
      last = Math.max(last, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    }
    last = Math.max(last, await queuedEndOffset(req.user, idCalendar));
    res.json({ offset: last >= 0 ? Math.floor(last) + 1 : 0 });
  } catch (error) {
    console.error('❌ REC_MEETING_OFFSET:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Blocco audio: salvato in coda e trascritto in background (risposta immediata 202).
router.post('/meetings/managed/transcribe', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    const mime = String(b.mime || 'audio/wav');
    if (!/^audio\/(wav|x-wav|wave)$/.test(mime)) return res.status(400).json({ error: 'Formato audio non supportato' });
    // Formato attuale: una sola traccia mixata (audio_mix) + volume delle due tracce per
    // finestre di 0,5 s (energy_mic / energy_system), per capire chi parla.
    // Formati precedenti ancora accettati: audio_mic / audio_system (o "audio").
    const mixB64 = checkAudio(b.audio_mix);
    const micB64 = mixB64 ? null : checkAudio(b.audio_mic);
    const sysB64 = mixB64 ? null : checkAudio(b.audio_system || b.audio);
    // Note dei blocchi persi nel browser: da sole (fine registrazione) o insieme a un blocco.
    const lostNotes = Array.isArray(b.lost_notes) ? b.lost_notes : [];
    const hasAudio = !!(mixB64 || micB64 || sysB64);
    if (!hasAudio && !lostNotes.length) return res.status(400).json({ error: 'Audio mancante' });
    const cleanEnergy = (v) => (Array.isArray(v)
      ? v.slice(0, 1200).map((x) => Math.max(0, Math.min(1, Number(x) || 0)))
      : null);
    // Nomi dei partecipanti (dal calendario, nel browser): servono al prompt di Whisper.
    // Viaggiano con il volume nel JSON "energy" del blocco (nessuna colonna in più).
    const names = (Array.isArray(b.names) ? b.names : [])
      .map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, 20);
    const energy = mixB64 ? { mic: cleanEnergy(b.energy_mic), system: cleanEnergy(b.energy_system), names } : null;

    const row = await db.query(
      `SELECT 1 FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, idCalendar]
    );
    if (row.rows.length === 0) return res.status(404).json({ error: 'Riunione non gestita con Projexa' });
    // Trascrizione condivisa con un collega (claim-recording): questa riga non riceve audio.
    if (await isTrascrizioneCondivisa(req.user, idCalendar)) {
      return res.status(409).json({ error: 'La trascrizione di questa riunione arriva dalla registrazione di un collega' });
    }

    try {
      // Prima le note (blocchi precedenti persi), poi il blocco: l'ordine della coda è quello.
      if (lostNotes.length) await enqueueLostNotes(req.user, idCalendar, lostNotes);
      if (hasAudio) {
        await enqueueChunk(req.user, idCalendar, {
          mixB64, energy, micB64, sysB64, mime, offset: Number(b.offset_sec) || 0, startLabel: b.start_label || null
        });
      }
    } catch (e) {
      if (/rec_meeting_chunks/.test(e.message || '')) {
        return res.status(503).json({ error: 'Coda di trascrizione non disponibile: eseguire Supporto/CreaDB/rec_meeting_chunks.sql sul database' });
      }
      throw e;
    }
    res.status(202).json({ success: true, queued: true });
  } catch (error) {
    console.error('❌ REC_MEETING_TRANSCRIBE:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Fine registrazione: quando i blocchi in coda della riunione sono trascritti, il server
// genera da solo il recap (anche a pagina chiusa).
router.post('/meetings/managed/finalize', requireAuth, async (req, res) => {
  try {
    const idCalendar = String((req.body && req.body.id_calendar) || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    await enqueueFinalize(req.user, idCalendar);
    res.status(202).json({ success: true, queued: true });
  } catch (error) {
    console.error('❌ REC_MEETING_FINALIZE:', error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ==========================================
// RECAP DELLA RIUNIONE (rec_meeting.recap)
// ==========================================
//
// Pulsante azzurro "Recap" della dashboard. Il recap automatico a fine registrazione lo
// genera invece la coda (jobs/meetingTranscription.js). Stessa logica: AI scelta in
// Impostazioni › AI, prompt backend/prompts/recap_email.txt.
// Cosa chiedere premendo il pulsante: AI (se «AI generazione e-mail recap» = "Chiedi sempre",
// elenco delle AI con chiave collegata + Recap Projexa) ed esecuzione (se «Esecuzione Recap» =
// "Chiedi Sempre").
router.get('/meetings/managed/recap-opzioni', requireAuth, async (req, res) => {
  try {
    const ai = await recapAiImpostata(req.user);
    const esecuzione = await recapEsecuzione(req.user);
    const chiediAi = isChiediSempre(ai);
    res.json({
      ai, chiediAi, esecuzione, chiediEsecuzione: esecuzione === 'chiedi',
      aiDisponibili: chiediAi
        ? [...(await aiCollegate(req.user.user_id)).map((x) => ({ nome: x.nome, label: x.label, batch: true })),
          { nome: 'Recap Projexa (lento)', label: 'Recap Projexa (lento, gratuito)', batch: false }]
        : []
    });
  } catch (error) {
    console.error('❌ REC_MEETING_RECAP_OPZIONI:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// body: { id_calendar, ai?, esecuzione? } - ai ed esecuzione servono solo quando le
// impostazioni dicono "Chiedi sempre" (scelti nella finestra del pulsante).
router.post('/meetings/managed/recap', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idCalendar = String(b.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    let providerName = await recapAiImpostata(req.user);
    if (isChiediSempre(providerName)) {
      providerName = String(b.ai || '').trim();
      if (!providerName) return res.status(400).json({ error: 'Scegli l\'AI da usare per il recap' });
    }
    if (!providerName) return res.status(400).json({ error: 'Scegli l\'AI in Impostazioni › AI › "AI generazione e-mail recap"' });
    const locale = localRecapMode(providerName) === 'server';
    if (!locale && !AI_PROVIDERS[providerName.toLowerCase()]) return res.status(400).json({ error: `AI «${providerName}» non utilizzabile per il recap` });
    let esecuzione = await recapEsecuzione(req.user);
    if (esecuzione === 'chiedi') {
      esecuzione = String(b.esecuzione || '').trim().toLowerCase();
      if (!['immediato', 'batch'].includes(esecuzione)) return res.status(400).json({ error: 'Scegli se eseguire il recap Immediato o in Batch' });
    }
    // Recap Projexa (lento): troppi minuti per una richiesta HTTP, va nella coda in background
    // (stessa strada del recap automatico); la griglia mostra la clessidra e poi "Recap pronto".
    // Non ha la modalità Batch (è già gratuito).
    if (locale) {
      await enqueueFinalize(req.user, idCalendar, { ai: providerName });
      return res.status(202).json({ success: true, queued: true, provider: providerName });
    }
    // Batch: costo dimezzato, il recap arriva entro 24 ore (job recap_batch, jobs/recapBatch.js).
    if (esecuzione === 'batch') {
      const r = await inviaRecapBatch(req.user, idCalendar, providerName);
      return res.status(202).json({ success: true, batch: true, provider: r.provider, model: r.model });
    }
    const result = await generateRecap(req.user, idCalendar, { ai: providerName });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ REC_MEETING_RECAP:', error.message);
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});


router.delete('/meetings/managed', requireAuth, async (req, res) => {
  try {
    const idCalendar = String((req.body && req.body.id_calendar) || req.query.id_calendar || '').trim();
    if (!idCalendar) return res.status(400).json({ error: 'id_calendar richiesto' });
    const result = await db.query(
      `DELETE FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
      [req.user.tenant_id, req.user.user_id, idCalendar]
    );
    res.json({ success: true, removed: result.rowCount });
  } catch (error) {
    console.error('❌ REC_MEETING_DELETE:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Aggiunge a ogni evento managed (stato del flag) e client_id/project_id associati.
// Se rec_meeting non è leggibile gli eventi vengono restituiti comunque, senza flag.
async function withManagedFlag(user, events) {
  let managed = new Map();
  try {
    managed = await getManagedMeetings(user, events.map((e) => String(e.id || '')).filter(Boolean));
  } catch (e) {
    console.warn('⚠️ REC_MEETING_READ:', e.message);
  }
  return events.map((e) => {
    const row = managed.get(String(e.id || ''));
    return {
      ...e,
      managed: !!row,
      client_id: row ? row.client_id : null,
      project_id: row ? row.project_id : null,
      has_trascrizione: row ? row.has_trascrizione : false,
      has_recap: row ? row.has_recap : false,
      inviata: row ? row.inviata : false
    };
  });
}

// ==========================================
// ENDPOINT: EVENTI
// ==========================================
//
// Restituisce sempre lo stesso formato ("shape" di Google Calendar), qualunque sia
// il provider: { summary, start:{dateTime}, end:{dateTime}, attendees:[{email,
// displayName}], conferenceData:{entryPoints:[{uri}]}, transparency }. Così il
// frontend (dashboard.html) non deve distinguere i due provider.

async function fetchGoogleEvents(session, timeMin, timeMax) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' }
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Google Calendar API ${response.status}: ${text.slice(0, 300)}`);
    err.status = response.status === 401 ? 428 : response.status;
    throw err;
  }
  const data = await response.json();
  return data.items || [];
}

// Microsoft Graph restituisce start/end senza suffisso di fuso orario: l'header
// Prefer richiede esplicitamente UTC, e qui si aggiunge la "Z" mancante perché il
// browser interpreti correttamente l'orario (altrimenti verrebbe letto come ora locale).
async function fetchOutlookEvents(session, timeMin, timeMax) {
  const url = new URL('https://graph.microsoft.com/v1.0/me/calendarview');
  url.searchParams.set('startDateTime', timeMin);
  url.searchParams.set('endDateTime', timeMax);
  url.searchParams.set('$orderby', 'start/dateTime');
  url.searchParams.set('$top', '50');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: 'application/json',
      Prefer: 'outlook.timezone="UTC"'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Microsoft Graph ${response.status}: ${text.slice(0, 300)}`);
    err.status = response.status === 401 ? 428 : response.status;
    throw err;
  }
  const data = await response.json();
  const events = data.value || [];

  const withZ = (dt) => (dt && !/[zZ]|[+-]\d{2}:\d{2}$/.test(dt) ? `${dt}Z` : dt);

  return events.map((e) => ({
    id: e.id,
    summary: e.subject || '',
    start: { dateTime: withZ(e.start && e.start.dateTime) },
    end: { dateTime: withZ(e.end && e.end.dateTime) },
    attendees: (e.attendees || []).map((a) => ({
      email: a.emailAddress && a.emailAddress.address,
      displayName: a.emailAddress && a.emailAddress.name
    })),
    conferenceData: (e.onlineMeeting && e.onlineMeeting.joinUrl) || e.onlineMeetingUrl
      ? { entryPoints: [{ uri: (e.onlineMeeting && e.onlineMeeting.joinUrl) || e.onlineMeetingUrl }] }
      : null,
    // showAs di Graph: free/tentative/busy/oof/workingElsewhere/unknown.
    transparency: e.showAs === 'free' ? 'transparent' : 'opaque',
    eventType: '',
    organizer: {
      email: (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.address) || '',
      displayName: (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.name) || ''
    }
  })).filter((e) => e.summary);
}

router.get('/events', requireAuth, async (req, res) => {
  try {
    const key = String(req.query.provider || '').trim();
    if (!PROVIDERS[key]) return res.status(400).json({ error: 'Parametro provider richiesto (google|outlook)' });
    const timeMin = String(req.query.timeMin || '').trim();
    const timeMax = String(req.query.timeMax || '').trim();
    if (!timeMin || !timeMax) return res.status(400).json({ error: 'timeMin e timeMax richiesti' });

    if (key === 'outlook') {
      const el = await getIntegration(req.user.user_id, PROVIDERS.outlook.provider);
      if (el.outlook_ics_url) {
        const events = await withManagedFlag(req.user, await fetchIcsEvents(el.outlook_ics_url, timeMin, timeMax));
        return res.json({ events, count: events.length });
      }
    }

    const session = await getCalendarSession(req.user.user_id, key);
    const events = await withManagedFlag(req.user, key === 'outlook'
      ? await fetchOutlookEvents(session, timeMin, timeMax)
      : await fetchGoogleEvents(session, timeMin, timeMax));

    res.json({ events, count: events.length });
  } catch (error) {
    console.error('❌ CALENDAR_EVENTS:', error.message);
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});

export default router;
