import { verifySessionToken } from '../config/session.js';

// Middleware di autenticazione: verifica il token di sessione nell'header Authorization
// (tipo "session" e password non cambiata dopo il login: vedi config/session.js).
// In caso di token assente/non valido blocca la richiesta con 401.
// Se valido, espone il payload decodificato su req.user (user_id, email, tenant_id, ...).
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
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
  next();
}

export default requireAuth;
