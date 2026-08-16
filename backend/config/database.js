import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

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
