// Token di sessione (JWT) dell'app: creazione e verifica in un solo punto.
//
// - typ = 'session': gli altri JWT firmati con lo stesso segreto (link di conferma e di
//   reset password, "state" degli OAuth di calendario e Jira) non valgono come sessione.
// - psig = firma dell'hash della password (HMAC, non l'hash): quando la password cambia
//   la firma non torna più e tutte le sessioni aperte con la vecchia password decadono,
//   senza colonne aggiuntive sul database. La firma attuale si rilegge da Projexa-Auth
//   con una cache di 60 secondi; il cambio password la svuota subito per quell'utente.
// - jti = identificativo della singola sessione: al logout finisce in session_revoked
//   (Projexa-Auth) e quel token non vale più, anche se qualcuno ne avesse una copia.
// - Il token viaggia SOLO nel cookie HttpOnly px_session (Path=/api, SameSite=Strict):
//   JavaScript non lo può leggere, quindi un eventuale XSS non può rubare la sessione.
//   Al browser arriva solo una "vista" dei claims (sessionClaimsView) senza firma valida,
//   che le pagine usano per ruolo/nome e come segnaposto nell'header Authorization.
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import JWT_SECRET from './jwt.js';
import authDb from './authDatabase.js';
import db from './database.js';
import { readCookie, setCookie, clearCookie } from './cookies.js';

export const SESSION_TYP = 'session';
export const SESSION_COOKIE = 'px_session';
const SESSION_TTL_SEC = 24 * 60 * 60;
const SIG_CACHE_MS = 60 * 1000;

export function passwordSignature(passwordHash) {
  return crypto.createHmac('sha256', JWT_SECRET).update(String(passwordHash || '')).digest('hex').slice(0, 32);
}

// claims: user_id, email, tenant_id, tenant_name, role_id, id_roles, role_name.
// Eventuali typ/psig/iat/exp/jti in ingresso (es. da un token esistente) vengono sostituiti.
export function signSessionToken(claims, passwordHash) {
  const { iat, exp, typ, psig, jti, ...rest } = claims || {};
  return jwt.sign({ ...rest, typ: SESSION_TYP, psig: passwordSignature(passwordHash) }, JWT_SECRET,
    { expiresIn: SESSION_TTL_SEC, jwtid: crypto.randomUUID() });
}

// ----------------------------------------------------------------------------
// Cookie di sessione
// ----------------------------------------------------------------------------
export function readSessionCookie(req) {
  return readCookie(req, SESSION_COOKIE);
}

export function clearSessionCookie(req, res) {
  clearCookie(req, res, SESSION_COOKIE, { path: '/api', sameSite: 'Strict' });
}

// Claims leggibili dal browser, nella forma header.payload.firma di un JWT così il codice
// delle pagine che ne legge il payload resta invariato. Non c'è una firma valida e non
// ci sono psig/jti: non serve ad autenticarsi.
export function sessionClaimsView(token) {
  const { psig, jti, ...pub } = jwt.decode(token) || {};
  return 'cookie.' + Buffer.from(JSON.stringify(pub)).toString('base64url') + '.session';
}

// Imposta il cookie di sessione e restituisce la vista dei claims da mandare al browser
// (campo "token" delle risposte di login, cambio password, impersonificazione).
export function issueSession(req, res, token) {
  setCookie(req, res, SESSION_COOKIE, token, { path: '/api', maxAgeSec: SESSION_TTL_SEC, sameSite: 'Strict' });
  return sessionClaimsView(token);
}

// ----------------------------------------------------------------------------
// Revoca (logout): tabella session_revoked su Projexa-Auth
// ----------------------------------------------------------------------------
// Una sessione revocata resta in cache fino alla sua scadenza; quelle valide si
// ricontrollano dopo 60 secondi. Se la tabella non esiste ancora (SQL da eseguire:
// Supporto/CreaDB/session_revoked.sql) la revoca è disattivata con un avviso: il logout
// cancella comunque il cookie.
const revokedCache = new Map(); // jti -> { revoked, at, exp }
let revokedTableMissing = false;

function pruneRevokedCache() {
  if (revokedCache.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of revokedCache) {
    if (v.revoked ? v.exp * 1000 < now : now - v.at > SIG_CACHE_MS) revokedCache.delete(k);
  }
}

function warnMissingTable() {
  if (!revokedTableMissing) console.warn('⚠️ AUTH: tabella session_revoked assente su Projexa-Auth: revoca delle sessioni al logout disattivata (eseguire Supporto/CreaDB/session_revoked.sql)');
  revokedTableMissing = true;
}

async function isRevoked(jti, exp) {
  const hit = revokedCache.get(jti);
  if (hit && (hit.revoked || Date.now() - hit.at < SIG_CACHE_MS)) return hit.revoked;
  if (revokedTableMissing) return false;
  let revoked = false;
  try {
    const r = await authDb.query('SELECT 1 FROM session_revoked WHERE jti = $1', [jti]);
    revoked = r.rows.length > 0;
  } catch (e) {
    if (e.code === '42P01') { warnMissingTable(); return false; }
    throw e;
  }
  pruneRevokedCache();
  revokedCache.set(jti, { revoked, at: Date.now(), exp });
  return revoked;
}

