import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import JWT_SECRET from '../config/jwt.js';
import { sendMail, buildConfirmEmail, isMailerConfigured } from '../config/mailer.js';
import { requireAuth } from '../middleware/auth.js';

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

    // FASE 1 (Projexa-Auth): trova l'utente per email, verifica password e scadenza licenza.
    const authRes = await authDb.query(
      'SELECT id, email, password_hash, scadenza FROM users WHERE email = $1',
      [email]
    );
    console.log(`[LOGIN] Auth query result: ${authRes.rows.length} rows found`);
    if (authRes.rows.length === 0) {
      // Email non censita: il frontend reindirizza alla pagina "Prova gratuita".
      console.log(`[LOGIN] No user found with email: ${email}`);
      return res.status(404).json({ error: 'not_registered' });
    }
    const authUser = authRes.rows[0];

    const passwordMatch = await bcrypt.compare(password, authUser.password_hash);
    console.log(`[LOGIN] Password match result: ${passwordMatch}`);
    if (!passwordMatch) {
      console.log(`[LOGIN] Password mismatch for user: ${email}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verifica scadenza licenza (scadenza è su Projexa-Auth)
    const licenseCheck = checkLicenseExpiry(authUser);
    if (!licenseCheck.valid) {
      console.log(`[LOGIN] License expired for user: ${email}`);
      return res.status(403).json({
        error: 'License expired',
        redirect: `/license-expired.html?expiry=${licenseCheck.expiry}&email=${encodeURIComponent(licenseCheck.email)}`
      });
    }

    // FASE 2 (Projexa): recupera nome/cognome per la visualizzazione (stesso id).
    const nameRes = await db.query('SELECT name, cognome FROM users WHERE id = $1', [authUser.id]);
    const nameRow = nameRes.rows[0] || {};
    const userData = { id: authUser.id, email: authUser.email, name: nameRow.name, cognome: nameRow.cognome };
    console.log(`[LOGIN] User authenticated: ${userData.email}, ID: ${userData.id}`);

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

// Registrazione "Prova gratuita 1 mese". Crea l'utente su Projexa-Auth (password in hash,
// scadenza a +1 mese) e lo stub + tenant + ruolo su Projexa (stesso id).
// method = 'password' (richiede password+conferma) | 'google' | 'microsoft' (password casuale).
router.post('/register', async (req, res) => {
  try {
    const b = req.body || {};
    const email = (b.email || '').trim().toLowerCase();
    const tenantName = (b.tenantName || '').trim();
    const nome = (b.nome || '').trim();
    const cognome = (b.cognome || '').trim();
    const method = (b.method || 'password');

    if (!email || !nome || !cognome || !tenantName) {
      return res.status(400).json({ error: 'Compila tutti i campi obbligatori (email, nome, cognome, workspace).' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email non valida.' });
    }

    // Password: obbligatoria solo se non si sceglie Google/Microsoft.
    let passwordHash;
    if (method === 'google' || method === 'microsoft') {
      passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10); // non usabile per login a password
    } else {
      const password = b.password || '';
      const confirm = b.confirmPassword || '';
      if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri.' });
      if (password !== confirm) return res.status(400).json({ error: 'Le password non coincidono.' });
      passwordHash = await bcrypt.hash(password, 10);
    }

    // Email già registrata?
    const exists = await authDb.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Email già registrata. Effettua l\'accesso.' });
    }

    // 1) Crea su Projexa-Auth con scadenza = IERI (data - 1 giorno): così l'utente NON può
    //    accedere finché non conferma l'iscrizione via email (poi scadenza -> +1 mese).
    const ins = await authDb.query(
      `INSERT INTO users (email, password_hash, scadenza, created_at)
       VALUES ($1, $2, CURRENT_DATE - INTERVAL '1 day', NOW())
       RETURNING id`,
      [email, passwordHash]
    );
    const userId = ins.rows[0].id;

    // 2) Crea stub + tenant + associazione su Projexa (stesso id), in transazione.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users (id, name, cognome) VALUES ($1, $2, $3)', [userId, nome, cognome]);
      const slug = (email.split('@')[0] + '-' + Date.now().toString(36)).toLowerCase().replace(/[^a-z0-9]/g, '-');
      const t = await client.query(
        'INSERT INTO tenants (name, slug, created_at) VALUES ($1, $2, NOW()) RETURNING id',
        [tenantName, slug]
      );
      await client.query(
        'INSERT INTO user_tenants (user_id, tenant_id, role_id, id_roles) VALUES ($1, $2, $3, $4)',
        [userId, t.rows[0].id, 'Project Manager', 70]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      await authDb.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {}); // compensazione
      if (e.code === '23505') { // violazione unicità (es. nome workspace già usato)
        return res.status(409).json({ error: 'Nome workspace già in uso: scegline un altro.' });
      }
      throw e;
    } finally {
      client.release();
    }

    console.log(`[REGISTER] Nuovo utente prova gratuita: ${email} (method=${method})`);

    // Invia l'email di conferma iscrizione (double opt-in). Token firmato (JWT) valido 30 giorni.
    const confirmToken = jwt.sign({ uid: userId, purpose: 'signup-confirm' }, JWT_SECRET, { expiresIn: '30d' });
    const base = process.env.APP_URL || process.env.BACKEND_URL || 'https://projexa-4mix.onrender.com';
    const confirmUrl = `${base}/prova-gratuita.html?token=${encodeURIComponent(confirmToken)}`;
    console.log(`[REGISTER] Link di conferma per ${email}: ${confirmUrl}`); // utile per i test in locale

    let emailSent = false;
    try {
      if (isMailerConfigured()) {
        const { html, text } = buildConfirmEmail({ nome, confirmUrl });
        await sendMail({ to: email, subject: 'Conferma la tua iscrizione a Projexa', html, text });
        emailSent = true;
      }
    } catch (mailErr) {
      console.error('❌ REGISTER MAIL ERROR:', mailErr.message);
    }

    res.status(201).json({ success: true, method, email, emailSent });
  } catch (error) {
    console.error('❌ REGISTER ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante la registrazione', details: error.message });
  }
});

// Info per la pagina di conferma iscrizione (mostra i dati in sola lettura).
router.get('/confirm-info', async (req, res) => {
  const token = (req.query.token || '').trim();
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.purpose !== 'signup-confirm') return res.status(400).json({ error: 'Token non valido' });
    const a = await authDb.query('SELECT email, scadenza FROM users WHERE id = $1', [d.uid]);
    if (a.rows.length === 0) return res.status(404).json({ error: 'Utente non trovato' });
    const p = await db.query('SELECT name, cognome FROM users WHERE id = $1', [d.uid]);
    const t = await db.query(
      `SELECT t.name FROM tenants t JOIN user_tenants ut ON ut.tenant_id = t.id WHERE ut.user_id = $1 LIMIT 1`,
      [d.uid]
    );
    // scadenza >= oggi => già confermato/attivo
    const alreadyConfirmed = new Date(a.rows[0].scadenza) >= new Date(new Date().toISOString().slice(0, 10));
    res.json({
      email: a.rows[0].email,
      nome: (p.rows[0] && p.rows[0].name) || '',
      cognome: (p.rows[0] && p.rows[0].cognome) || '',
      tenantName: (t.rows[0] && t.rows[0].name) || '',
      alreadyConfirmed
    });
  } catch (e) {
    return res.status(400).json({ error: 'Link non valido o scaduto' });
  }
});

// Conferma iscrizione: imposta scadenza a +1 mese (solo se non già confermata).
router.post('/confirm', async (req, res) => {
  const token = ((req.body && req.body.token) || req.query.token || '').trim();
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.purpose !== 'signup-confirm') return res.status(400).json({ error: 'Token non valido' });
    const r = await authDb.query(
      `UPDATE users SET scadenza = CURRENT_DATE + INTERVAL '1 month', updated_at = NOW()
       WHERE id = $1 AND scadenza < CURRENT_DATE RETURNING id`,
      [d.uid]
    );
    if (r.rowCount === 0) {
      return res.json({ success: true, alreadyConfirmed: true, message: 'Iscrizione già confermata.' });
    }
    console.log(`[CONFIRM] Iscrizione confermata per utente ${d.uid}`);
    res.json({ success: true, message: 'Iscrizione confermata! Prova gratuita di 1 mese attivata.' });
  } catch (e) {
    return res.status(400).json({ error: 'Link non valido o scaduto' });
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

    const { email, name, picture, email_verified } = jsonPayload;

    console.log(`[GOOGLE_AUTH] User: ${email}, Name: ${name}, verified: ${email_verified}`);

    // Hardening: accetta solo email verificate da Google. Evita che qualcuno acceda a un
    // account esistente tramite un'email non confermata.
    if (!(email_verified === true || email_verified === 'true')) {
      console.warn(`[GOOGLE_AUTH] Email non verificata, accesso negato: ${email}`);
      return res.redirect('/?error=email_non_verificata');
    }

    // Cerca l'utente su Projexa-Auth.
    let authUser = (await authDb.query('SELECT id, email, scadenza FROM users WHERE email = $1', [email])).rows[0];
    if (!authUser) {
      // Nuovo utente: instradalo alla pagina "Prova gratuita" (niente auto-creazione qui,
      // così sceglie nome workspace/nome/cognome ed evitiamo collisioni sul nome tenant).
      const p = new URLSearchParams({ email, name: name || '', method: 'google' });
      return res.redirect(`/prova-gratuita.html?${p.toString()}`);
    }
    await authDb.query('UPDATE users SET updated_at = NOW() WHERE id = $1', [authUser.id]);

    // Nome/cognome per la visualizzazione dallo stub Projexa (stesso id)
    const nameRes = await db.query('SELECT name, cognome FROM users WHERE id = $1', [authUser.id]);
    const nameRow = nameRes.rows[0] || {};
    const userData = { id: authUser.id, email: authUser.email, scadenza: authUser.scadenza, name: nameRow.name, cognome: nameRow.cognome };

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

// ==========================================
// IMPERSONIFICAZIONE (solo admin id_roles = 1)
// ==========================================

function requireAdmin(req, res, next) {
  if (Number(req.user?.id_roles) !== 1) {
    return res.status(403).json({ error: 'Operazione riservata agli amministratori' });
  }
  next();
}

// Elenco tenant selezionabili
router.get('/impersonate/tenants', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT id, name FROM tenants ORDER BY name');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Elenco utenti di un dato tenant
router.get('/impersonate/users', requireAuth, requireAdmin, async (req, res) => {
  const tenantId = req.query.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'tenant_id richiesto' });
  try {
    const r = await db.query(
      `SELECT DISTINCT u.id, u.name, u.cognome, ut.id_roles, rol.name AS role_name
       FROM users u
       JOIN user_tenants ut ON ut.user_id = u.id
       LEFT JOIN roles rol ON rol.id_roles = ut.id_roles
       WHERE ut.tenant_id = $1
       ORDER BY u.name`,
      [tenantId]
    );
    // email da Projexa-Auth (stessi id)
    const ids = r.rows.map(x => x.id);
    const emailById = {};
    if (ids.length) {
      const er = await authDb.query('SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [ids]);
      er.rows.forEach(x => { emailById[x.id] = x.email; });
    }
    res.json(r.rows.map(x => ({ ...x, email: emailById[x.id] || null })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Genera un token impersonando l'utente scelto nel tenant scelto
router.post('/impersonate', requireAuth, requireAdmin, async (req, res) => {
  const { tenant_id, user_id } = req.body || {};
  if (!tenant_id || !user_id) {
    return res.status(400).json({ error: 'tenant_id e user_id richiesti' });
  }
  try {
    const q = await db.query(
      `SELECT ut.role_id, ut.id_roles, r.name AS role_name,
              u.name, u.cognome, t.name AS tenant_name
       FROM user_tenants ut
       JOIN users u ON u.id = ut.user_id
       JOIN tenants t ON t.id = ut.tenant_id
       LEFT JOIN roles r ON r.id_roles = ut.id_roles
       WHERE ut.user_id = $1 AND ut.tenant_id = $2 LIMIT 1`,
      [user_id, tenant_id]
    );
    if (q.rows.length === 0) {
      return res.status(404).json({ error: 'Utente non trovato in quel tenant' });
    }
    const row = q.rows[0];
    // email da Projexa-Auth (stesso id)
    const emailRes = await authDb.query('SELECT email FROM users WHERE id = $1', [user_id]);
    const email = emailRes.rows[0] ? emailRes.rows[0].email : null;
    const token = jwt.sign(
      {
        user_id,
        email,
        tenant_id,
        tenant_name: row.tenant_name,
        role_id: row.role_id,
        id_roles: row.id_roles,
        role_name: row.role_name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({
      token,
      user: {
        id: user_id,
        email,
        name: buildFullName(row),
        tenant_name: row.tenant_name
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
