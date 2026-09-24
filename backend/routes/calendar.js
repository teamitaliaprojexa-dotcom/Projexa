// === INTEGRAZIONE CALENDARIO (Google Calendar + Outlook/Microsoft 365, SOLA LETTURA) ===
//
// Stesso schema dell'integrazione Jira (vedi routes/jira.js): OAuth 2.0 con scope di
// sola lettura, i dati di autenticazione vengono salvati sul progetto Neon
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
import crypto from 'crypto';
import ical from 'node-ical';
import jwt from 'jsonwebtoken';
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

const TIPO_INTEGRAZIONE = 'Calendar';
const BACKEND_URL = process.env.BACKEND_URL || 'https://projexa-4mix.onrender.com';
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
    res.json({ providers: out });
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
// inviare l'esito via postMessage.
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
        uid: req.user.user_id,
        tid: req.user.tenant_id,
        provider: req.params.provider,
        origin,
        nonce: crypto.randomBytes(8).toString('hex')
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
    } catch {
      return res.status(400).send(callbackPage(origin, { ok: false, provider: req.params.provider, error: 'state non valido o scaduto' }));
    }
    if (claims.origin && isAllowedOrigin(claims.origin)) origin = claims.origin;
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
  const m = text.match(/https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|[\w.-]*zoom\.us)\/[^\s<>"')\]]+/i);
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
        eventType: ''
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
    eventType: ''
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
        const events = await fetchIcsEvents(el.outlook_ics_url, timeMin, timeMax);
        return res.json({ events, count: events.length });
      }
    }

    const session = await getCalendarSession(req.user.user_id, key);
    const events = key === 'outlook'
      ? await fetchOutlookEvents(session, timeMin, timeMax)
      : await fetchGoogleEvents(session, timeMin, timeMax);

    res.json({ events, count: events.length });
  } catch (error) {
    console.error('❌ CALENDAR_EVENTS:', error.message);
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});

export default router;
