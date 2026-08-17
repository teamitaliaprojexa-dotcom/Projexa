import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import db from './config/database.js';
import authRoutes from './routes/auth.js';
import microsoftOAuthRoutes from './routes/microsoft-oauth.js';
import tableStructuresRoutes from './routes/table-structures.js';
import calendarRoutes from './routes/calendar.js';
import { requireAuth } from './middleware/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from sito folder
const sitoPath = path.join(__dirname, '../sito');
app.use(express.static(sitoPath));
console.log(`📁 Serving static files from: ${sitoPath}`);

// Logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Projexa API is running' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth', microsoftOAuthRoutes);
app.use('/api/table-structures', requireAuth, tableStructuresRoutes);
app.use('/api/calendar', calendarRoutes);

// ==========================================
// HELPER DI SICUREZZA PER GLI ENDPOINT DATI
// ==========================================

// Colonne che non devono mai essere restituite al client.
const SENSITIVE_COLUMNS = new Set(['password', 'password_hash']);

// Rimuove le colonne sensibili dalle righe restituite (difesa in profondità:
// evita di far trapelare gli hash delle password anche se qualcuno fa SELECT *).
function stripSensitive(rows) {
  return rows.map((row) => {
    const clean = { ...row };
    for (const col of SENSITIVE_COLUMNS) delete clean[col];
    return clean;
  });
}

// Valida un identificatore SQL (nome tabella o colonna) contro un pattern sicuro.
// Blocca la SQL injection sui nomi che vengono interpolati nella query.
function assertValidIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    const err = new Error(`Identificatore non valido: ${name}`);
    err.statusCode = 400;
    throw err;
  }
  return name;
}

// Cache dei metadati colonne per tabella (evita una query information_schema a ogni richiesta).
const tableColumnsCache = new Map();

async function getTableColumns(tableName) {
  if (tableColumnsCache.has(tableName)) {
    return tableColumnsCache.get(tableName);
  }
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  const columns = new Set(result.rows.map((r) => r.column_name));
  tableColumnsCache.set(tableName, columns);
  return columns;
}

// Verifica che la tabella richiesta sia gestita (presente in table_structures)
// oppure sia la tabella di sistema table_structures. Restituisce true/false.
async function isManagedTable(tableName) {
  if (tableName === 'table_structures') return true;
  const tableCheck = await db.query(
    'SELECT 1 FROM table_structures WHERE table_name = $1 AND is_active = true',
    [tableName]
  );
  return tableCheck.rows.length > 0;
}

