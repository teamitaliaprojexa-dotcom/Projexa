import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import db from './config/database.js';
import authRoutes from './routes/auth.js';
import tableStructuresRoutes from './routes/table-structures.js';

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
app.use('/api/table-structures', tableStructuresRoutes);

// Dynamic Generic Table Routes - reads from table_structures
app.get('/api/data/:table', async (req, res) => {
  try {
    const tableName = req.params.table;

    // Allow direct access to table_structures (system table)
    if (tableName !== 'table_structures') {
      // Validate table exists in table_structures for other tables
      const tableCheck = await db.query(
        'SELECT * FROM table_structures WHERE table_name = $1 AND is_active = true',
        [tableName]
      );

      if (tableCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Table not found' });
      }
    }

    const result = await db.query(`SELECT * FROM ${tableName} LIMIT 100`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Create record
app.post('/api/data/:table', async (req, res) => {
  try {
    const tableName = req.params.table;
    let data = req.body;

    // Allow direct access to table_structures (system table)
    if (tableName !== 'table_structures') {
      // Validate table exists in table_structures for other tables
      const tableCheck = await db.query(
        'SELECT * FROM table_structures WHERE table_name = $1 AND is_active = true',
        [tableName]
      );

      if (tableCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Table not found' });
      }
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await db.query(query, values);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT - Update record
app.put('/api/data/:table/:id', async (req, res) => {
  try {
    const tableName = req.params.table;
    const id = req.params.id;
    let data = req.body;

    // Allow direct access to table_structures (system table)
    if (tableName !== 'table_structures') {
      // Validate table exists in table_structures for other tables
      const tableCheck = await db.query(
        'SELECT * FROM table_structures WHERE table_name = $1 AND is_active = true',
        [tableName]
      );

      if (tableCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Table not found' });
      }
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    const columns = Object.keys(data);
    const updates = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');
    const values = [...Object.values(data), id];

    const query = `UPDATE ${tableName} SET ${updates}, updated_at = CURRENT_TIMESTAMP WHERE id = $${columns.length + 1} RETURNING *`;
    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE - Delete record
app.delete('/api/data/:table/:id', async (req, res) => {
  try {
    const tableName = req.params.table;
    const id = req.params.id;

    // Allow direct access to table_structures (system table)
    if (tableName !== 'table_structures') {
      // Validate table exists in table_structures for other tables
      const tableCheck = await db.query(
        'SELECT * FROM table_structures WHERE table_name = $1 AND is_active = true',
        [tableName]
      );

      if (tableCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Table not found' });
      }
    }

    const result = await db.query(`DELETE FROM ${tableName} WHERE id = $1 RETURNING *`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ message: 'Record deleted', data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// SQL EDITOR ENDPOINTS
// ==========================================

// Track active transactions per user
const activeTransactions = new Map();

// Extract JWT payload (simplified - in production use proper middleware)
function getTokenId(req) {
  const token = req.headers.authorization?.split(' ')[1];
  return token || 'anonymous';
}

// Execute SQL Query
app.post('/api/sql/execute', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) {
      return res.status(400).json({ error: 'SQL query required' });
    }

    const tokenId = getTokenId(req);

    // Check if user has an active transaction
    let hasTransaction = activeTransactions.has(tokenId);

    // If no transaction and it's a modification query, start a transaction
    if (!hasTransaction && /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)/i.test(sql)) {
      try {
        await db.query('BEGIN');
        activeTransactions.set(tokenId, true);
        hasTransaction = true;
      } catch (e) {
        console.error('Transaction start error:', e);
      }
    }

    // Execute the query
    const result = await db.query(sql);

    res.json({
      rows: result.rows,
      columns: result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] || {}),
      affectedRows: result.rowCount,
      transactionActive: hasTransaction
    });
  } catch (error) {
    console.error('SQL Error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Commit Transaction
app.post('/api/sql/commit', async (req, res) => {
  try {
    const tokenId = getTokenId(req);

    if (!activeTransactions.has(tokenId)) {
      return res.status(400).json({ error: 'No active transaction' });
    }

    await db.query('COMMIT');
    activeTransactions.delete(tokenId);

    res.json({ message: 'Transaction committed successfully' });
  } catch (error) {
    console.error('Commit Error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Rollback Transaction
app.post('/api/sql/rollback', async (req, res) => {
  try {
    const tokenId = getTokenId(req);

    if (!activeTransactions.has(tokenId)) {
      return res.status(400).json({ error: 'No active transaction' });
    }

    await db.query('ROLLBACK');
    activeTransactions.delete(tokenId);

    res.json({ message: 'Transaction rolled back successfully' });
  } catch (error) {
    console.error('Rollback Error:', error.message);
    res.status(400).json({ error: error.message });
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
