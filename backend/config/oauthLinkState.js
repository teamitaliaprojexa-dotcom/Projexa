// "State" dei collegamenti OAuth di Calendario (Google/Outlook) e Jira legato al browser.
//
// Lo state firmato (JWT) dice a quale utente salvare i token, ma da solo non basta: chi
// genera il link di consenso dal proprio account potrebbe farlo aprire a un altro utente,
// e i token del calendario/Jira di quest'ultimo finirebbero sull'account di chi ha creato
// il link. Per questo il nonce dello state viene anche messo in un cookie HttpOnly del
// browser che ha avviato il collegamento: il callback lo accetta solo se coincidono.
//
// Il cookie ha Path = prefisso del callback (/api/calendar, /api/jira), così i due
// collegamenti avviati insieme non si sovrascrivono, e SameSite=Lax perché deve arrivare
// quando il fornitore rimanda il browser al callback.
import crypto from 'crypto';
import { readCookie, setCookie, clearCookie } from './cookies.js';

const COOKIE = 'px_link_state';
const MAX_AGE_SEC = 10 * 60; // come la scadenza dello state

// Da chiamare all'avvio (authorize-url): restituisce il nonce da mettere nello state.
export function startLinkState(req, res, path) {
  const nonce = crypto.randomBytes(32).toString('hex');
  setCookie(req, res, COOKIE, nonce, { path, maxAgeSec: MAX_AGE_SEC, sameSite: 'Lax' });
  return nonce;
}

// Da chiamare nel callback: true se il nonce dello state coincide con quello del cookie
// (che viene cancellato in ogni caso: vale una volta sola).
export function checkLinkState(req, res, path, nonce) {
  const expected = readCookie(req, COOKIE) || '';
  clearCookie(req, res, COOKIE, { path, sameSite: 'Lax' });
  const got = String(nonce || '');
  if (!expected || expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
