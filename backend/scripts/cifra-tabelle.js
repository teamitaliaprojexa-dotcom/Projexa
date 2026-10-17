// Cifra i valori ancora in chiaro delle righe con crypto = 1 (2026-10-17).
//
//   node scripts/cifra-tabelle.js rubrica mysupport clients projects            (prova: conta soltanto)
//   node scripts/cifra-tabelle.js rubrica mysupport clients projects --esegui   (cifra)
//
// Stessa regola dell'applicazione (config/crypto.js: colonne ammesse per tabella). Ogni tabella
// è una transazione: prima del COMMIT ogni valore cifrato viene decifrato e confrontato con
// l'originale; se uno solo non torna, la tabella viene annullata. Ripetibile: i valori già
// cifrati vengono saltati. Per tornare indietro: «Migrazione Crypto» › Decripta.
// Lavora sul DATABASE_URL del .env (in locale, via tunnel, è la produzione).
import pg from 'pg';
import dotenv from 'dotenv';
import { getCryptoPolicy, encryptValue, decryptValue, isEncrypted, hasEncryptionKey } from '../config/crypto.js';

dotenv.config();
const esegui = process.argv.includes('--esegui');
const tabelle = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!tabelle.length) { console.error('Indica le tabelle da cifrare.'); process.exit(2); }
if (!hasEncryptionKey()) { console.error('ENCRYPTION_KEY mancante: niente da fare.'); process.exit(2); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const pool = { query: (t, p) => client.query(t, p) };
let errori = 0;

for (const tabella of tabelle) {
  if (!/^[a-z_][a-z0-9_]*$/.test(tabella)) { console.error(`${tabella}: nome non valido`); errori++; continue; }
  const policy = await getCryptoPolicy(pool, tabella);
  if (!policy.hasCryptoColumn || !policy.encryptColumns.length || !policy.hasId) {
    console.log(`${tabella}: nessuna colonna da cifrare (colonna crypto presente: ${policy.hasCryptoColumn})`);
    continue;
  }
  const cols = policy.encryptColumns;
  const righe = (await client.query(
    `SELECT id, ${cols.map((c) => `"${c}"::text AS "${c}"`).join(', ')} FROM "${tabella}" WHERE crypto = 1`)).rows;
  const daFare = [];
  for (const r of righe) {
    const set = {};
    for (const c of cols) {
      const v = r[c];
      if (v == null || v === '' || isEncrypted(v)) continue;
      set[c] = { prima: v, dopo: encryptValue(v) };
    }
    if (Object.keys(set).length) daFare.push({ id: r.id, set });
  }
  const valori = daFare.reduce((n, x) => n + Object.keys(x.set).length, 0);
  console.log(`${tabella}: ${righe.length} righe da cifrare, ${daFare.length} con valori in chiaro (${valori} valori) - colonne: ${cols.join(', ')}`);
  if (!esegui || !daFare.length) continue;

  try {
    await client.query('BEGIN');
    for (const x of daFare) {
      const nomi = Object.keys(x.set);
      for (const c of nomi) if (decryptValue(x.set[c].dopo) !== x.set[c].prima) throw new Error(`verifica fallita su ${tabella}.${c}`);
      await client.query(
        `UPDATE "${tabella}" SET ${nomi.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE id = $1`,
        [x.id, ...nomi.map((c) => x.set[c].dopo)]);
    }
    // Controllo finale sul database: riletti e decifrati devono coincidere.
    const ids = daFare.map((x) => x.id);
    const dopo = (await client.query(`SELECT id, ${cols.map((c) => `"${c}"::text AS "${c}"`).join(', ')} FROM "${tabella}" WHERE id = ANY($1)`, [ids])).rows;
    const perId = new Map(dopo.map((r) => [String(r.id), r]));
    for (const x of daFare) for (const c of Object.keys(x.set)) {
      if (decryptValue(perId.get(String(x.id))[c]) !== x.set[c].prima) throw new Error(`controllo finale fallito su ${tabella}.${c}`);
    }
    await client.query('COMMIT');
    console.log(`${tabella}: cifrati ${valori} valori`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`${tabella}: ANNULLATO (${e.message})`);
    errori++;
  }
}
await client.end();
process.exit(errori ? 1 : 0);
