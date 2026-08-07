import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import db from '../config/database.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { email, password, tenant_code } = req.body;

    console.log(`[LOGIN] Attempting login for email: ${email}`);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find user by email
    const user = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    console.log(`[LOGIN] User query result: ${user.rows.length} rows found`);

    if (user.rows.length === 0) {
      console.log(`[LOGIN] No user found with email: ${email}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const userData = user.rows[0];
    console.log(`[LOGIN] User found: ${userData.email}, ID: ${userData.id}`);

    // Verify password
    console.log(`[LOGIN] Comparing password... Hash length: ${userData.password_hash.length}`);
    const passwordMatch = await bcrypt.compare(password, userData.password_hash);
    console.log(`[LOGIN] Password match result: ${passwordMatch}`);

    if (!passwordMatch) {
      console.log(`[LOGIN] Password mismatch for user: ${email}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Get user's tenants
    const tenants = await db.query(
      'SELECT id, name FROM tenants WHERE id IN (SELECT tenant_id FROM user_tenants WHERE user_id = $1)',
      [userData.id]
    );

    if (tenants.rows.length === 0) {
      return res.status(401).json({ error: 'User has no tenants' });
    }

    // If multiple tenants and no tenant_code provided, return 300 with tenant list
    if (tenants.rows.length > 1 && !tenant_code) {
      return res.status(300).json({
        message: 'Multiple tenants available',
        tenants: tenants.rows
      });
    }

    // Use provided tenant_code or first tenant
    let selectedTenant = tenants.rows[0];
    if (tenant_code) {
      const found = tenants.rows.find(t => t.id === tenant_code);
      if (found) {
        selectedTenant = found;
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        user_id: userData.id,
        email: userData.email,
        tenant_id: selectedTenant.id,
        tenant_name: selectedTenant.name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: userData.id,
        email: userData.email,
        name: userData.name,
        tenant_name: selectedTenant.name
      },
      tenant: selectedTenant
    });
  } catch (error) {
    console.error('❌ LOGIN ERROR:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Verify token endpoint
router.get('/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

export default router;
