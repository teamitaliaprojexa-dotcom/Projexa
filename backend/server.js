import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import db from './config/database.js';
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
app.get('/api/data/:table', requireAuth, async (req, res) => {
  try {
    const tableName = assertValidIdentifier(req.params.table);

    if (!(await isManagedTable(tableName))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Caso speciale: la tabella "tenants" non ha una colonna tenant_id.
    // Un non-admin deve vedere SOLO il proprio tenant (la riga con id = tenant del login),
    // così nell'elenco/select dei tenant non compaiono gli altri. Gli admin li vedono tutti.
    if (tableName === 'tenants' && !isAdminUser(req)) {
      const result = await db.query(
        'SELECT * FROM tenants WHERE id = $1 LIMIT 100',
        [req.user.tenant_id]
      );
      return res.json(stripSensitive(result.rows));
    }

    // Isolamento multi-tenant: se la tabella ha una colonna tenant_id,
    // restituisce solo le righe del tenant dell'utente autenticato.
    // Gli admin vedono tutti i tenant.
    const columns = await getTableColumns(tableName);
    if (columns.has('tenant_id') && !isAdminUser(req)) {
      const result = await db.query(
        `SELECT * FROM "${tableName}" WHERE tenant_id = $1 LIMIT 100`,
        [req.user.tenant_id]
      );
      return res.json(stripSensitive(result.rows));
    }

    const result = await db.query(`SELECT * FROM "${tableName}" LIMIT 100`);
    res.json(stripSensitive(result.rows));
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

    const query = `UPDATE "${tableName}" SET ${updates}, updated_at = CURRENT_TIMESTAMP WHERE ${whereClause} RETURNING *`;
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

          // Stringhe vuote -> NULL; scarta le colonne non presenti nella tabella
          for (const k of Object.keys(data)) {
            if (data[k] === '') data[k] = null;
            if (!tableColumns.has(k)) delete data[k];
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

// Elenco clienti (valore2) per l'utente + tenant del token di login.
// Equivale a: SELECT DISTINCT valore2 FROM clients
//   WHERE argument='Cliente' AND campo='Cliente' AND tenant_id=? AND user_id=?
app.get('/api/clients/names', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT valore2
       FROM clients
       WHERE argument = 'Cliente' AND campo = 'Cliente'
         AND tenant_id = $1 AND user_id = $2 AND valore2 IS NOT NULL
       ORDER BY valore2`,
      [req.user.tenant_id, req.user.user_id]
    );
    res.json(result.rows.map(r => r.valore2));
  } catch (error) {
    res.status(500).json({ error: error.message });
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
app.post('/api/sql/execute', requireAuth, ensureSqlEditorEnabled, async (req, res) => {
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
app.post('/api/sql/commit', requireAuth, ensureSqlEditorEnabled, async (req, res) => {
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
app.post('/api/sql/rollback', requireAuth, ensureSqlEditorEnabled, async (req, res) => {
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
