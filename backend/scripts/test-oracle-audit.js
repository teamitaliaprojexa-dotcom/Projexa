// Prova della connessione a Oracle per il log accessi/variazioni.
// Uso (sulla VM, dalla cartella /opt/projexa/backend):  node scripts/test-oracle-audit.js
// Legge ORACLE_AUDIT_* dal .env, si collega e conta le righe delle due tabelle.
// Non scrive nulla.
import dotenv from 'dotenv';
import oracledb from 'oracledb';

dotenv.config();
const schema = (process.env.ORACLE_AUDIT_SCHEMA || 'AUDIT_OWNER').toUpperCase();

try {
  const conn = await oracledb.getConnection({
    user: process.env.ORACLE_AUDIT_USER,
    password: process.env.ORACLE_AUDIT_PASSWORD,
    connectString: process.env.ORACLE_AUDIT_CONNECT
  });
  const who = await conn.execute(`SELECT USER, SYS_CONTEXT('USERENV', 'DB_NAME') FROM dual`);
  console.log(`✓ Collegato a Oracle come ${who.rows[0][0]} (database ${who.rows[0][1]})`);
  for (const t of ['LOG_ACCESSI', 'LOG_VARIAZIONI']) {
    const r = await conn.execute(`SELECT COUNT(*) FROM ${schema}.${t}`);
    console.log(`✓ ${schema}.${t}: ${r.rows[0][0]} righe`);
  }
  await conn.close();
} catch (e) {
  console.error(`✗ Connessione non riuscita: ${e.message}`);
  process.exitCode = 1;
}
