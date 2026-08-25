import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Pool verso il progetto Neon "Projexa-Auth" (autenticazione: users con email/password/scadenza).
// Separato da database.js (Projexa, dominio + FK). Connection string in AUTH_DATABASE_URL.
if (!process.env.AUTH_DATABASE_URL) {
  console.warn('⚠️  AUTH_DATABASE_URL non impostata: le funzioni di autenticazione falliranno finché non la configuri.');
}

const authPool = new Pool({
  connectionString: process.env.AUTH_DATABASE_URL
});

authPool.on('error', (err) => {
  console.error('Unexpected error on idle AUTH client', err);
});

export default authPool;

export const authQuery = (text, params) => {
  return authPool.query(text, params);
};
