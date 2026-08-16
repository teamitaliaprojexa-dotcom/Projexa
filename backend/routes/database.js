import express from 'express';
import db from '../config/database.js';

const router = express.Router();

// Get database tables list
router.get('/tables', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    res.json({
      tables: result.rows.map(row => row.table_name)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get table data
router.get('/table/:name', async (req, res) => {
  try {
    const tableName = req.params.name;
    const allowedTables = ['users', 'tenants', 'projects', 'tasks', 'risks', 'meetings', 'documents', 'stakeholders', 'activity_logs', 'user_tenants'];

    if (!allowedTables.includes(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const result = await db.query(`SELECT * FROM ${tableName} LIMIT 100`);
    res.json({
      table: tableName,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
