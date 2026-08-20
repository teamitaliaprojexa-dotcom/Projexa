import express from 'express';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';

const router = express.Router();

// Get all users (admin only). name/created_at da Projexa, email da Projexa-Auth (stessi id).
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, created_at FROM users LIMIT 100');
    const ids = result.rows.map(r => r.id);
    const emailById = {};
    if (ids.length) {
      const er = await authDb.query('SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [ids]);
      er.rows.forEach(x => { emailById[x.id] = x.email; });
    }
    res.json(result.rows.map(r => ({ ...r, email: emailById[r.id] || null })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user by ID. name/created_at da Projexa, email da Projexa-Auth.
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const er = await authDb.query('SELECT email FROM users WHERE id = $1', [req.params.id]);
    const email = er.rows[0] ? er.rows[0].email : null;
    res.json({ ...result.rows[0], email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
