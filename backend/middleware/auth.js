import jwt from 'jsonwebtoken';
import JWT_SECRET from '../config/jwt.js';

// Middleware di autenticazione: verifica il JWT nell'header Authorization.
// In caso di token assente/non valido blocca la richiesta con 401.
// Se valido, espone il payload decodificato su req.user (user_id, email, tenant_id, ...).
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}

export default requireAuth;
