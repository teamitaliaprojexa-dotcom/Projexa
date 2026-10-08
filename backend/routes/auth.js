import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import JWT_SECRET from '../config/jwt.js';
import { sendMail, buildConfirmEmail, buildResetPasswordEmail, buildMagicLinkEmail, buildAccountEsistenteEmail, isMailerConfigured } from '../config/mailer.js';
import { requireAuth } from '../middleware/auth.js';
import { signSessionToken, verifySessionToken, forgetSessionSignature, passwordSignature,
  issueSession, readSessionCookie, clearSessionCookie, revokeSessionToken } from '../config/session.js';
import { readCookie, setCookie, clearCookie } from '../config/cookies.js';
import { startOAuthLogin, checkOAuthState, deliverLoginToken, takeLoginToken } from '../config/oauthLogin.js';
import { seedSettingsFromTemplate } from '../config/settingsSeed.js';
import { registraAccesso } from '../config/audit.js';

// Link con token (conferma iscrizione, reset password) nel log solo in locale: in
// produzione chi legge i log potrebbe usarli per prendere il controllo degli account.
const LOG_LINKS = process.env.NODE_ENV !== 'production';

const router = express.Router();

// ==========================================
// Nessuna risposta rivela se un'email è registrata
// ==========================================
// Login, magic link, password dimenticata e registrazione rispondono allo stesso modo
// per email registrate e non registrate, e nello stesso tempo: il lavoro che dipende
// dall'esistenza dell'account (ricerca del nome, invio dell'email) parte DOPO la risposta.
// Così nessuno può usare le pagine pubbliche per scoprire chi usa Projexa.
const LOGIN_ERROR = 'Email o password non corretti.';
// Hash di una password casuale: con un'email sconosciuta il login esegue comunque un
// confronto bcrypt, così la risposta arriva nello stesso tempo di una password sbagliata.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

// Esegue fn dopo aver già risposto al browser; gli errori finiscono solo nel log.
function inBackground(label, fn) {
  setImmediate(() => {
    Promise.resolve().then(fn).catch((e) => console.error(`❌ ${label}:`, e.message));
  });
}

