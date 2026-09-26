// Login con Google / Microsoft: avvio, controllo dello "state" e consegna del token.
//
// 1. /api/auth/<provider>/start genera uno "state" casuale, lo salva in un cookie HttpOnly
//    e manda il browser alla pagina di consenso del fornitore con lo stesso state.
// 2. Il callback confronta lo state ricevuto con il cookie: se non coincidono il login
//    non è partito da questo browser (login CSRF) e viene rifiutato.
// 3. Il token di sessione non viaggia nell'URL (cronologia, log, Referer): va in un cookie
//    HttpOnly valido 60 secondi, che oauth-complete.html scambia subito con una POST a
//    /api/auth/oauth-exchange. Il cookie si cancella al primo uso.
import crypto from 'crypto';

const STATE_COOKIE = 'px_oauth_state';
const LOGIN_COOKIE = 'px_oauth_login';
const BACKEND_URL = () => process.env.BACKEND_URL || 'https://projexa-4mix.onrender.com';

const PROVIDERS = {
  google: () => ({
    url: 'https://accounts.google.com/o/oauth2/v2/auth',
    params: {
      client_id: process.env.GOOGLE_CLIENT_ID || '128379880931-guh70j47lsvplo9m1intpj9tt7escdn8.apps.googleusercontent.com',
      redirect_uri: `${BACKEND_URL()}/api/auth/google-callback`,
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.readonly',
      access_type: 'offline',
      prompt: 'consent'
    }
  }),
  microsoft: () => ({
    url: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`,
    params: {
      client_id: process.env.MICROSOFT_CLIENT_ID,
      redirect_uri: `${BACKEND_URL()}/api/auth/microsoft-callback`,
      response_type: 'code',
      scope: 'openid email profile Calendars.Read Mail.Read',
      response_mode: 'query',
      prompt: 'select_account'
    }
  })
};

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieOptions(req, path, maxAgeSec) {
  // Lax: il cookie arriva anche quando il fornitore rimanda il browser al callback.
  return [`Path=${path}`, `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax', req.secure ? 'Secure' : '']
    .filter(Boolean).join('; ');
}

function appendCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), value]);
}

export function startOAuthLogin(req, res, provider) {
  const cfg = PROVIDERS[provider] && PROVIDERS[provider]();
  if (!cfg || !cfg.params.client_id) return res.redirect('/login.html?error=oauth_non_configurato');
  const state = crypto.randomBytes(32).toString('hex');
  appendCookie(res, `${STATE_COOKIE}=${state}; ${cookieOptions(req, '/api/auth', 600)}`);
  const url = new URL(cfg.url);
  for (const [k, v] of Object.entries({ ...cfg.params, state })) url.searchParams.set(k, v);
  res.redirect(url.toString());
}

// true se lo state del callback coincide con quello del cookie (che viene cancellato).
export function checkOAuthState(req, res) {
  const expected = readCookie(req, STATE_COOKIE) || '';
  const got = String(req.query.state || '');
  appendCookie(res, `${STATE_COOKIE}=; ${cookieOptions(req, '/api/auth', 0)}`);
  if (!expected || expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

// Consegna il token al browser senza metterlo nell'URL, poi apre la pagina di scambio.
export function deliverLoginToken(req, res, token, user) {
  const payload = Buffer.from(JSON.stringify({ t: token, u: user || {} })).toString('base64url');
  appendCookie(res, `${LOGIN_COOKIE}=${payload}; ${cookieOptions(req, '/api/auth/oauth-exchange', 60)}`);
  res.redirect('/oauth-complete.html');
}

// Legge e cancella il cookie del login: { t: token, u: user } oppure null.
export function takeLoginToken(req, res) {
  const raw = readCookie(req, LOGIN_COOKIE);
  appendCookie(res, `${LOGIN_COOKIE}=; ${cookieOptions(req, '/api/auth/oauth-exchange', 0)}`);
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
