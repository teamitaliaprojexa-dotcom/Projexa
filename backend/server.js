import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import db from './config/database.js';
import authDb from './config/authDatabase.js';
import authRoutes from './routes/auth.js';
import microsoftOAuthRoutes from './routes/microsoft-oauth.js';
import tableStructuresRoutes from './routes/table-structures.js';
import calendarRoutes from './routes/calendar.js';
import { requireAuth } from './middleware/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Dietro il proxy di Render: fidati del primo hop per ottenere l'IP reale (req.ip).
app.set('trust proxy', 1);

// CORS ristretto: consenti le richieste same-origin (Origin assente) e solo le origini
// in whitelist (localhost per lo sviluppo + quelle in ALLOWED_ORIGINS, es. l'URL di produzione).
const allowedOrigins = new Set([
  'http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:8000',
  ...String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
]);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error('Origine non consentita (CORS)'));
  }
}));

// Header di sicurezza di base (difesa in profondità).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json());

// Rate-limit anti brute-force sul login: max 10 tentativi per IP ogni 15 minuti.
const loginAttempts = new Map(); // ip -> { count, first }
function loginRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now(), windowMs = 15 * 60 * 1000, max = 10;
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > windowMs) { loginAttempts.set(ip, { count: 1, first: now }); return next(); }
  rec.count += 1;
  if (rec.count > max) return res.status(429).json({ error: 'Troppi tentativi di accesso. Riprova tra qualche minuto.' });
  next();
}

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
app.use('/api/auth/login', loginRateLimit);
app.use('/api/auth', authRoutes);
app.use('/api/auth', microsoftOAuthRoutes);
app.use('/api/table-structures', requireAuth, tableStructuresRoutes);
app.use('/api/calendar', calendarRoutes);

// ==========================================
// HELPER DI SICUREZZA PER GLI ENDPOINT DATI
// ==========================================

// Colonne che non devono mai essere restituite al client.
const SENSITIVE_COLUMNS = new Set(['password', 'password_hash']);

// Rimuove le colonne sensibili dalle righe restituite (difesa in profondità:
// evita di far trapelare gli hash delle password anche se qualcuno fa SELECT *).
function stripSensitive(rows) {
  return rows.map((row) => {
    const clean = { ...row };
    for (const col of SENSITIVE_COLUMNS) delete clean[col];
    return clean;
  });
}

// Valida un identificatore SQL (nome tabella o colonna) contro un pattern sicuro.
// Blocca la SQL injection sui nomi che vengono interpolati nella query.
function assertValidIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    const err = new Error(`Identificatore non valido: ${name}`);
    err.statusCode = 400;
    throw err;
  }
  return name;
}

// Cache dei metadati colonne per tabella (evita una query information_schema a ogni richiesta).
const tableColumnsCache = new Map();

async function getTableColumns(tableName) {
  if (tableColumnsCache.has(tableName)) {
    return tableColumnsCache.get(tableName);
  }
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  const columns = new Set(result.rows.map((r) => r.column_name));
  tableColumnsCache.set(tableName, columns);
  return columns;
}

// Colonne GENERATE (GENERATED ALWAYS AS ... STORED): non sono scrivibili, vanno
// escluse da INSERT/UPDATE altrimenti Postgres rifiuta la query. Cache per tabella.
const generatedColumnsCache = new Map();