// Dynamic Generic Table Routes - reads from table_structures
app.get('/api/data/:table', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Isolamento multi-tenant: se la tabella ha una colonna tenant_id,
    // restituisce solo le righe del tenant dell'utente autenticato.
    const columns = await getTableColumns(tableName);
    if (columns.has('tenant_id')) {
      const result = await db.query(
        `SELECT * FROM "${tableName}" WHERE tenant_id = $1 LIMIT 100`,
        [req.user.tenant_id]
      );
      return res.json(stripSensitive(result.rows));
    }

    const result = await db.query(`SELECT * FROM "${tableName}" LIMIT 100`);
    res.json(stripSensitive(result.rows));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST - Create record
app.post('/api/data/:table', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    let data = { ...req.body };

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    // Isolamento multi-tenant: forza il tenant_id a quello dell'utente autenticato,
    // ignorando un eventuale valore inviato dal client.
    const tableColumns = await getTableColumns(tableName);
    if (tableColumns.has('tenant_id')) {
      data.tenant_id = req.user.tenant_id;
    }

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da inserire' });
    }
    const values = columns.map((col) => data[col]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quotedColumns = columns.map((c) => `"${c}"`).join(', ');

    const query = `INSERT INTO "${tableName}" (${quotedColumns}) VALUES (${placeholders}) RETURNING *`;
    const result = await db.query(query, values);

    res.status(201).json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// PUT - Update record
app.put('/api/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    const id = req.params.id;
    let data = { ...req.body };

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    // Non permettere al client di riassegnare il tenant_id di un record.
    const tableColumns = await getTableColumns(tableName);
    delete data.tenant_id;

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da aggiornare' });
    }
    const updates = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
    const values = [...columns.map((col) => data[col]), id];

    // Isolamento multi-tenant: se la tabella ha tenant_id, l'update tocca
    // solo i record del tenant dell'utente autenticato.
    let whereClause = `id = $${columns.length + 1}`;
    if (tableColumns.has('tenant_id')) {
      values.push(req.user.tenant_id);
      whereClause += ` AND tenant_id = $${columns.length + 2}`;
    }

    const query = `UPDATE "${tableName}" SET ${updates}, updated_at = CURRENT_TIMESTAMP WHERE ${whereClause} RETURNING *`;
    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// DELETE - Delete record
app.delete('/api/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    const id = req.params.id;

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Isolamento multi-tenant: si possono cancellare solo i record del proprio tenant.
    const tableColumns = await getTableColumns(tableName);
    let query = `DELETE FROM "${tableName}" WHERE id = $1 RETURNING *`;
    const values = [id];
    if (tableColumns.has('tenant_id')) {
      query = `DELETE FROM "${tableName}" WHERE id = $1 AND tenant_id = $2 RETURNING *`;
      values.push(req.user.tenant_id);
    }

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ message: 'Record deleted', data: stripSensitive(result.rows)[0] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ==========================================
// SQL EDITOR ENDPOINTS
// ==========================================
//
// ATTENZIONE: questi endpoint eseguono SQL arbitrario sul database.
// Sono ora protetti da requireAuth, ma restano uno strumento potente:
// qualsiasi utente autenticato può leggere/modificare dati di TUTTI i tenant
// (il raw SQL non può essere isolato per tenant). Andrebbero riservati a un
// ruolo amministratore. Per disabilitarli del tutto in produzione imposta
// la variabile d'ambiente DISABLE_SQL_EDITOR=true.

const SQL_EDITOR_ENABLED = process.env.DISABLE_SQL_EDITOR !== 'true';

// Transazioni attive per utente: tokenId -> client dedicato del pool.
// Fondamentale usare un singolo client per la transazione: BEGIN/COMMIT/ROLLBACK
// su un pool finirebbero su connessioni diverse e non funzionerebbero.
const activeTransactions = new Map();

// Identifica l'utente in modo stabile (dal JWT verificato) per legare la transazione.
function getTokenId(req) {
  return req.user?.user_id || req.user?.email || 'unknown';
}

function ensureSqlEditorEnabled(req, res, next) {
  if (!SQL_EDITOR_ENABLED) {
    return res.status(403).json({ error: 'SQL editor disabilitato' });
  }
  next();
}

// Execute SQL Query
app.post('/api/sql/execute', requireAuth, ensureSqlEditorEnabled, async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) {
      return res.status(400).json({ error: 'SQL query required' });
    }

    const tokenId = getTokenId(req);

    // Client su cui eseguire: quello della transazione aperta, se esiste.
    let client = activeTransactions.get(tokenId);

    // Se non c'è una transazione ed è una query di modifica, aprine una
    // su un client dedicato preso dal pool.
    if (!client && /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)/i.test(sql)) {
      client = await db.connect();
      await client.query('BEGIN');
      activeTransactions.set(tokenId, client);
    }

    // Esegui sul client della transazione se presente, altrimenti sul pool.
    const runner = client || db;
    const result = await runner.query(sql);

    res.json({
      rows: result.rows,
      columns: result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] || {}),
      affectedRows: result.rowCount,
      transactionActive: activeTransactions.has(tokenId)
    });
  } catch (error) {
    console.error('SQL Error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Commit Transaction
app.post('/api/sql/commit', requireAuth, ensureSqlEditorEnabled, async (req, res) => {
  const tokenId = getTokenId(req);
  const client = activeTransactions.get(tokenId);

  if (!client) {
    return res.status(400).json({ error: 'No active transaction' });
  }

  try {
    await client.query('COMMIT');
    res.json({ message: 'Transaction committed successfully' });
  } catch (error) {
    console.error('Commit Error:', error.message);
    res.status(400).json({ error: error.message });
  } finally {
    activeTransactions.delete(tokenId);
    client.release();
  }
});

// Rollback Transaction
app.post('/api/sql/rollback', requireAuth, ensureSqlEditorEnabled, async (req, res) => {
  const tokenId = getTokenId(req);
  const client = activeTransactions.get(tokenId);

  if (!client) {
    return res.status(400).json({ error: 'No active transaction' });
  }

  try {
    await client.query('ROLLBACK');
    res.json({ message: 'Transaction rolled back successfully' });
  } catch (error) {
    console.error('Rollback Error:', error.message);
    res.status(400).json({ error: error.message });
  } finally {
    activeTransactions.delete(tokenId);
    client.release();
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Projexa API running on http://localhost:${PORT}`);
  console.log(`📊 Database: PostgreSQL on Neon`);
  console.log(`\n✓ Health check: http://localhost:${PORT}/api/health\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down gracefully...');
  db.end((err) => {
    if (err) console.error('Error closing database:', err);
    process.exit(0);
  });
});
