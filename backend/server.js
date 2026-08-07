import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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
    const data = req.body;

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
    const data = req.body;

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
