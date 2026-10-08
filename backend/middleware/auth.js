import { verifySessionToken, readSessionCookie } from '../config/session.js';
import { contestoDaRichiesta } from '../config/auditContext.js';

// Middleware di autenticazione: verifica il token di sessione del cookie HttpOnly px_session
// (tipo "session", password non cambiata dopo il login, sessione non chiusa con il logout:
// vedi config/session.js). In caso di token assente/non valido blocca la richiesta con 401.
// Se valido, espone il payload decodificato su req.user (user_id, email, tenant_id, ...).
//
// Protezione CSRF: il cookie il browser lo allega da solo, l'header Authorization no.
// Tutte le chiamate delle pagine Projexa lo inviano (con la vista dei claims come
// segnaposto); un altro sito non può aggiungerlo senza passare dal CORS, che lo rifiuta.
// Il cookie è anche SameSite=Strict: le richieste partite da altri siti non lo portano.
export async function requireAuth(req, res, next) {
  const token = readSessionCookie(req);

  if (!token || !req.headers.authorization) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }

  try {
    req.user = await verifySessionToken(token);
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ error: error.message });
    // Database di autenticazione non raggiungibile: meglio rifiutare che lasciar passare.
    console.error('❌ AUTH: verifica sessione non riuscita:', error.message);
    return res.status(503).json({ error: 'Servizio temporaneamente non disponibile' });
  }
  // Utente e tenant della richiesta arrivano ai trigger del log variazioni.
  contestoDaRichiesta(req, next);
}

export default requireAuth;
