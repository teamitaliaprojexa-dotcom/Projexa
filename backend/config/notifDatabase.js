import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Pool verso il progetto Neon "Projexa-Notif" (notifiche ed invio email).
// Separato da database.js (Projexa), authDatabase.js (Projexa-Auth) e licenseDatabase.js (Projexa-Lic).
// Connection string in NOTIF_DATABASE_URL.
if (!process.env.NOTIF_DATABASE_URL) {
  console.warn('⚠️  NOTIF_DATABASE_URL non impostata: le funzioni sulle notifiche falliranno finché non la configuri.');
}

const notifPool = new Pool({
  connectionString: process.env.NOTIF_DATABASE_URL
});

notifPool.on('error', (err) => {
  console.error('Unexpected error on idle NOTIF client', err);
});

export default notifPool;

export const notifQuery = (text, params) => {
  return notifPool.query(text, params);
};
