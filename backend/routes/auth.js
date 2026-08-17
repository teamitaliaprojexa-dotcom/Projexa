import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../config/database.js';
import JWT_SECRET from '../config/jwt.js';

const router = express.Router();

// ==========================================
// Costruisce il nome visualizzato: name + " " + cognome.
// Se il cognome è assente/vuoto restituisce solo il nome (niente spazio finale).
// ==========================================
function buildFullName(user) {
  return [user.name, user.cognome].filter(Boolean).join(' ').trim() || user.name || '';
}

// ==========================================
// Funzione di controllo scadenza licenza
// ==========================================
function checkLicenseExpiry(userData) {
  if (!userData.scadenza) {
    return { valid: true }; // Se non ha scadenza, lascia passare
  }

  const expiryDate = new Date(userData.scadenza);
  const today = new Date();
  
  // Normalizza le date a mezzanotte per confronto corretto
  today.setHours(0, 0, 0, 0);
  expiryDate.setHours(0, 0, 0, 0);

  if (expiryDate >= today) {
    return { valid: true }; // Licenza valida
  } else {
    return { 
      valid: false, 
      expiry: userData.scadenza,
      email: userData.email
    };
  }
}

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

    // Verifica scadenza licenza
    const licenseCheck = checkLicenseExpiry(userData);
    if (!licenseCheck.valid) {
      console.log(`[LOGIN] License expired for user: ${email}`);
      return res.status(403).json({
        error: 'License expired',
        redirect: `/license-expired.html?expiry=${licenseCheck.expiry}&email=${encodeURIComponent(licenseCheck.email)}`
      });
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

    // Use provided tenant_code (which is the tenant id) or first tenant
    let selectedTenant = tenants.rows[0];
    if (tenant_code) {
      const found = tenants.rows.find(t => t.id === tenant_code);
      if (found) {
        selectedTenant = found;
      }
    }

    // Recupera il ruolo dell'utente per il tenant selezionato (usato per i permessi UI)
    const roleRes = await db.query(
      `SELECT ut.role_id, ut.id_roles, r.name AS role_name
       FROM user_tenants ut
       LEFT JOIN roles r ON r.id_roles = ut.id_roles
       WHERE ut.user_id = $1 AND ut.tenant_id = $2 LIMIT 1`,
      [userData.id, selectedTenant.id]
    );
    const userRole = roleRes.rows[0] || {};

    // Generate JWT token
    const token = jwt.sign(
      {
        user_id: userData.id,
        email: userData.email,
        tenant_id: selectedTenant.id,
        tenant_name: selectedTenant.name,
        role_id: userRole.role_id,
        id_roles: userRole.id_roles,
        role_name: userRole.role_name
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
        name: buildFullName(userData),
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

// Google OAuth Callback
router.get('/google-callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.redirect('/sito/?error=missing_code');
    }

    // Scambia il code con l'access token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '128379880931-guh70j47lsvplo9m1intpj9tt7escdn8.apps.googleusercontent.com',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '', // Deve essere in .env
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.BACKEND_URL || 'https://projexa-4mix.onrender.com'}/api/auth/google-callback`
      }).toString()
    });

    if (!tokenResponse.ok) {
      console.error('❌ Google Token Error:', await tokenResponse.text());
      return res.redirect('/sito/?error=token_exchange_failed');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const idToken = tokenData.id_token;

    // Decodifica l'ID token per ottenere le info utente
    const parts = idToken.split('.');
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = JSON.parse(Buffer.from(base64, 'base64').toString());

    const { email, name, picture } = jsonPayload;

    console.log(`[GOOGLE_AUTH] User: ${email}, Name: ${name}`);

    // Crea o aggiorna l'utente nel database
    let user = await db.query('SELECT * FROM users WHERE email = $1', [email]);

    if (user.rows.length === 0) {
      // Crea nuovo utente con hash password casuale (Google non fornisce password)
      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      
      const result = await db.query(
        `INSERT INTO users (email, name, password_hash, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, email, name`,
        [email, name, randomHash]
      );
      user = result;
      
      // Nuovo utente: crea subito un tenant per lui
      const slug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
      console.log(`[GOOGLE_AUTH] Creating new tenant for ${email} with slug: ${slug}`);
      
      const defaultTenant = await db.query(
        `INSERT INTO tenants (name, slug, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id, name`,
        [`${name}'s Workspace`, slug]
      );

      console.log(`[GOOGLE_AUTH] Tenant created:`, defaultTenant.rows[0]);

      // Assegna il ruolo "Project Manager" (id_roles = 70)
      const roleId = 70;

      const userTenantResult = await db.query(
        'INSERT INTO user_tenants (user_id, tenant_id, role_id, id_roles) VALUES ($1, $2, $3, $4)',
        [user.rows[0].id, defaultTenant.rows[0].id, 'Project Manager', roleId]
      );

      console.log(`[GOOGLE_AUTH] User-tenant relationship created for ${email}`);
    } else {
      // Utente esiste già: aggiorna l'ultima data
      await db.query(
        'UPDATE users SET updated_at = NOW() WHERE email = $1',
        [email]
      );
    }

    const userData = user.rows[0];

    // Verifica scadenza licenza
    const licenseCheck = checkLicenseExpiry(userData);
    if (!licenseCheck.valid) {
      console.log(`[GOOGLE_AUTH] License expired for user: ${userData.email}`);
      return res.redirect(`/license-expired.html?expiry=${licenseCheck.expiry}&email=${encodeURIComponent(licenseCheck.email)}`);
    }

    console.log(`[GOOGLE_AUTH] userData after check:`, userData);
    console.log(`[GOOGLE_AUTH] scadenza value:`, userData.scadenza);
    console.log(`[GOOGLE_AUTH] licenseCheck:`, licenseCheck);

    // Ottieni il tenant dell'utente (deve esistere sempre)
    let tenants = await db.query(
      'SELECT id, name FROM tenants WHERE id IN (SELECT tenant_id FROM user_tenants WHERE user_id = $1)',
      [userData.id]
    );

    console.log(`[GOOGLE_AUTH] Found tenants:`, tenants.rows.length);

    // Fallback: se per qualche motivo non ha tenant (non dovrebbe succedere), crea uno
    if (tenants.rows.length === 0) {
      console.warn(`[GOOGLE_AUTH] User ${email} has no tenant, creating one...`);
      const slug = `${email.split('@')[0]}-backup`.toLowerCase().replace(/[^a-z0-9]/g, '-');
      
      const defaultTenant = await db.query(
        `INSERT INTO tenants (name, slug, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id, name`,
        [`${name}'s Workspace Backup`, slug]
      );

      // Assegna il ruolo "Project Manager" (id_roles = 70)
      const roleId = 70;

      await db.query(
        'INSERT INTO user_tenants (user_id, tenant_id, role_id, id_roles) VALUES ($1, $2, $3, $4)',
        [userData.id, defaultTenant.rows[0].id, 'Project Manager', roleId]
      );

      tenants = defaultTenant;
    }

    const selectedTenant = tenants.rows[0];

    // Recupera il ruolo dell'utente per il tenant selezionato (usato per i permessi UI)
    const roleRes = await db.query(
      `SELECT ut.role_id, ut.id_roles, r.name AS role_name
       FROM user_tenants ut
       LEFT JOIN roles r ON r.id_roles = ut.id_roles
       WHERE ut.user_id = $1 AND ut.tenant_id = $2 LIMIT 1`,
      [userData.id, selectedTenant.id]
    );
    const userRole = roleRes.rows[0] || {};

    // Genera JWT token
    const jwtToken = jwt.sign(
      {
        user_id: userData.id,
        email: userData.email,
        tenant_id: selectedTenant.id,
        tenant_name: selectedTenant.name,
        role_id: userRole.role_id,
        id_roles: userRole.id_roles,
        role_name: userRole.role_name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Reindirizza al dashboard con i parametri
    const params = new URLSearchParams({
      provider: 'google',
      name: buildFullName(userData),
      email: email,
      picture: picture || '',
      access_token: accessToken,
      jwt_token: jwtToken,
      success: 'true'
    });

    res.redirect(`/dashboard.html?${params.toString()}`);

  } catch (error) {
    console.error('❌ GOOGLE_CALLBACK ERROR:', error.message);
    res.redirect(`/?error=${encodeURIComponent(error.message)}`);
  }
});

export default router;