async function getGeneratedColumns(tableName) {
  if (generatedColumnsCache.has(tableName)) {
    return generatedColumnsCache.get(tableName);
  }
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'ALWAYS'`,
    [tableName]
  );
  const columns = new Set(result.rows.map((r) => r.column_name));
  generatedColumnsCache.set(tableName, columns);
  return columns;
}

// Verifica che la tabella richiesta sia gestita (presente in table_structures)
// oppure sia la tabella di sistema table_structures. Restituisce true/false.
async function isManagedTable(tableName) {
  if (tableName === 'table_structures') return true;
  const tableCheck = await db.query(
    'SELECT 1 FROM table_structures WHERE table_name = $1 AND is_active = true',
    [tableName]
  );
  return tableCheck.rows.length > 0;
}

// Admin di sistema (ruolo "Admin" = id_roles 1): bypassa l'isolamento per tenant,
// così può leggere/scrivere/scegliere qualsiasi tenant dal database-viewer.
function isAdminUser(req) {
  return Number(req.user?.id_roles) === 1;
}

// Middleware: consente solo agli amministratori (id_roles = 1).
function requireAdmin(req, res, next) {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Riservato agli amministratori' });
  next();
}

// Chiavi di filtro per identificare la riga "del login" in una tabella di riferimento
// (usata dai campi settings di tipo 4). Usa le colonne user_id/tenant_id se presenti,
// altrimenti la PK id per le tabelle users (= utente del login) e tenants (= tenant del login).
async function referenceKeys(tabella, user) {
  const cols = await getTableColumns(tabella);
  const keys = [];
  if (cols.has('user_id')) keys.push({ col: 'user_id', val: user.user_id });
  else if (tabella === 'users') keys.push({ col: 'id', val: user.user_id });
  if (cols.has('tenant_id')) keys.push({ col: 'tenant_id', val: user.tenant_id });
  else if (tabella === 'tenants') keys.push({ col: 'id', val: user.tenant_id });
  return keys;
}

// Dynamic Generic Table Routes - reads from table_structures
// Supporta filtri per colonna: qualsiasi query param con chiave = nome di una colonna
// filtra quella colonna con ILIKE %valore% (case-insensitive, ricerca parziale).
app.get('/api/data/:table', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const columns = await getTableColumns(tableName);
    const admin = isAdminUser(req);
    const conditions = [];
    const params = [];

    // Filtri per colonna (dal query string)
    for (const [key, val] of Object.entries(req.query)) {
      if (columns.has(key) && val != null && String(val) !== '') {
        assertValidIdentifier(key);
        params.push('%' + String(val) + '%');
        conditions.push(`"${key}"::text ILIKE $${params.length}`);
      }
    }

    // Isolamento multi-tenant per i non-admin
    if (!admin) {
      if (tableName === 'tenants') {
        // "tenants" non ha tenant_id: il proprio tenant è la riga con id = tenant del login
        params.push(req.user.tenant_id);
        conditions.push(`id = $${params.length}`);
      } else if (columns.has('tenant_id')) {
        params.push(req.user.tenant_id);
        conditions.push(`tenant_id = $${params.length}`);
      }
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await db.query(`SELECT * FROM "${tableName}" ${whereClause} LIMIT 100`, params);
    res.json(stripSensitive(result.rows));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Metadati colonne di una tabella gestita: nome + flag "generated" (colonna calcolata,
// non scrivibile). Serve al database-viewer per costruire il form New anche con tabella
// vuota e per escludere/segnalare le colonne generate.
app.get('/api/data/:table/columns', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }
    const result = await db.query(
      `SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    // Foreign key della tabella: colonna -> tabella + colonna referenziata (per i dropdown nel form).
    const fk = await db.query(
      `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`,
      [tableName]
    );
    const fkMap = {};
    const fkColMap = {};
    for (const r of fk.rows) { fkMap[r.column_name] = r.foreign_table; fkColMap[r.column_name] = r.foreign_column; }
    res.json(result.rows.map((r) => ({
      name: r.column_name,
      generated: r.is_generated === 'ALWAYS',
      references: fkMap[r.column_name] || null,
      referencesColumn: fkColMap[r.column_name] || null
    })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST - Create record
app.post('/api/data/:table', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    let data = { ...req.body };

    // Le stringhe vuote diventano NULL: colonne numeriche/date/boolean non accettano ''.
    for (const k of Object.keys(data)) {
      if (data[k] === '') data[k] = null;
    }

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    // Isolamento multi-tenant: per gli utenti normali forza il tenant_id a quello
    // del login, ignorando quello inviato dal client. Gli admin possono invece
    // scegliere liberamente il tenant (mantengono il valore del form).
    const tableColumns = await getTableColumns(tableName);
    if (tableColumns.has('tenant_id') && !isAdminUser(req)) {
      data.tenant_id = req.user.tenant_id;
    }

    // Le colonne generate non sono scrivibili: rimuovile dai dati in ingresso.
    const generatedColumns = await getGeneratedColumns(tableName);
    for (const g of generatedColumns) delete data[g];

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da inserire' });
    }
    const values = columns.map((col) => data[col]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quotedColumns = columns.map((c) => `"${c}"`).join(', ');

    const query = `INSERT INTO "${tableName}" (${quotedColumns}) VALUES (${placeholders}) RETURNING *`;
    const result = await db.query(query, values);

    res.status(201).json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// PUT - Update record
app.put('/api/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    const id = req.params.id;
    let data = { ...req.body };

    // Le stringhe vuote diventano NULL: colonne numeriche/date/boolean non accettano ''.
    for (const k of Object.keys(data)) {
      if (data[k] === '') data[k] = null;
    }

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    // Gli utenti non-admin non possono riassegnare il tenant_id di un record;
    // gli admin sì (mantengono il valore inviato dal form).
    const tableColumns = await getTableColumns(tableName);
    const admin = isAdminUser(req);
    if (!admin) {
      delete data.tenant_id;
    }

    // Le colonne generate non sono scrivibili: rimuovile dai dati in ingresso.
    const generatedColumns = await getGeneratedColumns(tableName);
    for (const g of generatedColumns) delete data[g];

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da aggiornare' });
    }
    const updates = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
    const values = [...columns.map((col) => data[col]), id];

    // Isolamento multi-tenant per i non-admin: l'update tocca solo i record del
    // proprio tenant. Gli admin possono modificare record di qualsiasi tenant.
    let whereClause = `id = $${columns.length + 1}`;
    if (tableColumns.has('tenant_id') && !admin) {
      values.push(req.user.tenant_id);
      whereClause += ` AND tenant_id = $${columns.length + 2}`;
    }

    // Aggiorna updated_at solo se la tabella ha quella colonna (alcune tabelle non ce l'hanno)
    const updatedAtClause = tableColumns.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
    const query = `UPDATE "${tableName}" SET ${updates}${updatedAtClause} WHERE ${whereClause} RETURNING *`;
    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// DELETE - Delete record
app.delete('/api/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);
    const id = req.params.id;

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Isolamento multi-tenant: i non-admin cancellano solo i record del proprio
    // tenant; gli admin possono cancellare record di qualsiasi tenant.
    const tableColumns = await getTableColumns(tableName);
    let query = `DELETE FROM "${tableName}" WHERE id = $1 RETURNING *`;
    const values = [id];
    if (tableColumns.has('tenant_id') && !isAdminUser(req)) {
      query = `DELETE FROM "${tableName}" WHERE id = $1 AND tenant_id = $2 RETURNING *`;
      values.push(req.user.tenant_id);
    }

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ message: 'Record deleted', data: stripSensitive(result.rows)[0] });
  } catch (error) {
    // 23503 = violazione di chiave esterna: il record è referenziato altrove.
    if (error && error.code === '23503') {
      return res.status(409).json({
        error: 'Impossibile eliminare: il record è collegato ad altri dati' +
               (error.table ? ` (tabella "${error.table}")` : '') + '. Rimuovi prima i dati collegati.'
      });
    }
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Import in sospeso per utente: userKey -> { client, timer }.
// La transazione resta aperta finché l'utente non fa commit/rollback (o scade il timeout).
const activeImports = new Map();

function takePendingImport(userKey) {
  const entry = activeImports.get(userKey);
  if (!entry) return null;
  clearTimeout(entry.timer);
  activeImports.delete(userKey);
  return entry.client;
}

// IMPORT - Upsert di più righe (da CSV), in ANTEPRIMA: elabora i dati in una
// transazione aperta e restituisce i conteggi, SENZA salvare. L'utente deve poi
// confermare (/api/data/import/commit) o annullare (/api/data/import/rollback).
// Per ogni riga:
//  - se contiene un id esistente -> UPDATE; se l'id non esiste -> INSERT con quell'id;
//  - se l'id non è presente -> INSERT con id generato automaticamente.
app.post('/api/data/:table/import', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da importare' });
    }

    const tableColumns = await getTableColumns(tableName);
    const generatedColumns = await getGeneratedColumns(tableName);
    const admin = isAdminUser(req);
    const userKey = req.user.user_id || req.user.email;

    // Se c'era già un import in sospeso per l'utente, annullalo prima di iniziarne uno nuovo
    const prev = takePendingImport(userKey);
    if (prev) {
      try { await prev.query('ROLLBACK'); } catch (e) { /* ignore */ }
      prev.release();
    }

    const client = await db.connect();
    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    try {
      await client.query('BEGIN');

      for (let i = 0; i < rows.length; i++) {
        try {
          let data = { ...rows[i] };

          // Stringhe vuote -> NULL; scarta le colonne non presenti o generate (non scrivibili)
          for (const k of Object.keys(data)) {
            if (data[k] === '') data[k] = null;
            if (!tableColumns.has(k) || generatedColumns.has(k)) delete data[k];
          }

          // Hash della password se presente
          if (data.password || data.password_hash) {
            const pw = data.password || data.password_hash;
            data.password_hash = await bcrypt.hash(pw, 10);
            delete data.password;
          }

          // Isolamento tenant per i non-admin
          if (tableColumns.has('tenant_id') && !admin) {
            data.tenant_id = req.user.tenant_id;
          }

          const hasId = data.id !== undefined && data.id !== null && data.id !== '';
          if (!hasId) delete data.id;

          const columns = Object.keys(data).map(assertValidIdentifier);
          if (columns.length === 0) {
            errors.push({ row: i + 1, error: 'Riga vuota' });
            continue;
          }
          const values = columns.map((c) => data[c]);
          const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
          const quotedCols = columns.map((c) => `"${c}"`).join(', ');

          await client.query('SAVEPOINT sp_import');
          try {
            if (hasId) {
              const updateCols = columns.filter((c) => c !== 'id');
              let query, params;
              if (updateCols.length > 0) {
                const setClause = updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
                const setExtra = tableColumns.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
                params = values;
                let conflictWhere = '';
                if (tableColumns.has('tenant_id') && !admin) {
                  // I non-admin non possono aggiornare righe di altri tenant
                  conflictWhere = ` WHERE "${tableName}".tenant_id = $${columns.length + 1}`;
                  params = [...values, req.user.tenant_id];
                }
                query = `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders})
                         ON CONFLICT (id) DO UPDATE SET ${setClause}${setExtra}${conflictWhere}
                         RETURNING (xmax = 0) AS inserted`;
              } else {
                query = `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders})
                         ON CONFLICT (id) DO NOTHING RETURNING (xmax = 0) AS inserted`;
                params = values;
              }
              const r = await client.query(query, params);
              if (r.rows.length === 0) skipped++;          // conflitto ma escluso (altro tenant) o DO NOTHING
              else if (r.rows[0].inserted) inserted++;
              else updated++;
            } else {
              await client.query(
                `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders}) RETURNING id`,
                values
              );
              inserted++;
            }
            await client.query('RELEASE SAVEPOINT sp_import');
          } catch (dbErr) {
            await client.query('ROLLBACK TO SAVEPOINT sp_import');
            throw dbErr;
          }
        } catch (rowErr) {
          errors.push({ row: i + 1, error: rowErr.message });
        }
      }

      // NON committare: lascia la transazione aperta in attesa di conferma dell'utente.
      // Auto-rollback di sicurezza dopo 5 minuti se non arriva commit/rollback.
      const timer = setTimeout(async () => {
        const c = takePendingImport(userKey);
        if (c) {
          try { await c.query('ROLLBACK'); } catch (e) { /* ignore */ }
          c.release();
        }
      }, 5 * 60 * 1000);
      activeImports.set(userKey, { client, timer });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      client.release();
      throw txErr;
    }

    res.json({ inserted, updated, skipped, errors, pending: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Conferma (COMMIT) dell'import in sospeso per l'utente
app.post('/api/data/import/commit', requireAuth, async (req, res) => {
  const userKey = req.user.user_id || req.user.email;
  const client = takePendingImport(userKey);
  if (!client) {
    return res.status(400).json({ error: 'Nessun import in sospeso da confermare' });
  }
  try {
    await client.query('COMMIT');
    res.json({ message: 'Import confermato e salvato' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Annulla (ROLLBACK) dell'import in sospeso per l'utente
app.post('/api/data/import/rollback', requireAuth, async (req, res) => {
  const userKey = req.user.user_id || req.user.email;
  const client = takePendingImport(userKey);
  if (!client) {
    return res.status(400).json({ error: 'Nessun import in sospeso da annullare' });
  }
  try {
    await client.query('ROLLBACK');
    res.json({ message: 'Import annullato, nessuna modifica salvata' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ==========================================
// SETTINGS ENDPOINTS
// ==========================================

// Elenco degli "argument" distinti per l'utente + tenant del token di login.
// Equivale a: SELECT DISTINCT argument FROM settings WHERE tenant_id = ? AND user_id = ?
app.get('/api/settings/arguments', requireAuth, async (req, res) => {
  try {
    // Livello di privilegio dell'utente (id_roles più basso = più privilegi).
    // Mostra solo gli argomenti con almeno una riga il cui id_roles >= quello dell'utente
    // (oppure id_roles NULL = nessuna restrizione).
    const uid = Number(req.user.id_roles);
    const roleLevel = Number.isFinite(uid) ? uid : 9999;
    const result = await db.query(
      `SELECT argument
       FROM settings
       WHERE tenant_id = $1 AND user_id = $2 AND argument IS NOT NULL
         AND (id_roles IS NULL OR id_roles >= $3)
       GROUP BY argument
       ORDER BY MIN(ordinamento) NULLS LAST, argument`,
      [req.user.tenant_id, req.user.user_id, roleLevel]
    );
    res.json(result.rows.map(r => r.argument));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crea un nuovo argomento (settings) con un campo custom segnaposto, per TUTTI gli utenti
// del tenant (scope 'this-tenant') o di tutti i tenant (scope 'all-tenants', solo admin).
// Usa user_tenants per enumerare le coppie (utente, tenant).
app.post('/api/settings/argument', requireAuth, async (req, res) => {
  try {
    const name = ((req.body && req.body.name) || '').trim();
    const scope = (req.body && req.body.scope) || 'this-tenant';
    // id_roles da associare all'argomento (visibilità); vuoto/null = nessuna restrizione.
    const idRoles = (req.body && req.body.idRoles != null && req.body.idRoles !== '')
      ? parseInt(req.body.idRoles, 10) : null;
    // Tipo valore + campi collegati (stesse regole del flyout 2); vuoti = NULL.
    const tipoValore = (req.body && req.body.tipo_valore) || null;
    const tabella = ((req.body && req.body.tabella) || '').trim() || null;
    const colonna = ((req.body && req.body.colonna) || '').trim() || null;
    const variabDb = ((req.body && req.body.VariabDB) || '').trim() || null;
    if (!name) return res.status(400).json({ error: 'Nome argomento richiesto' });
    if (scope === 'all-tenants' && Number(req.user.id_roles) !== 1) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
    // 'this-tenant' = argomento "custom": prefisso "(*)" (pallino verde in UI) e ordinamento da 200.
    // 'all-tenants' = argomento "standard": nessun prefisso, ordinamento nella fascia 1-199.
    const isCustomArg = (scope !== 'all-tenants');
    const argName = isCustomArg ? ('(*) ' + name) : name;
    let ordRes;
    if (isCustomArg) {
      ordRes = await db.query(
        `SELECT MAX(ordinamento) AS m FROM settings WHERE tenant_id = $1 AND ordinamento >= 200`,
        [req.user.tenant_id]
      );
    } else {
      ordRes = await db.query(`SELECT MAX(ordinamento) AS m FROM settings WHERE ordinamento BETWEEN 1 AND 199`);
    }
    const base = isCustomArg ? 200 : 1;
    const newOrd = (ordRes.rows[0].m != null) ? Number(ordRes.rows[0].m) + 1 : base;

    // Riga "segnaposto" per far comparire l'argomento (campo NULL = nascosta in visualizzazione).
    // Ora porta anche tipo_valore/tabella/colonna/VariabDB scelti nel form.
    let query, params;
    if (scope === 'all-tenants') {
      query = `INSERT INTO settings (argument, tenant_id, user_id, ordinamento, id_roles, tipo_valore, tabella, colonna, "VariabDB")
               SELECT $1, ut.tenant_id, ut.user_id, $2, $3::smallint, $4, $5, $6, $7 FROM user_tenants ut`;
      params = [argName, newOrd, idRoles, tipoValore, tabella, colonna, variabDb];
    } else {
      query = `INSERT INTO settings (argument, tenant_id, user_id, ordinamento, id_roles, tipo_valore, tabella, colonna, "VariabDB")
               SELECT $1, ut.tenant_id, ut.user_id, $2, $4::smallint, $5, $6, $7, $8
               FROM user_tenants ut WHERE ut.tenant_id = $3`;
      params = [argName, newOrd, req.user.tenant_id, idRoles, tipoValore, tabella, colonna, variabDb];
    }
    const result = await db.query(query, params);
    res.status(201).json({ inserted: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Elimina un intero argomento (settings) con tutti i suoi campi: su tutti gli utenti del
// tenant ('this-tenant') o di tutti i tenant ('all-tenants', solo admin).
app.delete('/api/settings/argument', requireAuth, async (req, res) => {
  try {
    const name = ((req.query && req.query.name) || '').trim();
    const scope = (req.query && req.query.scope) || 'this-tenant';
    if (!name) return res.status(400).json({ error: 'Nome argomento richiesto' });
    if (scope === 'all-tenants' && Number(req.user.id_roles) !== 1) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
    let query, params;
    if (scope === 'all-tenants') {
      query = `DELETE FROM settings WHERE argument = $1`;
      params = [name];
    } else {
      query = `DELETE FROM settings WHERE argument = $1 AND tenant_id = $2`;
      params = [name, req.user.tenant_id];
    }
    const result = await db.query(query, params);
    res.json({ deleted: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rinomina un intero argomento (settings): aggiorna la colonna argument su tutte le
// righe con quel nome, su questo tenant ('this-tenant') o su tutti ('all-tenants', solo admin).
// Conserva la natura custom: se l'argomento originale inizia con "(*)", il nuovo mantiene il prefisso.
app.put('/api/settings/argument/rename', requireAuth, async (req, res) => {
  try {
    const oldName = ((req.body && req.body.oldName) || '').trim();
    let newName = ((req.body && req.body.newName) || '').trim();
    const scope = (req.body && req.body.scope) || 'this-tenant';
    if (!oldName || !newName) return res.status(400).json({ error: 'Nome vecchio e nuovo richiesti' });
    if (scope === 'all-tenants' && Number(req.user.id_roles) !== 1) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
    // Conserva il prefisso "(*)" degli argomenti custom.
    const isCustom = oldName.startsWith('(*)');
    const bare = newName.replace(/^\(\*\)\s*/, '').trim();
    if (!bare) return res.status(400).json({ error: 'Nuovo nome non valido' });
    const finalNew = isCustom ? ('(*) ' + bare) : bare;

    let query, params;
    if (scope === 'all-tenants') {
      query = `UPDATE settings SET argument = $1 WHERE argument = $2`;
      params = [finalNew, oldName];
    } else {
      query = `UPDATE settings SET argument = $1 WHERE argument = $2 AND tenant_id = $3`;
      params = [finalNew, oldName, req.user.tenant_id];
    }
    const result = await db.query(query, params);
    res.json({ updated: result.rowCount, argument: finalNew });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Elenco clienti: id (della riga) + nome (valore2), per l'utente + tenant del login.
// L'id serve come "argument" per il flyout di dettaglio del cliente.
// Equivale a: SELECT id, valore2 FROM clients
//   WHERE argument='Cliente' AND campo='Cliente' AND tenant_id=? AND user_id=?
app.get('/api/clients/names', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, valore2 AS name
       FROM clients
       WHERE argument = 'Cliente' AND campo = 'Cliente'
         AND tenant_id = $1 AND user_id = $2 AND valore2 IS NOT NULL
       ORDER BY valore2`,
      [req.user.tenant_id, req.user.user_id]
    );
    res.json(result.rows); // [{ id, name }, ...]
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Copia ricorsivamente la STRUTTURA dei campi di un contenitore (cliente o Nodo Padre)
// sotto un nuovo contenitore, azzerando i valori. Preserva la gerarchia: per ogni Nodo
// Padre (tipo_valore=0) copiato, copia anche i suoi figli (argument = id del nodo sorgente).
// dbClient = client di transazione; tenantId/userId = destinatari; srcArg = argument sorgente;
// newArg = argument (id) del nuovo contenitore.
async function deepCopyClientTree(dbClient, tenantId, userId, srcArg, newArg) {
  const rows = (await dbClient.query(
    `SELECT id, campo, tipo_valore, id_roles, ordinamento, tabella, colonna, layout_col, "VariabDB" AS variabdb
     FROM clients
     WHERE argument = $1 AND campo IS NOT NULL AND campo <> 'Cliente'
     ORDER BY ordinamento NULLS LAST, campo`,
    [srcArg]
  )).rows;
  for (const r of rows) {
    const insRes = await dbClient.query(
      `INSERT INTO clients (tenant_id, user_id, argument, campo, tipo_valore, id_roles, ordinamento, tabella, colonna, layout_col, "VariabDB")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tenantId, userId, newArg, r.campo, r.tipo_valore, r.id_roles, r.ordinamento, r.tabella, r.colonna, r.layout_col, r.variabdb]
    );
    const newId = insRes.rows[0].id;
    // Nodo Padre: copia ricorsivamente i figli (argument = id del nodo sorgente -> nuovo nodo).
    if (String(r.tipo_valore) === '0') {
      await deepCopyClientTree(dbClient, tenantId, userId, String(r.id), String(newId));
    }
  }
}

// Crea un nuovo cliente (riga argument='Cliente', campo='Cliente', valore2=<nome>) e
// ne copia la STRUTTURA (valori vuoti) da un cliente modello, preservando la gerarchia.
// Consentito solo agli utenti con ruolo id_roles <= 50 (numeri più bassi = più privilegi).
app.post('/api/clients', requireAuth, async (req, res) => {
  const roleLevel = Number(req.user.id_roles);
  if (!Number.isFinite(roleLevel) || roleLevel > 50) {
    return res.status(403).json({ error: 'Non autorizzato a creare clienti' });
  }
  const name = ((req.body && req.body.name) || '').trim();
  const sourceClientId = ((req.body && req.body.sourceClientId) || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Nome cliente richiesto' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Riga identità del cliente
    const ins = await client.query(
      `INSERT INTO clients (argument, campo, valore2, tenant_id, user_id)
       VALUES ('Cliente', 'Cliente', $1, $2, $3) RETURNING *`,
      [name, req.user.tenant_id, req.user.user_id]
    );
    const newClient = ins.rows[0];

    // 2) Deep-copy della STRUTTURA (valori vuoti) da un cliente modello, preservando la
    //    gerarchia (primo livello + Nodi Padre e relativi figli, ricorsivamente).
    //    Sorgente: il cliente scelto (sourceClientId, stesso tenant+utente); se assente
    //    (es. primo cliente) si usa il modello master: tenant 'PROJEXA' / 'PROJEXA_COPIA_CLIENTE'.
    let srcId = null;
    if (sourceClientId) {
      const v = await client.query(
        `SELECT id FROM clients WHERE id = $1 AND argument='Cliente' AND campo='Cliente'
           AND tenant_id = $2 AND user_id = $3`,
        [sourceClientId, req.user.tenant_id, req.user.user_id]
      );
      if (v.rows.length) srcId = v.rows[0].id;
    }
    if (!srcId) {
      const m = await client.query(
        `SELECT c.id FROM clients c JOIN tenants t ON t.id = c.tenant_id
         WHERE t.name = 'PROJEXA' AND c.argument='Cliente' AND c.campo='Cliente'
           AND c.valore2 = 'PROJEXA_COPIA_CLIENTE' LIMIT 1`
      );
      if (m.rows.length) srcId = m.rows[0].id;
    }
    if (srcId) {
      await deepCopyClientTree(client, req.user.tenant_id, req.user.user_id, srcId, newClient.id);
    }

    await client.query('COMMIT');
    res.status(201).json(newClient);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Elenco dei tipi valore (per la scelta del tipo quando si crea un campo custom),
// filtrato per ruolo: l'utente vede un tipo se il proprio id_roles <= id_roles del tipo
// (cioè tipo_valore.id_roles >= id_roles utente), oppure id_roles NULL = nessuna restrizione.
// Numeri più bassi = più privilegi: così gli admin vedono tutto.
app.get('/api/tipo-valore', requireAuth, async (req, res) => {
  try {
    const uid = Number(req.user.id_roles);
    const roleLevel = Number.isFinite(uid) ? uid : 9999;
    const result = await db.query(
      `SELECT id_code, description FROM tipo_valore
       WHERE id_roles IS NULL OR id_roles >= $1
       ORDER BY description`,
      [roleLevel]
    );
    res.json(result.rows); // [{ id_code, description }, ...]
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Elenco ruoli (per scegliere id_roles alla creazione di un campo). Mostra solo i ruoli
// con id_roles >= quello dell'utente (così il creatore vede comunque il campo).
app.get('/api/roles', requireAuth, async (req, res) => {
  try {
    const uid = Number(req.user.id_roles);
    const roleLevel = Number.isFinite(uid) ? uid : 9999;
    const result = await db.query(
      `SELECT DISTINCT id_roles, name FROM roles WHERE id_roles >= $1 ORDER BY id_roles`,
      [roleLevel]
    );
    res.json(result.rows); // [{ id_roles, name }, ...]
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legge una preferenza booleana (valore1) dalla tabella settings per l'utente/tenant
// del login, dato argument e campo. Restituisce { value: true|false }.
// Usato ad es. per "Abilita Organigramma" (argument=Preferenze, campo=Abilita Organigramma).
app.get('/api/settings/preference', requireAuth, async (req, res) => {
  try {
    const argument = ((req.query && req.query.argument) || '').trim();
    const campo = ((req.query && req.query.campo) || '').trim();
    if (!argument || !campo) return res.status(400).json({ error: 'argument e campo richiesti' });
    const result = await db.query(
      `SELECT valore1 FROM settings
       WHERE tenant_id = $1 AND user_id = $2 AND argument = $3 AND campo = $4
       LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, argument, campo]
    );
    const v = result.rows.length ? result.rows[0].valore1 : false;
    const value = (v === true || v === 'true' || v === 't');
    res.json({ value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fattore di scala dello schermo: valore3 del campo settings con tipo_valore=30 e
// valore2='schermo' (per tenant/utente). 100 = normale; es. 70 = interfaccia al 70%.
app.get('/api/settings/screen-scale', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT valore3 FROM settings
       WHERE tenant_id = $1 AND user_id = $2 AND tipo_valore = '30' AND valore2 = 'schermo'
         AND valore3 IS NOT NULL
       ORDER BY valore3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id]
    );
    const n = result.rows.length ? Number(result.rows[0].valore3) : 100;
    res.json({ value: (Number.isFinite(n) && n > 0) ? n : 100 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Aggiunge un campo. scope = 'this' -> solo sul contenitore indicato (argument = id contenitore);
// 'all' -> sotto ogni contenitore col campo indicato (top-level: identità campo='Cliente').
// kind = 'standard' (senza "(*)", ordinamento fascia 1-100) oppure 'custom' (con "(*)", ordinamento
// da 200). 'standard' è consentito solo agli utenti con id_roles <= 20, altrimenti forzato a custom.
app.post('/api/:source(settings|clients)/field', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const clientId = ((req.body && req.body.clientId) || '').trim();
    const rawCampo = ((req.body && req.body.campo) || '').trim();
    const tipoValore = (req.body && req.body.tipo_valore) || null;
    const tabella = ((req.body && req.body.tabella) || '').trim() || null;
    const colonna = ((req.body && req.body.colonna) || '').trim() || null;
    const variabDb = ((req.body && req.body.VariabDB) || '').trim() || null; // colonna "VariabDB"
    const valore2 = ((req.body && req.body.valore2) || '').trim() || null;   // valore iniziale (es. tipo 30)
    const scope = (req.body && req.body.scope) || 'this';
    const kind = (req.body && req.body.kind) || 'custom';
    // Contenitore dello scope 'all': 'Cliente' al top-level, oppure il campo del Nodo Padre.
    const containerCampo = ((req.body && req.body.containerCampo) || 'Cliente').trim() || 'Cliente';
    // id_roles del nuovo campo (visibilità per ruolo); vuoto/assente = NULL (nessuna restrizione).
    const idRolesRaw = (req.body && req.body.id_roles);
    const idRoles = (idRolesRaw === '' || idRolesRaw == null) ? null : Number(idRolesRaw);
    if (!rawCampo) {
      return res.status(400).json({ error: 'nome campo richiesto' });
    }
    if (scope === 'this' && !clientId) {
      return res.status(400).json({ error: 'clientId richiesto' });
    }

    // 'standard' consentito solo a id_roles <= 20; altrimenti campo custom.
    const roleLevel = Number(req.user.id_roles);
    const isStandard = (kind === 'standard') && Number.isFinite(roleLevel) && roleLevel <= 20;
    // Standard: nessun prefisso, ordinamento tra i campi NON custom (parte da 1, resta < 200).
    // Custom: prefisso "(*)", ordinamento tra i campi >= 200 (parte da 200). In entrambi i casi
    // il nuovo ordinamento è MAX della fascia + 1, senza accatastarsi.
    const campo = isStandard ? rawCampo : ('(*) ' + rawCampo);
    const bandClause = isStandard
      ? "AND campo NOT LIKE '(*)%' AND (ordinamento IS NULL OR ordinamento < 200)"
      : 'AND ordinamento >= 200';
    const bandBase = isStandard ? 1 : 200;

    // IMPOSTAZIONI: scope tenant. Inserisce il campo per ogni (tenant,utente) che possiede
    // già l'argomento/contenitore -> 'this-tenant' (solo tenant corrente) o 'all-tenants' (admin).
    if (source === 'settings') {
      if (!clientId) return res.status(400).json({ error: 'argomento richiesto' });
      const isAllTenants = (scope === 'all-tenants');
      if (isAllTenants && Number(req.user.id_roles) !== 1) {
        return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
      }
      let ordRes;
      if (isAllTenants) {
        ordRes = await db.query(`SELECT MAX(ordinamento) AS m FROM settings WHERE argument = $1 ${bandClause}`, [clientId]);
      } else {
        ordRes = await db.query(`SELECT MAX(ordinamento) AS m FROM settings WHERE argument = $1 AND tenant_id = $2 ${bandClause}`, [clientId, req.user.tenant_id]);
      }
      const newOrd = (ordRes.rows[0].m != null) ? Number(ordRes.rows[0].m) + 1 : bandBase;
      let q, p;
      if (isAllTenants) {
        q = `INSERT INTO settings (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles)
             SELECT DISTINCT $1, $2, $3, $4, $5, $8, $9, s.tenant_id, s.user_id, $6::integer, $7::smallint FROM settings s WHERE s.argument = $1`;
        p = [clientId, campo, tipoValore, tabella, colonna, newOrd, idRoles, variabDb, valore2];
      } else {
        q = `INSERT INTO settings (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles)
             SELECT DISTINCT $1, $2, $3, $4, $5, $9, $10, s.tenant_id, s.user_id, $6::integer, $8::smallint FROM settings s WHERE s.argument = $1 AND s.tenant_id = $7`;
        p = [clientId, campo, tipoValore, tabella, colonna, newOrd, req.user.tenant_id, idRoles, variabDb, valore2];
      }
      const result = await db.query(q, p);
      return res.status(201).json({ inserted: result.rowCount });
    }

    if (scope === 'all') {
      // Ordinamento coerente su tutti i contenitori (max della fascia nel tenant/utente, +1)
      const ord = await db.query(
        `SELECT MAX(ordinamento) AS maxord FROM "${source}"
         WHERE tenant_id = $1 AND user_id = $2 ${bandClause}`,
        [req.user.tenant_id, req.user.user_id]
      );
      const maxord = ord.rows[0].maxord;
      const newOrd = (maxord != null) ? Number(maxord) + 1 : bandBase;
      // Una riga del campo sotto ogni contenitore col campo indicato:
      // 'Cliente' = righe identità (top-level); altrimenti i Nodo Padre con quel campo.
      // argument = id del contenitore (così i figli si legano al contenitore giusto).
      const result = await db.query(
        `INSERT INTO "${source}" (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles)
         SELECT c.id::text, $1, $2, $3, $4, $10, $11, $5, $6, $7, $9::smallint
         FROM "${source}" c
         WHERE c.campo = $8 AND c.tenant_id = $5 AND c.user_id = $6`,
        [campo, tipoValore, tabella, colonna, req.user.tenant_id, req.user.user_id, newOrd, containerCampo, idRoles, variabDb, valore2]
      );
      return res.status(201).json({ inserted: result.rowCount });
    }

    // scope 'this': primo ordinamento disponibile nella fascia per questo contenitore
    const ord = await db.query(
      `SELECT MAX(ordinamento) AS maxord FROM "${source}"
       WHERE argument = $1 AND tenant_id = $2 AND user_id = $3 ${bandClause}`,
      [clientId, req.user.tenant_id, req.user.user_id]
    );
    const maxord = ord.rows[0].maxord;
    const newOrd = (maxord != null) ? Number(maxord) + 1 : bandBase;

    const result = await db.query(
      `INSERT INTO "${source}" (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles)
       VALUES ($1, $2, $3, $4, $5, $10, $11, $6, $7, $8, $9) RETURNING *`,
      [clientId, campo, tipoValore, tabella, colonna, req.user.tenant_id, req.user.user_id, newOrd, idRoles, variabDb, valore2]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Eliminazione di campi, identificati per nome "campo". Di norma solo i campi custom
// (ordinamento >= 100); gli admin (id_roles = 1) possono eliminare anche i campi standard.
// scope = 'all' -> tutti i contenitori del tenant/utente; 'this' -> solo il contenitore indicato.
app.post('/api/:source(settings|clients)/delete-fields', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const campos = (req.body && req.body.campos) || [];
    const scope = (req.body && req.body.scope) || 'this';
    const clientId = ((req.body && req.body.clientId) || '').trim();
    if (!Array.isArray(campos) || campos.length === 0) {
      return res.status(400).json({ error: 'Nessun campo selezionato' });
    }
    // Admin (id_roles = 1): nessun vincolo -> elimina anche i campi standard.
    // Altrimenti solo i campi custom (nome con prefisso "(*)").
    const isAdmin = Number(req.user.id_roles) === 1;
    const ordGuard = isAdmin ? '' : "AND campo LIKE '(*)%'";
    let query, params;
    if (source === 'settings') {
      // Impostazioni: scope tenant. 'all-tenants' (tutti i tenant, solo admin) oppure
      // 'this-tenant' (tutti gli utenti del tenant corrente). Filtra per argomento.
      if (!clientId) return res.status(400).json({ error: 'argomento richiesto' });
      if (scope === 'all-tenants') {
        if (!isAdmin) return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
        query = `DELETE FROM settings WHERE campo = ANY($1::text[]) AND argument = $2 ${ordGuard}`;
        params = [campos, clientId];
      } else {
        query = `DELETE FROM settings WHERE campo = ANY($1::text[]) AND argument = $2 AND tenant_id = $3 ${ordGuard}`;
        params = [campos, clientId, req.user.tenant_id];
      }
    } else if (scope === 'all') {
      query = `DELETE FROM clients
               WHERE campo = ANY($1::text[]) AND tenant_id = $2 AND user_id = $3 ${ordGuard}`;
      params = [campos, req.user.tenant_id, req.user.user_id];
    } else {
      if (!clientId) return res.status(400).json({ error: 'clientId richiesto' });
      query = `DELETE FROM clients
               WHERE campo = ANY($1::text[]) AND argument = $2 AND tenant_id = $3 AND user_id = $4 ${ordGuard}`;
      params = [campos, clientId, req.user.tenant_id, req.user.user_id];
    }
    const result = await db.query(query, params);
    res.json({ deleted: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rinomina di campi custom (ordinamento >= 100). renames = [{ old, new }, ...].
// scope = 'all' -> su tutti i clienti del tenant/utente; 'this' -> solo sul cliente indicato.
app.post('/api/:source(settings|clients)/rename-fields', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const renames = (req.body && req.body.renames) || [];
    const scope = (req.body && req.body.scope) || 'all';
    const clientId = ((req.body && req.body.clientId) || '').trim();
    if (!Array.isArray(renames) || renames.length === 0) {
      return res.status(400).json({ error: 'Nessuna rinomina' });
    }
    const isAdmin = Number(req.user.id_roles) === 1;
    if (source === 'settings') {
      if (!clientId) return res.status(400).json({ error: 'argomento richiesto' });
      if (scope === 'all-tenants' && !isAdmin) {
        return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
      }
    } else if (scope === 'this' && !clientId) {
      return res.status(400).json({ error: 'clientId richiesto' });
    }
    // Guard: gli utenti normali rinominano solo i campi custom "(*)"; l'admin (id_roles=1)
    // rinomina TUTTI i campi (custom e non).
    const custGuard = isAdmin ? '' : " AND campo LIKE '(*)%'";
    let updated = 0;
    for (const rn of renames) {
      const oldName = ((rn && rn.old) || '').trim();
      let newName = ((rn && rn.new) || '').trim();
      // Solo i campi custom mantengono il prefisso "(*)": se il campo originale era custom
      // e il prefisso è stato tolto, reinseriscilo. I campi standard restano senza prefisso.
      const wasCustom = oldName.startsWith('(*)');
      if (wasCustom && newName && !newName.startsWith('(*)')) newName = '(*) ' + newName;
      if (!oldName || !newName || oldName === newName) continue;
      let query, params;
      if (source === 'settings') {
        // Impostazioni: scope tenant, per argomento (tutti gli utenti del/dei tenant)
        if (scope === 'all-tenants') {
          query = `UPDATE settings SET campo = $1 WHERE campo = $2 AND argument = $3${custGuard}`;
          params = [newName, oldName, clientId];
        } else {
          query = `UPDATE settings SET campo = $1 WHERE campo = $2 AND argument = $3 AND tenant_id = $4${custGuard}`;
          params = [newName, oldName, clientId, req.user.tenant_id];
        }
      } else if (scope === 'this') {
        query = `UPDATE clients SET campo = $1
                 WHERE campo = $2 AND argument = $3 AND tenant_id = $4 AND user_id = $5${custGuard}`;
        params = [newName, oldName, clientId, req.user.tenant_id, req.user.user_id];
      } else {
        query = `UPDATE clients SET campo = $1
                 WHERE campo = $2 AND tenant_id = $3 AND user_id = $4${custGuard}`;
        params = [newName, oldName, req.user.tenant_id, req.user.user_id];
      }
      const result = await db.query(query, params);
      updated += result.rowCount;
    }
    res.json({ updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Riordino/spostamento campi (drag&drop): aggiorna ordinamento + layout_col per campo.
// items = [{ campo, ordinamento, layout_col }, ...].
// scope = 'this-tenant' (solo il tenant del login) | 'all-tenants' (tutti, solo admin id_roles=1).
app.post('/api/:source(settings|clients)/reorder-fields', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const argument = ((req.body && req.body.argument) || '').trim();
    const scope = (req.body && req.body.scope) || 'this-tenant';
    const items = (req.body && req.body.items) || [];
    if (!argument) return res.status(400).json({ error: 'argument richiesto' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Nessun elemento' });
    const isAdmin = Number(req.user.id_roles) === 1;
    if (scope === 'all-tenants' && !isAdmin) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
    let updated = 0;
    for (const it of items) {
      const campo = ((it && it.campo) || '').trim();
      if (!campo) continue;
      const ord = (it.ordinamento == null || it.ordinamento === '') ? null : parseInt(it.ordinamento, 10);
      const lay = (it.layout_col == null || it.layout_col === '') ? null : parseInt(it.layout_col, 10);
      let query, params;
      if (scope === 'all-tenants') {
        query = `UPDATE "${source}" SET ordinamento = $1, layout_col = $2 WHERE argument = $3 AND campo = $4`;
        params = [ord, lay, argument, campo];
      } else {
        query = `UPDATE "${source}" SET ordinamento = $1, layout_col = $2 WHERE argument = $3 AND campo = $4 AND tenant_id = $5`;
        params = [ord, lay, argument, campo, req.user.tenant_id];
      }
      const r = await db.query(query, params);
      updated += r.rowCount;
    }
    res.json({ updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// tipo_valore = 15: opzioni per un menu a discesa. Il campo (fieldId) contiene:
//   tabella  -> tabella del DB da cui leggere
//   colonna  -> colonna i cui valori popolano l'elenco (DISTINCT)
//   VariabDB -> sintassi SQL (condizione WHERE) aggiunta alla query di selezione
// Applica sempre i filtri di visibilità tenant_id/user_id (se presenti sulla tabella target).
// NB: VariabDB è sintassi SQL configurata da un utente privilegiato in fase di definizione
//     del campo (non è input dell'utente finale): viene aggiunta come condizione AND.
app.get('/api/:source(settings|clients)/field-options', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    if (!fieldId) return res.status(400).json({ error: 'fieldId richiesto' });
    const f = await db.query(
      `SELECT tabella, colonna, "VariabDB" AS variabdb, valore3 FROM "${source}"
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const tabella = f.rows[0].tabella;
    const colonna = f.rows[0].colonna;
    const variab = (f.rows[0].variabdb || '').trim();
    const mode = (f.rows[0].valore3 == null) ? null : Number(f.rows[0].valore3); // valore3 = modalità
    if (!tabella || !colonna) return res.status(400).json({ error: 'tabella/colonna non impostate sul campo' });
    assertValidIdentifier(tabella);
    assertValidIdentifier(colonna);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const conds = [];
    const params = [];
    if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (cols.has('user_id')) { params.push(req.user.user_id); conds.push(`user_id = $${params.length}`); }
    // VariabDB contiene sempre l'operatore iniziale (AND/OR) e viene aggiunta così com'è
    // dopo i filtri di visibilità. Se non ci sono filtri precedenti, l'operatore iniziale
    // viene rimosso per non generare "WHERE AND ...".
    let where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const variabTrim = (variab || '').trim();
    if (variabTrim) {
      where = where
        ? `${where} ${variabTrim}`
        : 'WHERE ' + variabTrim.replace(/^\s*(and|or)\s+/i, '');
    }
    // Restituisce id + valore per ogni riga (l'id serve per l'eventuale update/rinomina).
    const result = await db.query(
      `SELECT id, "${colonna}" AS value FROM "${tabella}" ${where} ORDER BY "${colonna}" NULLS LAST LIMIT 500`,
      params
    );
    res.json({ tabella, colonna, mode, items: stripSensitive(result.rows) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// tipo_valore = 15: esegue l'istruzione configurata in function_db sulla riga selezionata.
// body: { fieldId (campo settings/clients), selectedId (id della riga scelta nell'elenco) }.
// Match function_db: cod_istruzione = <campo>.valore3 ; funzione = <campo>.campo (se valorizzata).
// Guardia: se valore3 = 1 -> istruzione deve essere 'delete'. Ogni riga function_db esegue:
//   DELETE FROM fun_tabella WHERE fun_colonna = selectedId
//     [AND <fun_tenant> = tenant login] [AND <fun_user> = user login]
// dove fun_tenant/fun_user sono NOMI DI COLONNA della tabella target. Tutto in transazione.
app.post('/api/:source(settings|clients)/execute-function', requireAuth, async (req, res) => {
  const source = req.params.source;
  const fieldId = ((req.body && req.body.fieldId) || '').trim();
  const selectedId = ((req.body && req.body.selectedId) || '').trim();
  if (!fieldId || !selectedId) return res.status(400).json({ error: 'fieldId e selectedId richiesti' });
  try {
    // 1) La "funzione selezionata" (campo tipo 15) del login
    const f = await db.query(
      `SELECT campo, valore3 FROM "${source}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const campo = f.rows[0].campo;
    const cod = (f.rows[0].valore3 == null) ? null : Number(f.rows[0].valore3);
    if (!Number.isFinite(cod)) return res.status(400).json({ error: 'valore3 (istruzione) non impostato sul campo' });

    // 2) Righe function_db che soddisfano i filtri
    const conds = ['cod_istruzione = $1'];
    const params = [cod];
    conds.push('(funzione IS NULL OR funzione = $' + (params.push(campo)) + ')');
    if (cod === 1) conds.push("istruzione = 'delete'"); // guardia di sicurezza
    const fdb = await db.query(`SELECT * FROM function_db WHERE ${conds.join(' AND ')}`, params);
    if (fdb.rows.length === 0) return res.json({ deleted: 0, executed: 0 });

    // 3) Esecuzione in transazione (tutte o nessuna)
    const isAdmin = isAdminUser(req);
    const client = await db.connect();
    let deleted = 0, executed = 0;
    try {
      await client.query('BEGIN');
      for (const r of fdb.rows) {
        const istr = (r.istruzione || '').toLowerCase();
        if (istr !== 'delete') continue; // per ora è supportata solo la delete
        const tab = r.fun_tabella, col = r.fun_colonna;
        if (!tab || !col) continue;
        assertValidIdentifier(tab);
        assertValidIdentifier(col);
        if (!(await isManagedTable(tab))) throw Object.assign(new Error('Tabella non gestita: ' + tab), { statusCode: 400 });
        const tcols = await getTableColumns(tab);
        const parts = [`"${col}" = $1`];
        const p = [selectedId];
        // Filtro tenant: usa la colonna indicata in fun_tenant; in mancanza, forza tenant_id
        // per i non-admin (difesa contro cancellazioni cross-tenant accidentali).
        let tenCol = (r.fun_tenant || '').trim();
        if (!tenCol && tcols.has('tenant_id') && !isAdmin) tenCol = 'tenant_id';
        if (tenCol) { assertValidIdentifier(tenCol); p.push(req.user.tenant_id); parts.push(`"${tenCol}" = $${p.length}`); }
        // Filtro user: come sopra
        let usrCol = (r.fun_user || '').trim();
        if (!usrCol && tcols.has('user_id') && !isAdmin) usrCol = 'user_id';
        if (usrCol) { assertValidIdentifier(usrCol); p.push(req.user.user_id); parts.push(`"${usrCol}" = $${p.length}`); }
        const q = `DELETE FROM "${tab}" WHERE ${parts.join(' AND ')}`;
        const rr = await client.query(q, p);
        deleted += rr.rowCount;
        executed++;
      }
      await client.query('COMMIT');
      res.json({ deleted, executed });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(e.statusCode || 500).json({ error: e.message });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// tipo_valore = 20: elenco valori da una tabella esterna. Il campo (fieldId) contiene
// tabella (clients.tabella) e colonna (clients.colonna). Restituisce { id, value } per
// ogni riga, filtrando per tenant_id, user_id e id_cliente (se presenti nella tabella).
app.get('/api/:source(settings|clients)/linked-list', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const clientId = ((req.query && req.query.clientId) || '').trim();
    if (!fieldId) {
      return res.status(400).json({ error: 'fieldId richiesto' });
    }
    const f = await db.query(
      `SELECT tabella, colonna FROM "${source}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const tabella = f.rows[0].tabella;
    const colonna = f.rows[0].colonna;
    if (!tabella || !colonna) return res.status(400).json({ error: 'tabella/colonna non impostate sul campo' });
    assertValidIdentifier(tabella);
    assertValidIdentifier(colonna);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const conds = [];
    const params = [];
    if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (cols.has('user_id')) { params.push(req.user.user_id); conds.push(`user_id = $${params.length}`); }
    if (cols.has('id_cliente') && clientId) { params.push(clientId); conds.push(`id_cliente = $${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // Modalità "organigramma": se richiesta e la tabella ha "responsabile",
    // aggiunge le colonne per costruire l'albero gerarchico (responsabile, qualifica, bu).
    const tree = ((req.query && req.query.tree) === '1' || (req.query && req.query.tree) === 'true');
    const treeReady = tree && cols.has('responsabile');
    const extraSel = treeReady
      ? [
          ', "responsabile" AS responsabile',
          cols.has('qualifica') ? ', "qualifica" AS qualifica' : '',
          cols.has('bu') ? ', "bu" AS bu' : ''
        ].join('')
      : '';
    const result = await db.query(
      `SELECT id, "${colonna}" AS value${extraSel} FROM "${tabella}" ${where} ORDER BY "${colonna}" NULLS LAST LIMIT 200`,
      params
    );
    res.json({ tabella, colonna, tree: treeReady, items: stripSensitive(result.rows) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// tipo_valore = 20: dettaglio completo (tutti i valori) di una riga della tabella esterna,
// filtrato per tenant_id, user_id e id_cliente.
app.get('/api/:source(settings|clients)/linked-row', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const clientId = ((req.query && req.query.clientId) || '').trim();
    const rowId = ((req.query && req.query.rowId) || '').trim();
    if (!fieldId || !rowId) {
      return res.status(400).json({ error: 'fieldId e rowId richiesti' });
    }
    const f = await db.query(
      `SELECT tabella FROM "${source}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const tabella = f.rows[0].tabella;
    if (!tabella) return res.status(400).json({ error: 'tabella non impostata sul campo' });
    assertValidIdentifier(tabella);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const conds = ['id = $1'];
    const params = [rowId];
    if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (cols.has('user_id')) { params.push(req.user.user_id); conds.push(`user_id = $${params.length}`); }
    if (cols.has('id_cliente') && clientId) { params.push(clientId); conds.push(`id_cliente = $${params.length}`); }
    const result = await db.query(
      `SELECT * FROM "${tabella}" WHERE ${conds.join(' AND ')} LIMIT 1`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
    res.json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// tipo_valore = 20: aggiunge una riga alla tabella collegata, impostando in automatico
// tenant_id, user_id e id_cliente (dal login + cliente). I valori generati/di sistema
// vengono ignorati.
app.post('/api/:source(settings|clients)/linked-row', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.body && req.body.fieldId) || '').trim();
    const clientId = ((req.body && req.body.clientId) || '').trim();
    const values = (req.body && req.body.values) || {};
    if (!fieldId) {
      return res.status(400).json({ error: 'fieldId richiesto' });
    }
    const f = await db.query(
      `SELECT tabella FROM "${source}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const tabella = f.rows[0].tabella;
    if (!tabella) return res.status(400).json({ error: 'tabella non impostata sul campo' });
    assertValidIdentifier(tabella);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const generated = await getGeneratedColumns(tabella);
    const managedByServer = new Set(['id', 'tenant_id', 'user_id', 'id_cliente', 'created_at', 'updated_at', 'created_by']);
    const data = {};
    for (const [k, v] of Object.entries(values)) {
      if (cols.has(k) && !generated.has(k) && !managedByServer.has(k)) {
        data[k] = v === '' ? null : v;
      }
    }
    // Colonne di scoping impostate dal server (mai dal client)
    if (cols.has('tenant_id')) data.tenant_id = req.user.tenant_id;
    if (cols.has('user_id')) data.user_id = req.user.user_id;
    if (cols.has('id_cliente') && clientId) data.id_cliente = clientId;

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) return res.status(400).json({ error: 'Nessun dato da inserire' });
    const params = columns.map((c) => data[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quoted = columns.map((c) => `"${c}"`).join(', ');
    const result = await db.query(
      `INSERT INTO "${tabella}" (${quoted}) VALUES (${placeholders}) RETURNING *`,
      params
    );
    res.status(201).json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// tipo_valore = 20: elimina una riga della tabella collegata, filtrando per
// tenant_id, user_id e id_cliente.
app.delete('/api/:source(settings|clients)/linked-row', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const clientId = ((req.query && req.query.clientId) || '').trim();
    const rowId = ((req.query && req.query.rowId) || '').trim();
    if (!fieldId || !rowId) {
      return res.status(400).json({ error: 'fieldId e rowId richiesti' });
    }
    const f = await db.query(
      `SELECT tabella FROM "${source}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const tabella = f.rows[0].tabella;
    if (!tabella) return res.status(400).json({ error: 'tabella non impostata sul campo' });
    assertValidIdentifier(tabella);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const conds = ['id = $1'];
    const params = [rowId];
    if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (cols.has('user_id')) { params.push(req.user.user_id); conds.push(`user_id = $${params.length}`); }
    if (cols.has('id_cliente') && clientId) { params.push(clientId); conds.push(`id_cliente = $${params.length}`); }
    const result = await db.query(
      `DELETE FROM "${tabella}" WHERE ${conds.join(' AND ')} RETURNING id`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
    res.json({ deleted: result.rowCount });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Dettaglio delle righe (settings o clients) per un dato "argument", filtrate per
// tenant e utente del token. Il :source è vincolato a settings|clients dalla route.
app.get('/api/:source(settings|clients)/details', requireAuth, async (req, res) => {
  try {
    const table = req.params.source;
    const { argument } = req.query;
    if (!argument) {
      return res.status(400).json({ error: 'Parametro argument richiesto' });
    }
    // Filtro per privilegio: mostra solo i campi il cui id_roles >= id_roles dell'utente
    // (id_roles più basso = più privilegi), oppure id_roles NULL = nessuna restrizione.
    const uid = Number(req.user.id_roles);
    const roleLevel = Number.isFinite(uid) ? uid : 9999;
    const result = await db.query(
      `SELECT * FROM "${table}"
       WHERE argument = $1 AND tenant_id = $2 AND user_id = $3
         AND (id_roles IS NULL OR id_roles >= $4)
       ORDER BY ordinamento NULLS LAST, campo`,
      [argument, req.user.tenant_id, req.user.user_id, roleLevel]
    );

    // Per i campi di tipo 4 risolve il valore leggendolo dalla tabella/colonna di
    // riferimento, sulla riga del login (WHERE su user_id/tenant_id o PK id).
    const rows = result.rows;
    for (const row of rows) {
      if (Number(row.tipo_valore) === 4 && row.tabella && row.colonna) {
        try {
          assertValidIdentifier(row.tabella);
          assertValidIdentifier(row.colonna);
          const keys = await referenceKeys(row.tabella, req.user);
          const where = keys.length
            ? 'WHERE ' + keys.map((k, i) => `"${k.col}" = $${i + 1}`).join(' AND ')
            : '';
          const ref = await db.query(
            `SELECT "${row.colonna}" AS v FROM "${row.tabella}" ${where} LIMIT 1`,
            keys.map(k => k.val)
          );
          row.resolved_value = ref.rows[0] ? ref.rows[0].v : null;
        } catch (e) {
          row.resolved_value = null;
        }
      }
    }

    res.json(stripSensitive(rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Salvataggio di un campo di tipo 4 (riferimento a un'altra tabella) per settings o clients.
// Prima di scrivere il valore nella tabella di riferimento, verifica che non esista già
// nella colonna <colonna> della tabella <tabella> indicate nella riga (settings/clients).
app.put('/api/:source(settings|clients)/:id/reference-value', requireAuth, async (req, res) => {
  try {
    const table = req.params.source;
    const { id } = req.params;
    const { value } = req.body;

    // Carica la riga (settings/clients) dell'utente per leggere tabella/colonna
    const s = await db.query(
      `SELECT tabella, colonna FROM "${table}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, req.user.tenant_id, req.user.user_id]
    );
    if (s.rows.length === 0) {
      return res.status(404).json({ error: 'Impostazione non trovata' });
    }

    const { tabella, colonna } = s.rows[0];
    if (!tabella || !colonna) {
      return res.status(400).json({ error: 'Tabella o colonna non definite per questa impostazione' });
    }

    // Valida gli identificatori prima di interpolarli (anti SQL injection)
    assertValidIdentifier(tabella);
    assertValidIdentifier(colonna);

    // Individua la riga del login nella tabella di riferimento
    const keys = await referenceKeys(tabella, req.user);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Impossibile identificare la riga di riferimento (mancano user_id/tenant_id)' });
    }
    const whereConds = keys.map((k, i) => `"${k.col}" = $${i + 2}`).join(' AND ');
    const keyValues = keys.map(k => k.val);

    // Controllo di unicità: il valore non deve già esistere in un'ALTRA riga di
    // tabella.colonna (la riga corrente del login è esclusa dal controllo).
    if (value !== null && value !== undefined && value !== '') {
      const dup = await db.query(
        `SELECT 1 FROM "${tabella}" WHERE "${colonna}" = $1 AND NOT (${whereConds}) LIMIT 1`,
        [value, ...keyValues]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'Valore già esistente nel database' });
      }
    }

    // Scrive il valore nella tabella di riferimento, sulla riga del login
    const upd = await db.query(
      `UPDATE "${tabella}" SET "${colonna}" = $1 WHERE ${whereConds} RETURNING "${colonna}" AS v`,
      [value === '' ? null : value, ...keyValues]
    );
    if (upd.rows.length === 0) {
      return res.status(404).json({ error: 'Riga di riferimento non trovata' });
    }

    res.json({ message: 'Salvato', value: upd.rows[0].v });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ==========================================
// GDPR — Diritti dell'interessato (art. 15/17/20)
// ==========================================

// Export dei dati personali dell'utente autenticato (accesso/portabilità).
// Restituisce un JSON scaricabile con tutti i dati riferiti al suo user_id.
app.get('/api/gdpr/export', requireAuth, async (req, res) => {
  try {
    const uid = req.user.user_id;
    const data = {};
    const q = async (label, sql, params) => {
      try { const r = await db.query(sql, params); data[label] = stripSensitive(r.rows); }
      catch (e) { data[label] = { nota: 'non disponibile', dettaglio: e.message }; }
    };
    await q('profilo_utente', 'SELECT * FROM users WHERE id = $1', [uid]); // Projexa: nome/cognome
    // Dati di autenticazione (email/scadenza) da Projexa-Auth
    try {
      const ar = await authDb.query('SELECT email, scadenza, created_at FROM users WHERE id = $1', [uid]);
      data.autenticazione = stripSensitive(ar.rows);
    } catch (e) { data.autenticazione = { nota: 'non disponibile', dettaglio: e.message }; }
    await q('organizzazioni', 'SELECT * FROM user_tenants WHERE user_id = $1', [uid]);
    await q('ruoli', 'SELECT * FROM user_roles WHERE user_id = $1', [uid]);
    await q('impostazioni', 'SELECT * FROM settings WHERE user_id = $1', [uid]);
    await q('clienti', 'SELECT * FROM clients WHERE user_id = $1', [uid]);
    await q('contatti', 'SELECT * FROM contacts WHERE user_id = $1', [uid]);
    const payload = {
      informativa: 'Estrazione dei dati personali associati al tuo account Projexa (art. 15 e 20 GDPR).',
      generato_il: new Date().toISOString(),
      utente_id: uid, tenant_id: req.user.tenant_id,
      dati: data
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="miei_dati_projexa.json"');
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancellazione/anonimizzazione dell'account (diritto all'oblio, art. 17).
// Anonimizza il profilo (nome/cognome/email/password) e revoca gli accessi. I dati
// aziendali (clienti/contatti) restano al titolare del trattamento (l'organizzazione).
// Richiede { confirm: true } nel body per evitare cancellazioni accidentali.
app.delete('/api/gdpr/erase', requireAuth, async (req, res) => {
  try {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ error: "Conferma richiesta: inviare { confirm: true }" });
    }
    const uid = req.user.user_id;
    const cols = await getTableColumns('users');
    const anon = 'utente-rimosso-' + String(uid).replace(/-/g, '').slice(0, 10);
    const sets = [], params = [];
    const setIf = (col, val) => { if (cols.has(col)) { params.push(val); sets.push(`"${col}" = $${params.length}`); } };
    setIf('name', 'Utente'); setIf('cognome', 'Rimosso'); setIf('nome', 'Utente');
    setIf('email', anon + '@rimosso.invalid');
    setIf('password_hash', null); setIf('password', null);
    setIf('telefono', null); setIf('cellulare', null); setIf('avatar', null);
    if (sets.length) { params.push(uid); await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params); }
    // Anonimizza anche il record di autenticazione su Projexa-Auth (email + password inutilizzabile):
    // così l'utente non può più autenticarsi (diritto all'oblio).
    try {
      await authDb.query(
        "UPDATE users SET email = $1, password_hash = 'DISABLED', updated_at = NOW() WHERE id = $2",
        [anon + '@rimosso.invalid', uid]
      );
    } catch (e) { /* ignore */ }
    // Revoca gli accessi (l'utente non potrà più autenticarsi)
    try { await db.query('DELETE FROM user_tenants WHERE user_id = $1', [uid]); } catch (e) { /* ignore */ }
    try { await db.query('DELETE FROM user_roles WHERE user_id = $1', [uid]); } catch (e) { /* ignore */ }
    res.json({ message: 'Account anonimizzato e accessi revocati. Verrai disconnesso.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// SQL EDITOR ENDPOINTS
// ==========================================
//
// ATTENZIONE: questi endpoint eseguono SQL arbitrario sul database.
// Sono ora protetti da requireAuth, ma restano uno strumento potente:
// qualsiasi utente autenticato può leggere/modificare dati di TUTTI i tenant
// (il raw SQL non può essere isolato per tenant). Andrebbero riservati a un
// ruolo amministratore. Per disabilitarli del tutto in produzione imposta
// la variabile d'ambiente DISABLE_SQL_EDITOR=true.

const SQL_EDITOR_ENABLED = process.env.DISABLE_SQL_EDITOR !== 'true';

// Transazioni attive per utente: tokenId -> client dedicato del pool.
// Fondamentale usare un singolo client per la transazione: BEGIN/COMMIT/ROLLBACK
// su un pool finirebbero su connessioni diverse e non funzionerebbero.
const activeTransactions = new Map();

// Identifica l'utente in modo stabile (dal JWT verificato) per legare la transazione.
function getTokenId(req) {
  return req.user?.user_id || req.user?.email || 'unknown';
}

function ensureSqlEditorEnabled(req, res, next) {
  if (!SQL_EDITOR_ENABLED) {
    return res.status(403).json({ error: 'SQL editor disabilitato' });
  }
  next();
}

// Execute SQL Query
app.post('/api/sql/execute', requireAuth, requireAdmin, ensureSqlEditorEnabled, async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) {
      return res.status(400).json({ error: 'SQL query required' });
    }

    const tokenId = getTokenId(req);

    // Client su cui eseguire: quello della transazione aperta, se esiste.
    let client = activeTransactions.get(tokenId);

    // Se non c'è una transazione ed è una query di modifica, aprine una
    // su un client dedicato preso dal pool.
    if (!client && /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)/i.test(sql)) {
      client = await db.connect();
      await client.query('BEGIN');
      activeTransactions.set(tokenId, client);
    }

    // Esegui sul client della transazione se presente, altrimenti sul pool.
    const runner = client || db;
    const result = await runner.query(sql);

    res.json({
      rows: result.rows,
      columns: result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] || {}),
      affectedRows: result.rowCount,
      transactionActive: activeTransactions.has(tokenId)
    });
  } catch (error) {
    console.error('SQL Error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Commit Transaction
app.post('/api/sql/commit', requireAuth, requireAdmin, ensureSqlEditorEnabled, async (req, res) => {
  const tokenId = getTokenId(req);
  const client = activeTransactions.get(tokenId);

  if (!client) {
    return res.status(400).json({ error: 'No active transaction' });
  }

  try {
    await client.query('COMMIT');
    res.json({ message: 'Transaction committed successfully' });
  } catch (error) {
    console.error('Commit Error:', error.message);
    res.status(400).json({ error: error.message });
  } finally {
    activeTransactions.delete(tokenId);
    client.release();
  }
});

// Rollback Transaction
app.post('/api/sql/rollback', requireAuth, requireAdmin, ensureSqlEditorEnabled, async (req, res) => {
  const tokenId = getTokenId(req);
  const client = activeTransactions.get(tokenId);

  if (!client) {
    return res.status(400).json({ error: 'No active transaction' });
  }

  try {
    await client.query('ROLLBACK');
    res.json({ message: 'Transaction rolled back successfully' });
  } catch (error) {
    console.error('Rollback Error:', error.message);
    res.status(400).json({ error: error.message });
  } finally {
    activeTransactions.delete(tokenId);
    client.release();
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
