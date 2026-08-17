import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../config/database.js';
import JWT_SECRET from '../config/jwt.js';

const router = express.Router();

// === CREDENZIALI MICROSOFT ===
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID;
const BACKEND_URL = process.env.BACKEND_URL || 'https://projexa-4mix.onrender.com';

// Costruisce il nome visualizzato: name + " " + cognome (copiata da auth.js).
// Cognome assente/vuoto => solo il nome, senza spazio finale.
function buildFullName(user) {
  return [user.name, user.cognome].filter(Boolean).join(' ').trim() || user.name || '';
}

// Funzione di controllo scadenza licenza (copiata da auth.js)
function checkLicenseExpiry(userData) {
  if (!userData.scadenza) {
    return { valid: true };
  }

  const expiryDate = new Date(userData.scadenza);
  const today = new Date();
  
  today.setHours(0, 0, 0, 0);
  expiryDate.setHours(0, 0, 0, 0);

  if (expiryDate >= today) {
    return { valid: true };
  } else {
    return { 
      valid: false, 
      expiry: userData.scadenza,
      email: userData.email
    };
  }
}

// === MICROSOFT OAUTH CALLBACK ===
router.get('/microsoft-callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    console.log('[MICROSOFT_AUTH] Callback received');

    // Verifica errore da Microsoft
    if (error) {
      console.error(`[MICROSOFT_AUTH] Error from Microsoft: ${error} - ${error_description}`);
      return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
    }

    // Verifica che abbiamo il code
    if (!code) {
      console.error('[MICROSOFT_AUTH] No authorization code received');
      return res.redirect('/?error=missing_code');
    }

    console.log('[MICROSOFT_AUTH] Exchanging code for access_token...');

    // === STEP 1: Scambia il code per access_token ===
    const tokenUrl = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
    const redirectUri = `${BACKEND_URL}/api/auth/microsoft-callback`;

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      }).toString()
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`[MICROSOFT_AUTH] Token exchange failed: ${tokenResponse.status}`, errorText);
      return res.redirect(`/?error=token_exchange_failed`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('[MICROSOFT_AUTH] No access_token in response');
      return res.redirect('/?error=no_access_token');
    }

    console.log('[MICROSOFT_AUTH] ✓ Access token received');

    // === STEP 2: Ottieni le info utente da Microsoft Graph ===
    const userResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!userResponse.ok) {
      console.error(`[MICROSOFT_AUTH] Failed to fetch user info: ${userResponse.status}`);
      return res.redirect('/?error=user_info_failed');
    }

    const userData = await userResponse.json();
    const { mail, displayName, id: microsoftId } = userData;
    const email = mail || userData.userPrincipalName;

    console.log(`[MICROSOFT_AUTH] User: ${email}, Name: ${displayName}`);

    // === STEP 3: Crea o aggiorna l'utente nel database ===
    let user = await db.query('SELECT * FROM users WHERE email = $1', [email]);

    if (user.rows.length === 0) {
      // Crea nuovo utente
      console.log(`[MICROSOFT_AUTH] Creating new user: ${email}`);
      
      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      
      const result = await db.query(
        `INSERT INTO users (email, name, password_hash, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, email, name`,
        [email, displayName, randomHash]
      );
      user = result;
      
      // Crea un tenant per il nuovo utente
      const slug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
      console.log(`[MICROSOFT_AUTH] Creating new tenant for ${email} with slug: ${slug}`);
      
      const defaultTenant = await db.query(
        `INSERT INTO tenants (name, slug, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id, name`,
        [`${displayName}'s Workspace`, slug]
      );

      console.log(`[MICROSOFT_AUTH] Tenant created:`, defaultTenant.rows[0]);

      // Assegna il ruolo "Project Manager" (id_roles = 70)
      await db.query(
        'INSERT INTO user_tenants (user_id, tenant_id, role_id, id_roles) VALUES ($1, $2, $3, $4)',
        [user.rows[0].id, defaultTenant.rows[0].id, 'Project Manager', 70]
      );

      console.log(`[MICROSOFT_AUTH] User-tenant relationship created for ${email}`);
    } else {
      // Aggiorna utente esistente
      console.log(`[MICROSOFT_AUTH] User already exists: ${email}`);
      await db.query(
        'UPDATE users SET updated_at = NOW() WHERE email = $1',
        [email]
      );
    }

    const userDbData = user.rows[0];

    // === STEP 4: Verifica scadenza licenza ===
    const licenseCheck = checkLicenseExpiry(userDbData);
    if (!licenseCheck.valid) {
      console.log(`[MICROSOFT_AUTH] License expired for user: ${email}`);
      return res.redirect(`/license-expired.html?expiry=${licenseCheck.expiry}&email=${encodeURIComponent(email)}`);
    }

    // === STEP 5: Ottieni i tenant dell'utente ===
    let tenants = await db.query(
      'SELECT id, name FROM tenants WHERE id IN (SELECT tenant_id FROM user_tenants WHERE user_id = $1)',
      [userDbData.id]
    );

    // Fallback: se non ha tenant, crea uno
    if (tenants.rows.length === 0) {
      console.warn(`[MICROSOFT_AUTH] User ${email} has no tenant, creating one...`);
      const slug = `${email.split('@')[0]}-backup`.toLowerCase().replace(/[^a-z0-9]/g, '-');
      
      const defaultTenant = await db.query(
        `INSERT INTO tenants (name, slug, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id, name`,
        [`${displayName}'s Workspace Backup`, slug]
      );

      await db.query(
        'INSERT INTO user_tenants (user_id, tenant_id, role_id, id_roles) VALUES ($1, $2, $3, $4)',
        [userDbData.id, defaultTenant.rows[0].id, 'Project Manager', 70]
      );

      tenants = defaultTenant;
    }

    const selectedTenant = tenants.rows[0];

    // === STEP 6: Genera JWT token ===
    const jwtToken = jwt.sign(
      {
        user_id: userDbData.id,
        email: email,
        tenant_id: selectedTenant.id,
        tenant_name: selectedTenant.name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // === STEP 7: Reindirizza al dashboard con i parametri ===
    const params = new URLSearchParams({
      provider: 'microsoft',
      name: buildFullName(userDbData),
      email: email,
      microsoft_access_token: accessToken,
      jwt_token: jwtToken,
      success: 'true'
    });

    console.log(`[MICROSOFT_AUTH] ✓ Authentication successful for ${email}, redirecting to dashboard`);
    res.redirect(`/dashboard.html?${params.toString()}`);

  } catch (error) {
    console.error('❌ MICROSOFT_CALLBACK ERROR:', error.message);
    console.error('Stack:', error.stack);
    res.redirect(`/?error=${encodeURIComponent(error.message)}`);
  }
});

// === HEALTH CHECK ENDPOINT (per debugging) ===
router.get('/microsoft-check', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Microsoft OAuth endpoint is ready',
    clientId: MICROSOFT_CLIENT_ID ? MICROSOFT_CLIENT_ID.slice(0, 8) + '...' : 'NON CONFIGURATO',
    tenantId: MICROSOFT_TENANT_ID ? MICROSOFT_TENANT_ID.slice(0, 8) + '...' : 'NON CONFIGURATO',
    redirectUri: `${BACKEND_URL}/api/auth/microsoft-callback`
  });
});

export default router;