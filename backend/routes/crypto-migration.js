// ============================================================================
// MIGRAZIONE CRYPTO — cifra/decifra i dati già presenti su una tabella
// ----------------------------------------------------------------------------
// Usata dal pulsante "Migrazione Crypto" del database-viewer per fare il cambio
// di gestione una tabella alla volta, in modo manuale e controllato.
//
//   GET  /api/crypto/tables?db=main            elenco tabelle del database scelto
//   GET  /api/crypto/table-info?db=&table=     cosa verrà cifrato e quante righe
//   POST /api/crypto/encrypt   { db, table }   cifra le righe con crypto = 1
//   POST /api/crypto/decrypt   { db, table }   riporta in chiaro tutto il cifrato
//
// Il database si sceglie con il parametro `db` (main | auth | lic | notif), non
// con l'header X-Target-DB: la migrazione deve poter agire su un ambiente diverso
// da quello che si sta guardando nel viewer.
//
// Tutte le letture/scritture qui usano `rawQuery`, cioè il pool SENZA decifratura
// automatica: la migrazione deve vedere il testo cifrato esattamente com'è sul DB.
// Ogni operazione gira dentro una transazione: o si applica tutta o niente.
// ============================================================================
import express from 'express';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import licenseDb from '../config/licenseDatabase.js';
import notifDb from '../config/notifDatabase.js';
import {
  getCryptoPolicy,
  clearCryptoPolicyCache,
  encryptValue,
  decryptValue,
  isEncrypted,
  hasEncryptionKey
} from '../config/crypto.js';

const router = express.Router();

const DB_POOLS = { main: db, auth: authDb, lic: licenseDb, notif: notifDb };
const DB_LABELS = { main: 'Projexa', auth: 'Projexa-Auth', lic: 'Projexa-Lic', notif: 'Projexa-Notif' };

// Numero massimo di righe elaborate in una singola migrazione (sicurezza).
const MAX_ROWS = 50000;

function pickPool(req) {
  const key = String((req.query && req.query.db) || (req.body && req.body.db) || 'main');
  if (!Object.prototype.hasOwnProperty.call(DB_POOLS, key)) {
    const err = new Error(`Database non valido: ${key}`);
    err.statusCode = 400;
    throw err;
  }
  return { key, pool: DB_POOLS[key] };
}

// Query senza decifratura automatica (vedi config/cryptoPool.js).
function raw(target) {
  return (target.rawQuery || target.query).bind(target);
}

function assertValidIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    const err = new Error(`Identificatore non valido: ${name}`);
    err.statusCode = 400;
    throw err;
  }
  return name;
}

// Le righe da cifrare sono quelle con crypto = 1. La colonna può essere smallint,
// integer o boolean a seconda di come è stata creata: il confronto su testo le copre tutte.
const CRYPTO_ON = `crypto::text IN ('1', 'true', 't')`;

// ----------------------------------------------------------------------------
// Elenco database e tabelle
// ----------------------------------------------------------------------------

router.get('/databases', (req, res) => {
  res.json(Object.keys(DB_POOLS).map((k) => ({ key: k, label: DB_LABELS[k] })));
});

