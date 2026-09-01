// Whitelist delle origini consentite (CORS + destinatari dei postMessage OAuth).
// Sorgente unica: usata sia dal middleware CORS di server.js sia dal flusso OAuth
// di Jira, così non c'è il rischio che le due liste divergano.
import dotenv from 'dotenv';

dotenv.config();

export const allowedOrigins = new Set([
  'http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:8000',
  ...String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
]);

// true se l'origine è in whitelist. L'origine assente (richieste same-origin,
// server-to-server) va gestita dal chiamante: qui è considerata non valida.
export function isAllowedOrigin(origin) {
  return !!origin && allowedOrigins.has(origin);
}

export default allowedOrigins;
