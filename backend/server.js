import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './config/database.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import projectRoutes from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import riskRoutes from './routes/risks.js';
import databaseRoutes from './routes/database.js';
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
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/risks', riskRoutes);
app.use('/api/database', databaseRoutes);
app.use('/api/table-structures', tableStructuresRoutes);

// Generic table route
app.get('/api/:table', async (req, res) => {
  try {
    const table = req.params.table;
    const allowedTables = ['projects', 'tasks', 'risks', 'meetings', 'documents', 'stakeholders', 'activity_logs'];

    if (!allowedTables.includes(table)) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const result = await db.query(`SELECT * FROM ${table} LIMIT 100`);
    res.json(result.rows);
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
