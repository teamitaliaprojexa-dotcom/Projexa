import express from 'express';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import licenseDb from '../config/licenseDatabase.js';
import notifDb from '../config/notifDatabase.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Sceglie il DB in base all'header X-Target-DB.
// main=Projexa, auth=Projexa-Auth, lic=Projexa-Lic, notif=Projexa-Notif.
const DB_POOLS = { main: db, auth: authDb, lic: licenseDb, notif: notifDb };
function pickDb(req) { return DB_POOLS[req.get('x-target-db')] || db; }

// Get all table structures
router.get('/', async (req, res) => {
  try {
    const result = await pickDb(req).query(
      'SELECT * FROM table_structures WHERE is_active = true ORDER BY display_name ASC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single table structure
router.get('/:id', async (req, res) => {
  try {
    const result = await pickDb(req).query(
      'SELECT * FROM table_structures WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Table structure not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new table structure
router.post('/', async (req, res) => {
  try {
    const { table_name, display_name, description } = req.body;

    if (!table_name || !display_name) {
      return res.status(400).json({ error: 'table_name and display_name required' });
    }

    const id = uuidv4();
    const result = await pickDb(req).query(
      'INSERT INTO table_structures (id, table_name, display_name, description) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, table_name, display_name, description || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update table structure
router.put('/:id', async (req, res) => {
  try {
    const { display_name, description, is_active } = req.body;

    const result = await pickDb(req).query(
      'UPDATE table_structures SET display_name = COALESCE($1, display_name), description = COALESCE($2, description), is_active = COALESCE($3, is_active), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [display_name || null, description || null, is_active !== undefined ? is_active : null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Table structure not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete table structure (soft delete - set is_active to false)
router.delete('/:id', async (req, res) => {
  try {
    const result = await pickDb(req).query(
      'UPDATE table_structures SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Table structure not found' });
    }

    res.json({ message: 'Table structure deleted', data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