const appBaseUrl = () => process.env.APP_URL || process.env.BACKEND_URL || 'https://www.projexa.it';

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

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email e password obbligatorie.' });
    }

    // FASE 1 (Projexa-Auth): trova l'utente per email, verifica password e scadenza licenza.
    const authRes = await authDb.query(
      'SELECT id, email, password_hash, scadenza FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email.trim()]
    );
    const authUser = authRes.rows[0];

    // Email sconosciuta e password errata: stessa risposta, stesso tempo (confronto bcrypt
    // eseguito comunque). Il motivo vero resta solo nel log accessi.
    const passwordMatch = await bcrypt.compare(password, authUser ? authUser.password_hash : DUMMY_PASSWORD_HASH);
    if (!authUser || !passwordMatch) {
      registraAccesso(req, {
        evento: 'login', esito: 'ko', userId: authUser ? authUser.id : undefined, email,
        dettaglio: authUser ? 'password errata' : 'email non registrata'
      });
      return res.status(401).json({ error: LOGIN_ERROR });
    }

    // Verifica scadenza licenza (scadenza è su Projexa-Auth)
    const licenseCheck = checkLicenseExpiry(authUser);
    if (!licenseCheck.valid) {
      console.log(`[LOGIN] License expired for user: ${email}`);
      registraAccesso(req, { evento: 'login', esito: 'ko', userId: authUser.id, email, dettaglio: 'licenza scaduta' });
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

    // Token di sessione (tipo "session", legato alla password attuale)
    const token = signSessionToken(
      {
        user_id: userData.id,
        email: userData.email,
        tenant_id: selectedTenant.id,
        tenant_name: selectedTenant.name,
        role_id: userRole.role_id,
        id_roles: userRole.id_roles,
        role_name: userRole.role_name
      },
      authUser.password_hash
    );
    registraAccesso(req, { evento: 'login', userId: userData.id, email: userData.email, tenantId: selectedTenant.id });

    res.json({
      success: true,
      token: issueSession(req, res, token),
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
    res.status(500).json({ error: 'Errore durante l\'accesso: riprova tra poco.' });
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

    // Email già registrata: risposta identica a un'iscrizione nuova (non si rivela che
    // l'account esiste). Al titolare arriva un'email con l'accesso e il link per
    // reimpostare la password; non si crea nulla e non si modifica nulla.
    const exists = await authDb.query('SELECT id, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
    if (exists.rows.length) {
      const esistente = exists.rows[0];
      console.log(`[REGISTER] Iscrizione richiesta per un'email già registrata (utente ${esistente.id})`);
      if (isMailerConfigured()) {
        inBackground('REGISTER MAIL (account esistente)', async () => {
          const p = await db.query('SELECT name FROM users WHERE id = $1', [esistente.id]);
          const token = jwt.sign(
            { uid: esistente.id, purpose: 'password-reset', sig: passwordHashSignature(esistente.password_hash) },
            JWT_SECRET,
            { expiresIn: `${RESET_TOKEN_HOURS}h` }
          );
          const { html, text } = buildAccountEsistenteEmail({
            nome: (p.rows[0] && p.rows[0].name) || '',
            loginUrl: `${appBaseUrl()}/login.html`,
            resetUrl: `${appBaseUrl()}/reset-password.html?token=${encodeURIComponent(token)}`,
            validHours: RESET_TOKEN_HOURS
          });
          await sendMail({ to: email, subject: 'Hai già un account Projexa', html, text,
            log: { req, tipo: 'account_esistente', userId: esistente.id } });
        });
      }
      return res.status(201).json({ success: true, method, email, emailSent: isMailerConfigured() });
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
      // Tenant nuovo: impostazioni copiate dall'utente modello del tenant PROJEXA.
      await seedSettingsFromTemplate(client, t.rows[0].id, userId);
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
    const confirmUrl = `${appBaseUrl()}/prova-gratuita.html?token=${encodeURIComponent(confirmToken)}`;
    if (LOG_LINKS) console.log(`[REGISTER] Link di conferma per ${email}: ${confirmUrl}`); // solo in locale, per i test

    // Invio dopo la risposta, come per l'email già registrata (stessi tempi di risposta).
    if (isMailerConfigured()) {
      inBackground('REGISTER MAIL ERROR', async () => {
        const { html, text } = buildConfirmEmail({ nome, confirmUrl });
        await sendMail({ to: email, subject: 'Conferma la tua iscrizione a Projexa', html, text,
          log: { req, tipo: 'conferma_iscrizione', userId } });
      });
    }

    res.status(201).json({ success: true, method, email, emailSent: isMailerConfigured() });
  } catch (error) {
    console.error('❌ REGISTER ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante la registrazione: riprova tra poco.' });
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

// ==========================================
// Modifica password (campo settings con tipo_valore = 40)
// ==========================================

// Rate-limit anti brute-force sulla password attuale: max 5 tentativi errati
// per utente ogni 15 minuti. Il contatore si azzera al cambio riuscito.
const changePwdAttempts = new Map(); // user_id -> { count, first }
function tooManyPwdAttempts(userId) {
  const rec = changePwdAttempts.get(userId);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { changePwdAttempts.delete(userId); return false; }
  return rec.count >= 5;
}
function registerPwdFailure(userId) {
  const rec = changePwdAttempts.get(userId);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) changePwdAttempts.set(userId, { count: 1, first: Date.now() });
  else rec.count += 1;
}

// Cambia la password dell'utente autenticato: verifica quella attuale e salva la nuova
// come hash bcrypt su Projexa-Auth (users.password_hash). L'utente è sempre quello del
// token: non è possibile cambiare la password di altri da questo endpoint.
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Autenticazione richiesta' });

    const b = req.body || {};
    const currentPassword = b.currentPassword || '';
    const newPassword = b.newPassword || '';
    const confirmPassword = b.confirmPassword != null ? b.confirmPassword : newPassword;

    if (!currentPassword) return res.status(400).json({ error: 'Password attuale richiesta.' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Le password non coincidono.' });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'La nuova password deve essere diversa da quella attuale.' });

    if (tooManyPwdAttempts(userId)) {
      return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
    }

    const r = await authDb.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Utente non trovato.' });

    const match = await bcrypt.compare(currentPassword, r.rows[0].password_hash || '');
    if (!match) {
      registerPwdFailure(userId);
      console.warn(`[CHANGE-PASSWORD] Password attuale errata per utente ${userId}`);
      registraAccesso(req, { evento: 'cambio_password', esito: 'ko', userId, email: req.user.email, tenantId: req.user.tenant_id, dettaglio: 'password attuale errata' });
      return res.status(401).json({ error: 'Password attuale non corretta.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await authDb.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );
    changePwdAttempts.delete(userId);
    // Le sessioni aperte con la vecchia password decadono; questa riceve un token nuovo.
    forgetSessionSignature(userId);
    console.log(`[CHANGE-PASSWORD] Password aggiornata per utente ${userId}`);
    registraAccesso(req, { evento: 'cambio_password', userId, email: req.user.email, tenantId: req.user.tenant_id });

    res.json({ success: true, token: issueSession(req, res, signSessionToken(req.user, newHash)) });
  } catch (error) {
    console.error('❌ CHANGE-PASSWORD ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante il cambio password' });
  }
});

// ==========================================
// Password dimenticata / reimpostazione via email
// ==========================================

// Il token del link email è un JWT a scadenza breve che contiene anche una "firma"
// dell'hash attuale: quando la password cambia, la firma non torna più e il link
// diventa inutilizzabile (uso singolo, senza colonne aggiuntive sul DB).
const RESET_TOKEN_HOURS = 1;
const passwordHashSignature = passwordSignature; // stessa firma dei token di sessione

// Verifica il token del link: restituisce { uid, email, nome } o lancia un errore.
async function verifyResetToken(token) {
  const d = jwt.verify(token, JWT_SECRET); // lancia se scaduto/alterato
  if (d.purpose !== 'password-reset') throw new Error('purpose');
  const r = await authDb.query('SELECT id, email, password_hash FROM users WHERE id = $1', [d.uid]);
  if (r.rows.length === 0) throw new Error('not-found');
  if (passwordHashSignature(r.rows[0].password_hash) !== d.sig) throw new Error('used'); // password già cambiata
  const p = await db.query('SELECT name, cognome FROM users WHERE id = $1', [d.uid]);
  return { uid: d.uid, email: r.rows[0].email, nome: (p.rows[0] && p.rows[0].name) || '' };
}

// Rate-limit anti abuso sull'invio del link: max 5 richieste per IP ogni 60 minuti.
const forgotAttempts = new Map(); // ip -> { count, first }
function forgotRateLimited(ip) {
  const now = Date.now(), windowMs = 60 * 60 * 1000, max = 5;
  const rec = forgotAttempts.get(ip);
  if (!rec || now - rec.first > windowMs) { forgotAttempts.set(ip, { count: 1, first: now }); return false; }
  rec.count += 1;
  return rec.count > max;
}

// Richiesta "Password dimenticata": invia all'indirizzo indicato un'email con il link
// di reimpostazione. La risposta è sempre la stessa, anche se l'email non esiste,
// per non rivelare quali indirizzi sono registrati.
router.post('/forgot-password', async (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  try {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email non valida.' });
    }
    if (forgotRateLimited(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
    }

    if (!isMailerConfigured()) {
      return res.status(503).json({ error: 'Invio email non configurato sul server.' });
    }

    // Risposta neutra e immediata; ricerca dell'account e invio avvengono dopo.
    res.json({ success: true });
    inBackground('FORGOT-PASSWORD MAIL ERROR', async () => {
      const r = await authDb.query('SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
      const user = r.rows[0];
      if (!user) return;
      const token = jwt.sign(
        { uid: user.id, purpose: 'password-reset', sig: passwordHashSignature(user.password_hash) },
        JWT_SECRET,
        { expiresIn: `${RESET_TOKEN_HOURS}h` }
      );
      const resetUrl = `${appBaseUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
      if (LOG_LINKS) console.log(`[FORGOT-PASSWORD] Link di reimpostazione per ${email}: ${resetUrl}`); // solo in locale
      const p = await db.query('SELECT name FROM users WHERE id = $1', [user.id]);
      const nome = (p.rows[0] && p.rows[0].name) || '';
      const { html, text } = buildResetPasswordEmail({ nome, resetUrl, validHours: RESET_TOKEN_HOURS });
      await sendMail({ to: user.email, subject: 'Reimposta la password di Projexa', html, text,
        log: { req, tipo: 'reset_password', userId: user.id } });
    });
  } catch (error) {
    console.error('❌ FORGOT-PASSWORD ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante la richiesta' });
  }
});

// Info per la pagina di reimpostazione (mostra l'email in sola lettura e valida il link).
router.get('/reset-info', async (req, res) => {
  try {
    const info = await verifyResetToken((req.query.token || '').trim());
    res.json({ email: info.email, nome: info.nome });
  } catch (e) {
    const msg = e.message === 'used'
      ? 'Link già utilizzato: la password è stata cambiata. Richiedine uno nuovo.'
      : 'Link non valido o scaduto.';
    res.status(400).json({ error: msg });
  }
});

// Imposta la nuova password a partire dal link ricevuto via email.
router.post('/reset-password', async (req, res) => {
  try {
    const b = req.body || {};
    const token = (b.token || '').trim();
    const newPassword = b.newPassword || '';
    const confirmPassword = b.confirmPassword != null ? b.confirmPassword : newPassword;

    if (newPassword.length < 8) return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Le password non coincidono.' });

    let info;
    try {
      info = await verifyResetToken(token);
    } catch (e) {
      const msg = e.message === 'used'
        ? 'Link già utilizzato: la password è stata cambiata. Richiedine uno nuovo.'
        : 'Link non valido o scaduto.';
      return res.status(400).json({ error: msg });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await authDb.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, info.uid]
    );
    changePwdAttempts.delete(info.uid);
    forgetSessionSignature(info.uid); // chiude le sessioni aperte con la vecchia password
    console.log(`[RESET-PASSWORD] Password reimpostata per utente ${info.uid}`);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ RESET-PASSWORD ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante la reimpostazione della password' });
  }
});

// ==========================================
// Magic link: accesso senza password con un link via email
// ==========================================
//
// 1. L'utente scrive l'email nella pagina di login e clicca "Magic link": se l'email è
//    registrata gli arriva un link a magic-link.html con un token firmato.
// 2. Il token vale MAGIC_LINK_SECONDS secondi (60), si usa una sola volta (jti annotato
//    alla prima verifica) ed è legato alla password attuale, come il link di reset.
// 3. magic-link.html manda il token a /magic-link/verify con una POST (non un GET: i
//    sistemi che "pre-aprono" i link nelle email non lo consumano) e riceve il token di
//    sessione, come dopo un login normale.
const MAGIC_LINK_SECONDS = 60;
const usedMagicLinks = new Map(); // jti -> scadenza (ms): link già usati

// Max 5 richieste ogni 15 minuti per IP e per email: evita di inondare una casella.
const magicAttempts = new Map(); // chiave -> { count, first }
function magicRateLimited(key) {
  const now = Date.now(), windowMs = 15 * 60 * 1000, max = 5;
  const rec = magicAttempts.get(key);
  if (!rec || now - rec.first > windowMs) { magicAttempts.set(key, { count: 1, first: now }); return false; }
  rec.count += 1;
  return rec.count > max;
}

router.post('/magic-link', async (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  try {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Inserisci un indirizzo email valido.' });
    }
    if (magicRateLimited('ip:' + (req.ip || 'unknown')) || magicRateLimited('email:' + email)) {
      return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
    }

    if (!isMailerConfigured()) {
      return res.status(503).json({ error: 'Invio email non configurato sul server.' });
    }

    // Risposta neutra e immediata: il link parte solo se l'email è registrata e la licenza
    // è valida, ma il browser non lo sa (la pagina dice "se l'email è registrata...").
    res.json({ success: true, validSeconds: MAGIC_LINK_SECONDS });
    inBackground('MAGIC-LINK MAIL ERROR', async () => {
      const r = await authDb.query(
        'SELECT id, email, password_hash, scadenza FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [email]
      );
      const user = r.rows[0];
      if (!user || !checkLicenseExpiry(user).valid) return;
      const token = jwt.sign(
        { uid: user.id, purpose: 'magic-link', sig: passwordHashSignature(user.password_hash), jti: crypto.randomUUID() },
        JWT_SECRET,
        { expiresIn: MAGIC_LINK_SECONDS }
      );
      const magicUrl = `${appBaseUrl()}/magic-link.html?token=${encodeURIComponent(token)}`;
      if (LOG_LINKS) console.log(`[MAGIC-LINK] Link di accesso per ${email}: ${magicUrl}`); // solo in locale
      const p = await db.query('SELECT name FROM users WHERE id = $1', [user.id]);
      const nome = (p.rows[0] && p.rows[0].name) || '';
      const { html, text } = buildMagicLinkEmail({ nome, magicUrl, validSeconds: MAGIC_LINK_SECONDS });
      await sendMail({ to: user.email, subject: 'Il tuo link di accesso a Projexa', html, text,
        log: { req, tipo: 'magic_link', userId: user.id } });
      console.log(`[MAGIC-LINK] Link inviato all'utente ${user.id}`);
    });
  } catch (error) {
    console.error('❌ MAGIC-LINK ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante l\'invio del link' });
  }
});

router.post('/magic-link/verify', async (req, res) => {
  const token = ((req.body && req.body.token) || '').trim();
  let d;
  try {
    d = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    const expired = e && e.name === 'TokenExpiredError';
    return res.status(400).json({ error: expired ? 'Link scaduto: richiedine uno nuovo dalla pagina di accesso.' : 'Link non valido.' });
  }
  try {
    if (d.purpose !== 'magic-link' || !d.uid || !d.jti) return res.status(400).json({ error: 'Link non valido.' });

    // Monouso: il primo utilizzo annota il jti fino alla sua scadenza.
    const now = Date.now();
    for (const [k, exp] of usedMagicLinks) if (exp < now) usedMagicLinks.delete(k);
    if (usedMagicLinks.has(d.jti)) return res.status(400).json({ error: 'Link già utilizzato: richiedine uno nuovo.' });
    usedMagicLinks.set(d.jti, d.exp * 1000);

    const a = await authDb.query('SELECT id, email, password_hash, scadenza FROM users WHERE id = $1', [d.uid]);
    const authUser = a.rows[0];
    if (!authUser || passwordHashSignature(authUser.password_hash) !== d.sig) {
      return res.status(400).json({ error: 'Link non più valido: richiedine uno nuovo.' });
    }
    if (!checkLicenseExpiry(authUser).valid) return res.status(403).json({ error: 'La licenza di questo account è scaduta.' });

    // Stesso esito di un login: primo tenant dell'utente e relativo ruolo.
    const nameRow = (await db.query('SELECT name, cognome FROM users WHERE id = $1', [authUser.id])).rows[0] || {};
    const tenant = (await db.query(
      `SELECT t.id, t.name FROM tenants t JOIN user_tenants ut ON ut.tenant_id = t.id
        WHERE ut.user_id = $1 ORDER BY t.name LIMIT 1`,
      [authUser.id]
    )).rows[0];
    if (!tenant) return res.status(401).json({ error: 'Nessuna organizzazione associata a questo account.' });
    const role = (await db.query(
      `SELECT ut.role_id, ut.id_roles, r.name AS role_name
         FROM user_tenants ut LEFT JOIN roles r ON r.id_roles = ut.id_roles
        WHERE ut.user_id = $1 AND ut.tenant_id = $2 LIMIT 1`,
      [authUser.id, tenant.id]
    )).rows[0] || {};

    const sessionToken = signSessionToken(
      {
        user_id: authUser.id,
        email: authUser.email,
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        role_id: role.role_id,
        id_roles: role.id_roles,
        role_name: role.role_name
      },
      authUser.password_hash
    );
    console.log(`[MAGIC-LINK] Accesso effettuato dall'utente ${authUser.id}`);
    registraAccesso(req, { evento: 'magic_link', userId: authUser.id, email: authUser.email, tenantId: tenant.id });
    res.json({
      success: true,
      token: issueSession(req, res, sessionToken),
      user: {
        id: authUser.id,
        email: authUser.email,
        name: buildFullName({ name: nameRow.name, cognome: nameRow.cognome }),
        tenant_name: tenant.name,
        provider: 'magic-link'
      }
    });
  } catch (error) {
    console.error('❌ MAGIC-LINK VERIFY ERROR:', error.message);
    res.status(500).json({ error: 'Errore durante l\'accesso' });
  }
});

// Verify token endpoint
router.get('/verify', async (req, res) => {
  try {
    const token = readSessionCookie(req);
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = await verifySessionToken(token);
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

// Logout: la sessione del cookie viene revocata (non vale più nemmeno se copiata) e i
// cookie di sessione e di impersonificazione vengono cancellati. Nessun requireAuth: deve
// funzionare anche con una sessione già scaduta.
router.post('/logout', async (req, res) => {
  const token = readSessionCookie(req);
  const adminToken = readCookie(req, IMPERSONATE_ADMIN_COOKIE);
  try {
    if (token) await revokeSessionToken(token);
    if (adminToken) await revokeSessionToken(adminToken);
  } catch (e) {
    console.error('❌ LOGOUT ERROR:', e.message);
  }
  clearSessionCookie(req, res);
  clearCookie(req, res, IMPERSONATE_ADMIN_COOKIE, IMPERSONATE_ADMIN_COOKIE_OPTS);
  res.json({ success: true });
});

// Avvio del login con Google / Microsoft: "state" anti login-CSRF (vedi config/oauthLogin.js)
router.get('/google/start', (req, res) => startOAuthLogin(req, res, 'google'));
router.get('/microsoft/start', (req, res) => startOAuthLogin(req, res, 'microsoft'));

// oauth-complete.html: scambia il cookie monouso del login con il token di sessione.
router.post('/oauth-exchange', async (req, res) => {
  const data = takeLoginToken(req, res);
  if (!data || !data.t) return res.status(401).json({ error: 'Accesso non riuscito o scaduto: riprova' });
  try {
    await verifySessionToken(data.t);
    res.json({ token: issueSession(req, res, data.t), user: data.u || {} });
  } catch (e) {
    res.status(401).json({ error: 'Accesso non riuscito o scaduto: riprova' });
  }
});

// Google OAuth Callback
router.get('/google-callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!checkOAuthState(req, res)) {
      console.warn('[GOOGLE_AUTH] state mancante o non valido: accesso rifiutato');
      return res.redirect('/login.html?error=sessione_login_non_valida');
    }
    if (!code) {
      return res.redirect('/login.html?error=missing_code');
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
        redirect_uri: `${process.env.BACKEND_URL || 'https://www.projexa.it'}/api/auth/google-callback`
      }).toString()
    });

    if (!tokenResponse.ok) {
      console.error('❌ Google Token Error:', await tokenResponse.text());
      return res.redirect('/sito/?error=token_exchange_failed');
    }

    const tokenData = await tokenResponse.json();
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
    let authUser = (await authDb.query('SELECT id, email, scadenza, password_hash FROM users WHERE email = $1', [email])).rows[0];
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
      await seedSettingsFromTemplate(db, defaultTenant.rows[0].id, userData.id);

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

    // Token di sessione: consegnato con un cookie monouso, mai nell'URL.
    const jwtToken = signSessionToken(
      {
        user_id: userData.id,
        email: userData.email,
        tenant_id: selectedTenant.id,
        tenant_name: selectedTenant.name,
        role_id: userRole.role_id,
        id_roles: userRole.id_roles,
        role_name: userRole.role_name
      },
      authUser.password_hash
    );

    registraAccesso(req, { evento: 'google', userId: userData.id, email: userData.email, tenantId: selectedTenant.id });
    deliverLoginToken(req, res, jwtToken, {
      provider: 'google',
      name: buildFullName(userData),
      email: userData.email,
      picture: picture || '',
      tenant_name: selectedTenant.name
    });

  } catch (error) {
    console.error('❌ GOOGLE_CALLBACK ERROR:', error.message);
    res.redirect('/login.html?error=accesso_google_non_riuscito');
  }
});

// ==========================================
// IMPERSONIFICAZIONE (solo admin id_roles = 1)
// ==========================================

// id_roles arriva dal database, non dal token (config/session.js), e vale 1 solo per
// l'Admin Projexa: un admin di un cliente non può impersonare utenti di altri tenant.
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

// Durante l'impersonificazione la sessione dell'admin resta in un cookie HttpOnly a parte,
// per il pulsante "Ritorna" (/impersonate/return): il browser non la vede mai.
const IMPERSONATE_ADMIN_COOKIE = 'px_session_admin';
const IMPERSONATE_ADMIN_COOKIE_OPTS = { path: '/api/auth', sameSite: 'Strict' };

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
    const emailRes = await authDb.query('SELECT email, password_hash FROM users WHERE id = $1', [user_id]);
    const email = emailRes.rows[0] ? emailRes.rows[0].email : null;
    // Legato alla password dell'utente impersonato: se la cambia, il token decade.
    const token = signSessionToken(
      {
        user_id,
        email,
        tenant_id,
        tenant_name: row.tenant_name,
        role_id: row.role_id,
        id_roles: row.id_roles,
        role_name: row.role_name
      },
      emailRes.rows[0] ? emailRes.rows[0].password_hash : null
    );
    // Registrato a nome dell'admin che impersona, con l'utente impersonato nel dettaglio.
    registraAccesso(req, {
      evento: 'impersonazione', userId: req.user.user_id, email: req.user.email, tenantId: tenant_id,
      dettaglio: `impersona ${email || user_id} (utente ${user_id}) nel tenant ${row.tenant_name || tenant_id}`
    });
    // Sessione dell'admin da ripristinare al "Ritorna": solo alla prima impersonificazione,
    // così passando da un utente impersonato all'altro si torna sempre all'admin.
    if (!readCookie(req, IMPERSONATE_ADMIN_COOKIE)) {
      setCookie(req, res, IMPERSONATE_ADMIN_COOKIE, readSessionCookie(req),
        { ...IMPERSONATE_ADMIN_COOKIE_OPTS, maxAgeSec: Math.max(0, Number(req.user.exp || 0) - Math.floor(Date.now() / 1000)) });
    }
    res.json({
      token: issueSession(req, res, token),
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

// "Ritorna" dall'impersonificazione: ripristina la sessione dell'admin conservata nel
// cookie px_session_admin. La sessione impersonata viene revocata.
router.post('/impersonate/return', requireAuth, async (req, res) => {
  const adminToken = readCookie(req, IMPERSONATE_ADMIN_COOKIE);
  clearCookie(req, res, IMPERSONATE_ADMIN_COOKIE, IMPERSONATE_ADMIN_COOKIE_OPTS);
  if (!adminToken) return res.status(401).json({ error: 'Sessione amministratore non disponibile: accedi di nuovo' });
  try {
    const admin = await verifySessionToken(adminToken);
    if (Number(admin.id_roles) !== 1) throw Object.assign(new Error('ruolo'), { status: 401 });
    await revokeSessionToken(readSessionCookie(req));
    res.json({ token: issueSession(req, res, adminToken) });
  } catch (e) {
    if (e.status !== 401) console.error('❌ IMPERSONATE RETURN ERROR:', e.message);
    res.status(401).json({ error: 'Sessione amministratore scaduta: accedi di nuovo' });
  }
});

export default router;
