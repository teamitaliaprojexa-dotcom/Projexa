import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// OID 1082 = tipo 'date' di Postgres. Di default pg lo converte in un oggetto
// Date usando il fuso orario locale del server (es. Europe/Rome), il che causa
// uno shift di un giorno quando poi viene serializzato in JSON: JSON.stringify
// chiama toISOString() sull'oggetto Date, che lo riporta a UTC (es. mezzanotte
// locale del 31/08 a Roma in estate = 30/08 22:00 UTC). Restituendo la stringa
// grezza 'YYYY-MM-DD' così com'è, non c'è alcuna conversione di fuso orario e
// la data letta dal DB resta esattamente quella salvata.
pg.types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;

export const query = (text, params) => {
  return pool.query(text, params);
};

export const dbAll = async (sql, params = []) => {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (error) {
    console.error('Database error:', error);
    throw error;
  }
};

export const dbRun = async (sql, params = []) => {
  try {
    const result = await pool.query(sql, params);
    return result;
  } catch (error) {
    console.error('Database error:', error);
    throw error;
  }
};

export const dbGet = async (sql, params = []) => {
  try {
    const result = await pool.query(sql, params);
    return result.rows[0];
  } catch (error) {
    console.error('Database error:', error);
    throw error;
  }
};
