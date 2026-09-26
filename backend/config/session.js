// Token di sessione (JWT) dell'app: creazione e verifica in un solo punto.
//
// - typ = 'session': gli altri JWT firmati con lo stesso segreto (link di conferma e di
//   reset password, "state" degli OAuth di calendario e Jira) non valgono come sessione.
// - psig = firma dell'hash della password (HMAC, non l'hash): quando la password cambia
//   la firma non torna più e tutte le sessioni aperte con la vecchia password decadono,
//   senza colonne aggiuntive sul database. La firma attuale si rilegge da Projexa-Auth
//   con una cache di 60 secondi; il cambio password la svuota subito per quell'utente.
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import JWT_SECRET from './jwt.js';
import authDb from './authDatabase.js';

export const SESSION_TYP = 'session';
const SESSION_TTL = '24h';
const SIG_CACHE_MS = 60 * 1000;

export function passwordSignature(passwordHash) {
  return crypto.createHmac('sha256', JWT_SECRET).update(String(passwordHash || '')).digest('hex').slice(0, 32);
}

// claims: user_id, email, tenant_id, tenant_name, role_id, id_roles, role_name.
// Eventuali typ/psig/iat/exp in ingresso (es. da un token esistente) vengono sostituiti.
export function signSessionToken(claims, passwordHash) {
  const { iat, exp, typ, psig, ...rest } = claims || {};
  return jwt.sign({ ...rest, typ: SESSION_TYP, psig: passwordSignature(passwordHash) }, JWT_SECRET, { expiresIn: SESSION_TTL });
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

// Restituisce i claims del token o lancia un errore con status 401.
export async function verifySessionToken(token) {
  const unauthorized = (msg) => Object.assign(new Error(msg), { status: 401 });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw unauthorized('Token non valido o scaduto');
  }
  if (payload.typ !== SESSION_TYP || !payload.user_id || !payload.tenant_id || !payload.psig) {
    throw unauthorized('Token non valido o scaduto');
  }
  const sig = await currentSignature(payload.user_id);
  if (!sig || sig !== payload.psig) {
    throw unauthorized('Sessione non più valida: accedi di nuovo');
  }
  return payload;
}