// Revoca la sessione del token indicato (firma verificata, anche se il resto non è più valido).
export async function revokeSessionToken(token) {
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { return; }
  if (p.typ !== SESSION_TYP || !p.jti) return;
  revokedCache.set(p.jti, { revoked: true, at: Date.now(), exp: p.exp });
  if (revokedTableMissing) return;
  try {
    await authDb.query(
      `INSERT INTO session_revoked (jti, user_id, expires_at) VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT (jti) DO NOTHING`,
      [p.jti, p.user_id || null, p.exp]
    );
    await authDb.query('DELETE FROM session_revoked WHERE expires_at < NOW()');
  } catch (e) {
    if (e.code === '42P01') warnMissingTable();
    else console.error('❌ AUTH: revoca sessione non salvata:', e.message);
  }
}

const sigCache = new Map(); // user_id -> { sig, at }

async function currentSignature(userId) {
  const key = String(userId);
  const hit = sigCache.get(key);
  if (hit && Date.now() - hit.at < SIG_CACHE_MS) return hit.sig;
  const r = await authDb.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const sig = r.rows[0] ? passwordSignature(r.rows[0].password_hash) : null;
  sigCache.set(key, { sig, at: Date.now() });
  return sig;
}

// Da chiamare dopo ogni cambio password: le sessioni vecchie decadono subito.
export function forgetSessionSignature(userId) {
  sigCache.delete(String(userId));
}

// ----------------------------------------------------------------------------
// Ruolo e appartenenza al tenant RILETTI DAL DATABASE (non presi dal token)
// ----------------------------------------------------------------------------
// I claims id_roles / role_id / role_name / tenant_name scritti nel token al login non
// sono più affidabili per 24 ore: si rileggono da user_tenants (cache di 60 s, come la
// firma della password). Così:
//   - utente tolto dal tenant          -> la sessione decade entro un minuto;
//   - ruolo cambiato (es. tolto admin)  -> vale il nuovo ruolo entro un minuto.
// id_roles = 1 (Admin) è riservato all'account Admin Projexa: vale solo per chi è admin
// del tenant PROJEXA. Una sessione con id_roles = 1 di chiunque altro viene rifiutata
// (nessun admin di un cliente può usare impersonazione, SQL editor, dati di tutti i tenant).
const membershipCache = new Map(); // "user|tenant" -> { m, at }

async function currentMembership(userId, tenantId) {
  const key = `${userId}|${tenantId}`;
  const hit = membershipCache.get(key);
  if (hit && Date.now() - hit.at < SIG_CACHE_MS) return hit.m;
  const r = await db.query(
    `SELECT ut.role_id, ut.id_roles, r.name AS role_name, t.name AS tenant_name,
            EXISTS (SELECT 1 FROM user_tenants pa JOIN tenants pt ON pt.id = pa.tenant_id
                     WHERE pa.user_id = ut.user_id AND pa.id_roles = 1
                       AND UPPER(BTRIM(pt.name)) = 'PROJEXA') AS projexa_admin
       FROM user_tenants ut
       JOIN tenants t ON t.id = ut.tenant_id
       LEFT JOIN roles r ON r.id_roles = ut.id_roles
      WHERE ut.user_id = $1 AND ut.tenant_id = $2
      LIMIT 1`,
    [userId, tenantId]
  );
  const m = r.rows[0] || null;
  membershipCache.set(key, { m, at: Date.now() });
  return m;
}

// Restituisce i claims del token o lancia un errore con status 401.
export async function verifySessionToken(token) {
  const unauthorized = (msg) => Object.assign(new Error(msg), { status: 401 });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw unauthorized('Token non valido o scaduto');
  }
  if (payload.typ !== SESSION_TYP || !payload.user_id || !payload.tenant_id || !payload.psig || !payload.jti) {
    throw unauthorized('Token non valido o scaduto');
  }
  if (await isRevoked(payload.jti, payload.exp)) {
    throw unauthorized('Sessione chiusa: accedi di nuovo');
  }
  const sig = await currentSignature(payload.user_id);
  if (!sig || sig !== payload.psig) {
    throw unauthorized('Sessione non più valida: accedi di nuovo');
  }
  const m = await currentMembership(payload.user_id, payload.tenant_id);
  if (!m) {
    throw unauthorized('Non hai più accesso a questo spazio di lavoro: accedi di nuovo');
  }
  if (Number(m.id_roles) === 1 && !m.projexa_admin) {
    console.warn(`⚠️ AUTH: id_roles = 1 per l'utente ${payload.user_id} nel tenant ${payload.tenant_id}, ma non è l'Admin Projexa: sessione rifiutata`);
    throw unauthorized('Ruolo non valido per questo spazio di lavoro: contatta l\'amministratore');
  }
  return {
    ...payload,
    role_id: m.role_id,
    id_roles: m.id_roles,
    role_name: m.role_name,
    tenant_name: m.tenant_name
  };
}