router.get('/tables', async (req, res) => {
  try {
    const { key, pool } = pickPool(req);
    const result = await raw(pool)(
      `SELECT t.table_name,
              EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema = 'public'
                         AND c.table_name = t.table_name
                         AND c.column_name = 'crypto') AS has_crypto
         FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`
    );
    res.json({
      db: key,
      label: DB_LABELS[key],
      tables: result.rows.map((r) => ({ name: r.table_name, hasCrypto: r.has_crypto === true }))
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------------
// Anteprima: cosa succederà su questa tabella
// ----------------------------------------------------------------------------

router.get('/table-info', async (req, res) => {
  try {
    const { key, pool } = pickPool(req);
    const table = assertValidIdentifier(String(req.query.table || ''));
    clearCryptoPolicyCache(); // l'utente può aver appena aggiunto la colonna crypto
    const policy = await getCryptoPolicy(pool, table, key);

    const info = {
      db: key,
      label: DB_LABELS[key],
      table,
      hasKey: hasEncryptionKey(),
      hasCryptoColumn: policy.hasCryptoColumn,
      encryptColumns: policy.encryptColumns,
      skipped: policy.skipped,
      rowsTotal: 0,
      rowsCrypto: 0,
      valuesEncrypted: 0,
      valuesPlain: 0
    };

    const totals = await raw(pool)(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    info.rowsTotal = totals.rows[0].n;

    if (policy.hasCryptoColumn) {
      const c = await raw(pool)(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${CRYPTO_ON}`);
      info.rowsCrypto = c.rows[0].n;

      // Conteggio dei valori già cifrati / ancora in chiaro sulle colonne coinvolte.
      if (policy.encryptColumns.length > 0) {
        const conds = policy.encryptColumns.map((c2) => `"${c2}"`);
        const encExpr = conds.map((c2) => `(CASE WHEN ${c2} LIKE 'enc:v1:%' THEN 1 ELSE 0 END)`).join(' + ');
        const plainExpr = conds
          .map((c2) => `(CASE WHEN ${c2} IS NOT NULL AND ${c2} <> '' AND ${c2} NOT LIKE 'enc:v1:%' THEN 1 ELSE 0 END)`)
          .join(' + ');
        const v = await raw(pool)(
          `SELECT COALESCE(SUM(${encExpr}), 0)::int AS enc,
                  COALESCE(SUM(${plainExpr}), 0)::int AS plain
             FROM "${table}" WHERE ${CRYPTO_ON}`
        );
        info.valuesEncrypted = v.rows[0].enc;
        info.valuesPlain = v.rows[0].plain;
      }
    }

    res.json(info);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------------
// Migrazione vera e propria
// ----------------------------------------------------------------------------

// Chiave per identificare la riga negli UPDATE: "id" se c'è, altrimenti il ctid
// (indirizzo fisico della riga in Postgres), che funziona su qualsiasi tabella.
function rowKey(policy) {
  return policy.hasId
    ? { select: '"id"', where: '"id" = $KEY', cast: '' }
    : { select: 'ctid', where: 'ctid = $KEY::tid', cast: '::tid' };
}

async function migrate(req, res, mode) {
  const started = Date.now();
  let client = null;
  try {
    const { key, pool } = pickPool(req);
    const table = assertValidIdentifier(String((req.body && req.body.table) || ''));

    if (!hasEncryptionKey()) {
      return res.status(400).json({
        error: 'ENCRYPTION_KEY non impostata: configurala nel .env (locale) e su Render prima di migrare.'
      });
    }

    clearCryptoPolicyCache();
    const policy = await getCryptoPolicy(pool, table, key);

    if (!policy.hasCryptoColumn) {
      return res.status(400).json({
        error: `La tabella "${table}" non ha la colonna "crypto": aggiungila prima di migrare ` +
               '(vedi Supporto/CreaDB/crypto_migrazione.sql).'
      });
    }

    // In cifratura si toccano solo le colonne previste dalla regola.
    // In decifratura si passano tutte le colonne testuali: così si recupera anche
    // ciò che era stato cifrato con una regola diversa da quella attuale.
    const columns = mode === 'encrypt' ? policy.encryptColumns : policy.textColumns;
    if (columns.length === 0) {
      return res.json({
        db: key, table, mode, rowsScanned: 0, rowsChanged: 0, valuesChanged: 0,
        columns: [], skipped: policy.skipped,
        message: 'Nessuna colonna da elaborare secondo la regola.'
      });
    }

    const kk = rowKey(policy);
    const quoted = columns.map((c) => `"${c}"`).join(', ');
    // In cifratura si prendono solo le righe marcate crypto = 1; in decifratura
    // si passano tutte le righe, perché possono esserci valori cifrati anche su
    // righe che nel frattempo sono state messe a crypto = 0.
    const where = mode === 'encrypt' ? `WHERE ${CRYPTO_ON}` : '';

    client = await (pool.rawConnect || pool.connect).call(pool);
    const q = raw(client);

    const rows = (await q(
      `SELECT ${kk.select} AS __key, ${quoted} FROM "${table}" ${where} LIMIT ${MAX_ROWS + 1}`
    )).rows;

    if (rows.length > MAX_ROWS) {
      client.release();
      return res.status(400).json({
        error: `Tabella troppo grande per la migrazione automatica (oltre ${MAX_ROWS} righe).`
      });
    }

    await q('BEGIN');
    let rowsChanged = 0;
    let valuesChanged = 0;

    for (const row of rows) {
      const sets = [];
      const values = [];
      for (const col of columns) {
        const current = row[col];
        if (current === null || current === undefined || current === '') continue;
        let next;
        if (mode === 'encrypt') {
          if (isEncrypted(current)) continue;      // già cifrato
          next = encryptValue(current);
        } else {
          if (!isEncrypted(current)) continue;     // già in chiaro
          next = decryptValue(current);
          if (next === current) {
            // decryptValue restituisce l'originale se nessuna chiave funziona:
            // meglio fermarsi che riscrivere dati illeggibili.
            throw Object.assign(
              new Error(`Impossibile decifrare "${table}"."${col}": ENCRYPTION_KEY diversa da quella usata per cifrare.`),
              { statusCode: 400 }
            );
          }
        }
        values.push(next);
        sets.push(`"${col}" = $${values.length}`);
        valuesChanged += 1;
      }
      if (sets.length === 0) continue;
      values.push(row.__key);
      await q(
        `UPDATE "${table}" SET ${sets.join(', ')} WHERE ${kk.where.replace('$KEY', `$${values.length}`)}`,
        values
      );
      rowsChanged += 1;
    }

    await q('COMMIT');
    client.release();
    client = null;

    res.json({
      db: key,
      label: DB_LABELS[key],
      table,
      mode,
      rowsScanned: rows.length,
      rowsChanged,
      valuesChanged,
      columns,
      skipped: policy.skipped,
      ms: Date.now() - started
    });
  } catch (error) {
    if (client) {
      try { await raw(client)('ROLLBACK'); } catch (e) { /* la transazione è già chiusa */ }
      client.release();
    }
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}

router.post('/encrypt', (req, res) => migrate(req, res, 'encrypt'));
router.post('/decrypt', (req, res) => migrate(req, res, 'decrypt'));

export default router;
