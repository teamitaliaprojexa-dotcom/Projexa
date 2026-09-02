import pg from 'pg';
import dotenv from 'dotenv';
import { withDecryption } from './cryptoPool.js';

dotenv.config();

const { Pool } = pg;

// Pool verso il progetto Neon "Projexa-Lic" (gestione licenze).
// Separato da database.js (Projexa) e authDatabase.js (Projexa-Auth). Connection string in LICEN_DATABASE_URL.
if (!process.env.LICEN_DATABASE_URL) {
  console.warn('⚠️  LICEN_DATABASE_URL non impostata: le funzioni sulle licenze falliranno finché non la configuri.');
}

// withDecryption: i valori cifrati ("enc:v1:...") tornano in chiaro in lettura.
const licensePool = withDecryption(new Pool({
  connectionString: process.env.LICEN_DATABASE_URL
}));

licensePool.on('error', (err) => {
  console.error('Unexpected error on idle LICENSE client', err);
});

export default licensePool;

export const licenseQuery = (text, params) => {
  return licensePool.query(text, params);
};
