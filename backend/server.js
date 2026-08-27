import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import db from './config/database.js';
import authDb from './config/authDatabase.js';
import licenseDb from './config/licenseDatabase.js';
import notifDb from './config/notifDatabase.js';
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

// Rate-limit anti abuso sulla registrazione: max 5 registrazioni per IP ogni 60 minuti.
const registerAttempts = new Map(); // ip -> { count, first }
function registerRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now(), windowMs = 60 * 60 * 1000, max = 5;
  const rec = registerAttempts.get(ip);
  if (!rec || now - rec.first > windowMs) { registerAttempts.set(ip, { count: 1, first: now }); return next(); }
  rec.count += 1;
  if (rec.count > max) return res.status(429).json({ error: 'Troppe registrazioni da questo indirizzo. Riprova più tardi.' });
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
app.use('/api/auth/register', registerRateLimit);
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

// Sceglie il DB di destinazione in base all'header X-Target-DB.
// Progetti Neon supportati: main=Projexa, auth=Projexa-Auth, lic=Projexa-Lic, notif=Projexa-Notif.
// Usato da database-viewer e sql-editor per leggere/scrivere sul progetto selezionato.
const DB_POOLS = { main: db, auth: authDb, lic: licenseDb, notif: notifDb };
function pickDbKey(req) {
  const k = (req && req.get && req.get('x-target-db')) || '';
  return Object.prototype.hasOwnProperty.call(DB_POOLS, k) ? k : 'main';
}
function pickDb(req) { return DB_POOLS[pickDbKey(req)]; }

// Cache dei metadati colonne per (db, tabella). Il pool e la chiave sono opzionali:
// default = Projexa (db), così gli altri endpoint dell'app restano invariati.
const tableColumnsCache = new Map();

async function getTableColumns(tableName, pool = db, dbKey = 'main') {
  const ck = dbKey + ':' + tableName;
  if (tableColumnsCache.has(ck)) {
    return tableColumnsCache.get(ck);
  }
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  const columns = new Set(result.rows.map((r) => r.column_name));
  tableColumnsCache.set(ck, columns);
  return columns;
}

// Colonne GENERATE (GENERATED ALWAYS AS ... STORED): non sono scrivibili, vanno
// escluse da INSERT/UPDATE altrimenti Postgres rifiuta la query. Cache per (db, tabella).
const generatedColumnsCache = new Map();

async function getGeneratedColumns(tableName, pool = db, dbKey = 'main') {
  const ck = dbKey + ':' + tableName;
  if (generatedColumnsCache.has(ck)) {
    return generatedColumnsCache.get(ck);
  }
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'ALWAYS'`,
    [tableName]
  );
  const columns = new Set(result.rows.map((r) => r.column_name));
  generatedColumnsCache.set(ck, columns);
  return columns;
}

// Verifica che la tabella richiesta sia gestita (presente in table_structures del pool scelto)
// oppure sia la tabella di sistema table_structures. Restituisce true/false.
async function isManagedTable(tableName, pool = db) {
  if (tableName === 'table_structures') return true;
  const tableCheck = await pool.query(
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
// (usata dai campi settings/clients/projects di tipo 4). Usa le colonne user_id/tenant_id
// se presenti, altrimenti la PK id per le tabelle users (= utente del login) e tenants
// (= tenant del login). Il parametro "context" aggiunge filtri ulteriori quando il campo
// tipo 4 vive dentro "clients" (client_id) o dentro "projects" (client_id + project_id),
// ma solo se la tabella di riferimento possiede effettivamente quelle colonne.
async function referenceKeys(tabella, user, context = {}) {
  const cols = await getTableColumns(tabella);
  const keys = [];
  if (cols.has('user_id')) keys.push({ col: 'user_id', val: user.user_id });
  else if (tabella === 'users') keys.push({ col: 'id', val: user.user_id });
  if (cols.has('tenant_id')) keys.push({ col: 'tenant_id', val: user.tenant_id });
  else if (tabella === 'tenants') keys.push({ col: 'id', val: user.tenant_id });
  if (context.clientId && cols.has('client_id')) keys.push({ col: 'client_id', val: context.clientId });
  if (context.projectId && cols.has('project_id')) keys.push({ col: 'project_id', val: context.projectId });
  return keys;
}

// Risolve le opzioni di lookup_values (tipi 9/10) con ricerca a cascata:
// 1) tenant_id = login E user_id = login (custom personale)
// 2) tenant_id = login E user_id IS NULL (custom di tenant)
// 3) tenant_id IS NULL E user_id IS NULL (standard, globale)
// Il primo livello con risultati vince. isCustom = true per i livelli 1 e 2.
async function resolveLookupValues(tenantId, userId, tipoValore, campoRaw, campoStripped, roleLevel) {
  const baseWhere = `tipo_valore = $1 AND (nome_campo = $2 OR nome_campo = $3)
    AND (id_roles IS NULL OR id_roles = '' OR (id_roles ~ '^[0-9]+$' AND id_roles::int >= $4))
    AND (data_inizio IS NULL OR data_inizio <= CURRENT_DATE)
    AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`;
  const baseParams = [tipoValore, campoRaw, campoStripped, roleLevel];

  const attempts = [
    { extra: 'tenant_id = $5 AND user_id = $6', extraParams: [tenantId, userId], custom: true },
    { extra: 'tenant_id = $5 AND user_id IS NULL', extraParams: [tenantId], custom: true },
    { extra: 'tenant_id IS NULL AND user_id IS NULL', extraParams: [], custom: false }
  ];
  for (const attempt of attempts) {
    const params = [...baseParams, ...attempt.extraParams];
    const r = await db.query(
      `SELECT valore FROM lookup_values WHERE ${baseWhere} AND ${attempt.extra} ORDER BY ordinamento NULLS LAST, valore`,
      params
    );
    if (r.rows.length > 0) return { rows: r.rows, isCustom: attempt.custom };
  }
  return { rows: [], isCustom: false };
}

// Etichette delle pagine HTML. Per ogni valore usa la configurazione piu'
// specifica disponibile, con questa precedenza:
// tenant+utente, tenant, utente globale, configurazione globale.
app.get('/api/page-labels', requireAuth, async (req, res) => {
  try {
    const requestedLanguage = String(req.query.lang || 'IT').trim().toUpperCase();
    const language = /^[A-Z]{2,3}$/.test(requestedLanguage) ? requestedLanguage : 'IT';
    const result = await db.query(
      `WITH ranked_labels AS (
         SELECT valore, new_valore,
                ROW_NUMBER() OVER (
                  PARTITION BY valore
                  ORDER BY CASE
                    WHEN tenant_id = $1 AND user_id = $2 THEN 4
                    WHEN tenant_id = $1 AND user_id IS NULL THEN 3
                    WHEN tenant_id IS NULL AND user_id = $2 THEN 2
                    ELSE 1
                  END DESC,
                  (UPPER(COALESCE(id_lingua, '')) = $3) DESC,
                  id::text DESC
                ) AS priority
         FROM set_label
         WHERE da_pagina IS TRUE
           AND (tenant_id = $1 OR tenant_id IS NULL)
           AND (user_id = $2 OR user_id IS NULL)
           AND (id_lingua IS NULL OR UPPER(id_lingua) = $3)
           AND (data_inizio IS NULL OR data_inizio <= CURRENT_DATE)
           AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
       )
       SELECT valore, new_valore
       FROM ranked_labels
       WHERE priority = 1
       ORDER BY valore`,
      [req.user.tenant_id, req.user.user_id, language]
    );
    res.json({ labels: result.rows });
  } catch (error) {
    console.error('[PAGE LABELS]', error);
    res.status(500).json({ error: error.message });
  }
});

const DASHBOARD_TASK_HIDDEN_COLUMNS = new Set([
  'id', 'tenant_id', 'user_id', 'created_by', 'created_at',
  'data_inizio', 'scadenza', 'id_roles', 'id_roles_write'
]);
const DASHBOARD_TASK_READONLY_COLUMNS = new Set(['updated_at']);

async function getDashboardTaskMetadata() {
  const result = await db.query(
    `SELECT column_name, data_type, udt_name, ordinal_position,
            is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tasks'
     ORDER BY ordinal_position`
  );
  return result.rows;
}

function dashboardTaskInput(body, metadata) {
  const source = body && typeof body.values === 'object' && body.values !== null
    ? body.values : {};
  const allowed = new Set(metadata
    .map(column => column.column_name)
    .filter(column => !DASHBOARD_TASK_HIDDEN_COLUMNS.has(column)
      && !DASHBOARD_TASK_READONLY_COLUMNS.has(column)));
  const clean = {};
  for (const [column, rawValue] of Object.entries(source)) {
    if (!allowed.has(column)) continue;
    let value = rawValue;
    if (typeof value === 'string') value = value.trim();
    clean[column] = value === '' ? null : value;
  }
  return clean;
}

async function validateDashboardTaskRelations(data, req) {
  if (data.client_id) {
    const access = await clientAccessByArgument(String(data.client_id), req, false);
    if (!access) {
      const error = new Error('Cliente non disponibile per l\'utente corrente');
      error.statusCode = 403;
      throw error;
    }
  }
  if (data.project_id) {
    if (!data.client_id) {
      const error = new Error('Per selezionare un progetto devi indicare anche il cliente');
      error.statusCode = 400;
      throw error;
    }
    const project = await db.query(
      `SELECT 1 FROM projects
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND client_id = $4
         AND argument = 'Progetto' AND campo = 'Progetto'
       LIMIT 1`,
      [data.project_id, req.user.tenant_id, req.user.user_id, data.client_id]
    );
    if (project.rows.length === 0) {
      const error = new Error('Progetto non disponibile per il cliente selezionato');
      error.statusCode = 403;
      throw error;
    }
  }
  if (data.assigned_to) {
    if (!data.client_id) {
      const error = new Error('Per assegnare la task devi indicare il cliente');
      error.statusCode = 400;
      throw error;
    }
    const parameters = [data.assigned_to, req.user.tenant_id, data.client_id];
    let projectCondition = '';
    if (data.project_id) {
      parameters.push(data.project_id);
      projectCondition = ` AND project_id = $${parameters.length}`;
    }
    const component = await db.query(
      `SELECT 1
       FROM proj_componenti
       WHERE id = $1
         AND tenant_id = $2
         AND client_id = $3${projectCondition}
       LIMIT 1`,
      parameters
    );
    if (component.rows.length === 0) {
      const error = new Error('Assegnatario non disponibile per il cliente e il progetto selezionati');
      error.statusCode = 403;
      throw error;
    }
  }
}

// Task della dashboard. Tenant e utente sono sempre ricavati dal token:
// il browser non puo' ampliare il perimetro della query passando altri id.
app.get('/api/dashboard/tasks', requireAuth, async (req, res) => {
  try {
    // Rilegge lo schema per includere automaticamente eventuali nuovi campi.
    tableColumnsCache.delete('main:tasks');
    const metadata = await getDashboardTaskMetadata();
    if (metadata.length === 0) {
      return res.status(404).json({ error: 'Tabella tasks non trovata' });
    }

    const visibleMetadata = metadata.filter(
      column => !DASHBOARD_TASK_HIDDEN_COLUMNS.has(column.column_name)
    );

    const fkResult = await db.query(
      `SELECT kcu.column_name,
              ccu.table_name AS foreign_table,
              ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND tc.table_name = 'tasks'`
    );
    const fkByColumn = new Map(fkResult.rows.map(fk => [fk.column_name, fk]));
    // L'id e gli UUID originali delle foreign vengono restituiti con chiavi
    // interne: servono al form di modifica ma non vengono mostrati in griglia.
    const selectExpressions = ['src.id AS "__task_id"'];
    const joins = [];
    const responseColumns = [];
    let joinIndex = 0;

    for (const metadata of visibleMetadata) {
      const column = metadata.column_name;
      assertValidIdentifier(column);
      const fk = fkByColumn.get(column);
      let resolvedForeign = false;

      // assigned_to contiene proj_componenti.id; in griglia viene restituito
      // il relativo proj_componenti.nominativo.
      if (column === 'assigned_to' && metadata.udt_name === 'uuid') {
        tableColumnsCache.delete('main:proj_componenti');
        const componentColumns = await getTableColumns('proj_componenti');
        if (['id', 'nominativo', 'tenant_id', 'client_id'].every(name => componentColumns.has(name))) {
          const projectOrdering = componentColumns.has('project_id')
            ? ', (src.project_id IS NOT NULL AND pc.project_id = src.project_id) DESC'
            : '';
          selectExpressions.push('src."assigned_to" AS "__raw_assigned_to"');
          selectExpressions.push(
            `COALESCE((
               SELECT NULLIF(TRIM(pc.nominativo::text), '')
               FROM proj_componenti pc
               WHERE pc.id = src.assigned_to
                 AND pc.tenant_id = src.tenant_id
               ORDER BY (pc.client_id = src.client_id) DESC
                 ${projectOrdering}, pc.nominativo NULLS LAST
               LIMIT 1
             ), 'Nominativo non disponibile') AS "assigned_to"`
          );
          resolvedForeign = true;
        }
      }

      if (!resolvedForeign && metadata.udt_name === 'uuid' && fk) {
        assertValidIdentifier(fk.foreign_table);
        assertValidIdentifier(fk.foreign_column);
        tableColumnsCache.delete('main:' + fk.foreign_table);
        const foreignColumns = await getTableColumns(fk.foreign_table);
        const foreignNames = [...foreignColumns];
        const preferredNames = ['description', 'descrizione', 'name', 'nome', 'title', 'titile', 'label', 'valore2'];
        // In Projexa clienti e progetti sono contenitori EAV: il loro nome
        // leggibile e' nella riga identita', colonna valore2.
        const eavDisplayColumn = ['clients', 'projects'].includes(fk.foreign_table)
          && foreignColumns.has('valore2') ? 'valore2' : null;
        const displayColumn = eavDisplayColumn
          || foreignNames.find(name => /^desc_/i.test(name))
          || preferredNames.find(name => foreignColumns.has(name))
          || null;

        if (displayColumn) {
          assertValidIdentifier(displayColumn);
          const alias = `task_fk_${joinIndex++}`;
          const tenantJoin = foreignColumns.has('tenant_id') ? ` AND ${alias}.tenant_id = $1` : '';
          joins.push(`LEFT JOIN "${fk.foreign_table}" ${alias}
                        ON ${alias}."${fk.foreign_column}" = src."${column}"${tenantJoin}`);
          selectExpressions.push(`src."${column}" AS "__raw_${column}"`);
          selectExpressions.push(
            `COALESCE(${alias}."${displayColumn}"::text, src."${column}"::text) AS "${column}"`
          );
          resolvedForeign = true;
        }
      }

      if (!resolvedForeign) selectExpressions.push(`src."${column}"`);
      responseColumns.push({
        name: column,
        type: metadata.data_type,
        uuid: metadata.udt_name === 'uuid',
        resolvedForeign,
        references: fk ? fk.foreign_table : (column === 'assigned_to' ? 'proj_componenti' : null),
        nullable: metadata.is_nullable === 'YES',
        hasDefault: metadata.column_default != null,
        editable: !DASHBOARD_TASK_READONLY_COLUMNS.has(column)
      });
    }

    const result = await db.query(
      `SELECT ${selectExpressions.join(', ')}
       FROM tasks src
       ${joins.join('\n       ')}
       WHERE src.tenant_id = $1 AND src.user_id = $2
       ORDER BY src.due_date NULLS LAST, src.created_at DESC
       LIMIT 500`,
      [req.user.tenant_id, req.user.user_id]
    );

    res.json({ columns: responseColumns, rows: result.rows });
  } catch (error) {
    console.error('[DASHBOARD TASKS]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Opzioni leggibili per le foreign key editabili della task. La relazione viene
// ricavata dallo schema DB: il browser puo' chiedere solo colonne FK di tasks.
app.get('/api/dashboard/tasks/foreign-options/:column', requireAuth, async (req, res) => {
  try {
    const column = assertValidIdentifier(String(req.params.column || '').trim());

    if (column === 'assigned_to') {
      const clientId = String(req.query.clientId || '').trim();
      const projectId = String(req.query.projectId || '').trim();
      const selectedValue = String(req.query.selectedValue || '').trim();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if ((clientId && !uuidPattern.test(clientId)) || (projectId && !uuidPattern.test(projectId))
          || (selectedValue && !uuidPattern.test(selectedValue))) {
        return res.status(400).json({ error: 'Cliente, progetto o assegnatario non valido' });
      }

      tableColumnsCache.delete('main:proj_componenti');
      const componentColumns = await getTableColumns('proj_componenti');
      const requiredColumns = ['id', 'tenant_id', 'client_id', 'nominativo'];
      if (projectId) requiredColumns.push('project_id');
      if (requiredColumns.some(name => !componentColumns.has(name))) {
        return res.status(500).json({ error: 'Struttura proj_componenti non compatibile con il filtro assegnatari' });
      }
      // Filtro user_id: applicato quando la colonna esiste, oltre a tenant/client/project.
      const hasUserCol = componentColumns.has('user_id');
      if (!clientId) {
        if (!selectedValue) return res.json({ options: [] });
        const selParams = [req.user.tenant_id, selectedValue];
        let selUserCond = '';
        if (hasUserCol) { selParams.push(req.user.user_id); selUserCond = ` AND pc.user_id = $${selParams.length}`; }
        const selected = await db.query(
          `SELECT pc.id::text AS value,
                  COALESCE(NULLIF(TRIM(pc.nominativo::text), ''), 'Nominativo non disponibile') AS label
           FROM proj_componenti pc
           WHERE pc.tenant_id = $1 AND pc.id = $2${selUserCond}
           LIMIT 1`,
          selParams
        );
        return res.json({ options: selected.rows });
      }
      const parameters = [req.user.tenant_id, clientId];
      let userCondition = '';
      if (hasUserCol) { parameters.push(req.user.user_id); userCondition = ` AND pc.user_id = $${parameters.length}`; }
      let projectCondition = '';
      if (projectId) {
        parameters.push(projectId);
        projectCondition = ` AND pc.project_id = $${parameters.length}`;
      }
      let selectedFallback = '';
      if (selectedValue) {
        parameters.push(selectedValue);
        selectedFallback = `
          UNION
          SELECT pc.id::text AS value,
                 COALESCE(NULLIF(TRIM(pc.nominativo::text), ''), 'Nominativo non disponibile') AS label
          FROM proj_componenti pc
          WHERE pc.tenant_id = $1
            AND pc.id = $${parameters.length}`;
      }
      const result = await db.query(
        `SELECT DISTINCT options.value, options.label
         FROM (
           SELECT pc.id::text AS value,
                  COALESCE(NULLIF(TRIM(pc.nominativo::text), ''), 'Nominativo non disponibile') AS label
           FROM proj_componenti pc
           WHERE pc.tenant_id = $1
             AND pc.client_id = $2
             AND pc.id IS NOT NULL${userCondition}${projectCondition}
           ${selectedFallback}
         ) options
         ORDER BY label
         LIMIT 500`,
        parameters
      );
      return res.json({ options: result.rows });
    }

    const relationResult = await db.query(
      `SELECT ccu.table_name AS foreign_table,
              ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND tc.table_name = 'tasks'
         AND kcu.column_name = $1
       LIMIT 1`,
      [column]
    );
    if (relationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Foreign key non trovata per il campo richiesto' });
    }

    const relation = relationResult.rows[0];
    const foreignTable = assertValidIdentifier(relation.foreign_table);
    const foreignColumn = assertValidIdentifier(relation.foreign_column);
    tableColumnsCache.delete('main:' + foreignTable);
    const foreignColumns = await getTableColumns(foreignTable);

    // Per le altre foreign verso users resta valido il perimetro tenant.
    if (foreignTable === 'users' && foreignColumns.has('name') && foreignColumns.has('cognome')) {
      const result = await db.query(
        `SELECT DISTINCT u."${foreignColumn}"::text AS value,
                COALESCE(
                  NULLIF(TRIM(CONCAT_WS(' ', u.cognome, u.name)), ''),
                  u."${foreignColumn}"::text
                ) AS label
         FROM users u
         JOIN user_tenants ut
           ON ut.user_id = u."${foreignColumn}" AND ut.tenant_id = $1
         ORDER BY label
         LIMIT 500`,
        [req.user.tenant_id]
      );
      return res.json({ options: result.rows });
    }

    const foreignNames = [...foreignColumns];
    const preferredNames = ['description', 'descrizione', 'name', 'nome', 'title', 'titile', 'label', 'valore2'];
    const displayColumn = foreignNames.find(name => /^desc_/i.test(name))
      || preferredNames.find(name => foreignColumns.has(name))
      || foreignColumn;
    assertValidIdentifier(displayColumn);

    const conditions = [];
    const parameters = [];
    if (foreignColumns.has('tenant_id')) {
      parameters.push(req.user.tenant_id);
      conditions.push(`ref.tenant_id = $${parameters.length}`);
    }
    if (foreignColumns.has('user_id')) {
      parameters.push(req.user.user_id);
      conditions.push(`ref.user_id = $${parameters.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT ref."${foreignColumn}"::text AS value,
              COALESCE(ref."${displayColumn}"::text, ref."${foreignColumn}"::text) AS label
       FROM "${foreignTable}" ref
       ${where}
       ORDER BY label
       LIMIT 500`,
      parameters
    );
    res.json({ options: result.rows });
  } catch (error) {
    console.error('[DASHBOARD TASK FOREIGN OPTIONS]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Inserimento di una task nel contesto autenticato.
app.post('/api/dashboard/tasks', requireAuth, async (req, res) => {
  try {
    const metadata = await getDashboardTaskMetadata();
    if (metadata.length === 0) return res.status(404).json({ error: 'Tabella tasks non trovata' });
    const data = dashboardTaskInput(req.body, metadata);
    if (!String(data.titile || '').trim()) {
      return res.status(400).json({ error: 'Il titolo della task e\' obbligatorio' });
    }
    await validateDashboardTaskRelations(data, req);

    data.tenant_id = req.user.tenant_id;
    data.user_id = req.user.user_id;
    if (metadata.some(column => column.column_name === 'created_by')) {
      data.created_by = req.user.user_id;
    }

    const columns = Object.keys(data);
    const values = Object.values(data);
    const quotedColumns = columns.map(column => `"${assertValidIdentifier(column)}"`).join(', ');
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const result = await db.query(
      `INSERT INTO tasks (${quotedColumns}) VALUES (${placeholders}) RETURNING id`,
      values
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    console.error('[DASHBOARD TASK CREATE]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Modifica consentita solo sulla task dello stesso tenant e dello stesso utente.
app.put('/api/dashboard/tasks/:id', requireAuth, async (req, res) => {
  try {
    const taskId = String(req.params.id || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
      return res.status(400).json({ error: 'Id task non valido' });
    }
    const metadata = await getDashboardTaskMetadata();
    const data = dashboardTaskInput(req.body, metadata);
    if (Object.prototype.hasOwnProperty.call(data, 'titile') && !String(data.titile || '').trim()) {
      return res.status(400).json({ error: 'Il titolo della task e\' obbligatorio' });
    }
    await validateDashboardTaskRelations(data, req);
    const columns = Object.keys(data);
    if (columns.length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

    const values = Object.values(data);
    const assignments = columns.map((column, index) =>
      `"${assertValidIdentifier(column)}" = $${index + 1}`
    );
    assignments.push('updated_at = CURRENT_TIMESTAMP');
    values.push(taskId, req.user.tenant_id, req.user.user_id);
    const result = await db.query(
      `UPDATE tasks SET ${assignments.join(', ')}
       WHERE id = $${columns.length + 1}
         AND tenant_id = $${columns.length + 2}
         AND user_id = $${columns.length + 3}
       RETURNING id`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task non trovata' });
    res.json({ id: result.rows[0].id });
  } catch (error) {
    console.error('[DASHBOARD TASK UPDATE]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Widget griglia (tipo_valore = 11). La configurazione della tabella e delle
// colonne viene letta dalla riga EAV del contesto corrente; tenant e utente non
// vengono accettati dal browser ma ricavati dall'autenticazione.
app.get('/api/:source(settings|clients|projects)/grid-widget', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = String(req.query.fieldId || '').trim();
    if (!fieldId) return res.status(400).json({ error: 'Parametro fieldId richiesto' });

    const clientColumn = source === 'projects' ? 'client_id' : 'NULL::uuid AS client_id';
    const configResult = await db.query(
      `SELECT id, argument, tabella, colonna, tenant_id, user_id, ${clientColumn}
       FROM "${source}"
       WHERE id = $1 AND tenant_id = $2 AND tipo_valore::text = '11'
       LIMIT 1`,
      [fieldId, req.user.tenant_id]
    );
    if (configResult.rows.length === 0) {
      return res.status(404).json({ error: 'Configurazione griglia non trovata' });
    }
    const config = configResult.rows[0];

    // Per i clienti condivisi il contesto dati è quello del proprietario; negli
    // altri contesti la riga deve appartenere all'utente autenticato.
    let effectiveUserId = req.user.user_id;
    if (source === 'clients') {
      const access = await clientAccessByArgument(config.argument, req, false);
      if (!access) return res.status(403).json({ error: 'Non autorizzato' });
      effectiveUserId = access.ownerUserId;
      if (String(config.user_id) !== String(effectiveUserId)) {
        return res.status(403).json({ error: 'Non autorizzato' });
      }
    } else if (String(config.user_id) !== String(req.user.user_id)) {
      return res.status(403).json({ error: 'Non autorizzato' });
    }

    const tableName = assertValidIdentifier(String(config.tabella || '').trim());
    let selectedColumns = [];
    const rawColumns = String(config.colonna || '').trim();
    if (rawColumns.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawColumns);
        if (Array.isArray(parsed)) selectedColumns = parsed;
      } catch (e) { /* usa il formato separato */ }
    }
    if (selectedColumns.length === 0) selectedColumns = rawColumns.split(/[;,]/);
    selectedColumns = [...new Set(selectedColumns.map(c => String(c).trim()).filter(Boolean))];
    if (selectedColumns.length === 0) {
      return res.status(400).json({ error: 'Nessuna colonna configurata' });
    }

    // La struttura delle tabelle può cambiare durante la configurazione del progetto.
    // Non usare una fotografia precedente della cache per il widget dinamico.
    tableColumnsCache.delete('main:' + tableName);
    const tableColumns = await getTableColumns(tableName);
    if (tableColumns.size === 0) return res.status(404).json({ error: 'Tabella non trovata' });
    for (const column of selectedColumns) {
      assertValidIdentifier(column);
      if (!tableColumns.has(column)) {
        return res.status(400).json({ error: `Colonna ${column} non trovata nella tabella ${tableName}` });
      }
    }
    for (const required of ['tenant_id', 'user_id', 'client_id']) {
      if (!tableColumns.has(required)) {
        return res.status(400).json({ error: `La tabella ${tableName} non contiene ${required}` });
      }
    }

    // Le view sono di sola lettura: il frontend usa questo flag per nascondere i
    // pulsanti Nuova riga / Modifica / Elimina, che qui non avrebbero senso.
    const tableTypeResult = await db.query(
      `SELECT table_type FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [tableName]
    );
    const isView = tableTypeResult.rows[0]?.table_type === 'VIEW';

    let clientId = String(req.query.clientId || config.client_id || '').trim();
    if (!clientId && source === 'clients') {
      const root = await resolveClientRoot(config.argument, req.user.tenant_id);
      clientId = root ? String(root.clientId) : '';
    }
    if (!clientId) return res.status(400).json({ error: 'Contesto client_id non disponibile' });

    // Nei progetti, la modalità di gestione determina quale unità di misura
    // mostrare nella griglia. La riga di controllo appartiene allo stesso
    // tenant, utente, cliente e progetto della configurazione corrente.
    if (source === 'projects') {
      const managementResult = await db.query(
        `SELECT valore1
         FROM projects
         WHERE tenant_id = $1
           AND user_id = $2
           AND client_id = $3
           AND campo = 'Gestione a HH'
           AND argument = $4
         LIMIT 1`,
        [req.user.tenant_id, req.user.user_id, clientId, config.argument]
      );
      const managementValue = managementResult.rows[0]?.valore1;
      const manageByHours = managementValue === true
        || managementValue === 'true'
        || managementValue === 't'
        || managementValue === 1;
      const hiddenSuffix = manageByHours ? '_gg' : '_hh';
      selectedColumns = selectedColumns.filter(column =>
        !String(column).toLowerCase().endsWith(hiddenSuffix)
      );

      if (selectedColumns.length === 0) {
        return res.json({ rows: [], columns: [] });
      }
    }

    // Cerca le foreign key delle colonne richieste. Se la tabella referenziata
    // contiene una colonna descrittiva, mostra quella al posto dell'UUID ma
    // mantiene come chiave JSON il nome originale (es. worker_cost_id).
    const fkResult = await db.query(
      `SELECT kcu.column_name,
              ccu.table_name AS foreign_table,
              ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND tc.table_name = $1`,
      [tableName]
    );
    const fkByColumn = new Map(fkResult.rows.map(fk => [fk.column_name, fk]));
    const selectExpressions = [];
    const joins = [];
    let joinIndex = 0;

    // L'id della riga serve sempre al frontend (Modifica/Elimina), anche se non è tra le
    // colonne configurate per la visualizzazione: viene aggiunto separatamente e non è
    // incluso nell'elenco "columns" restituito, quindi non compare come colonna in griglia.
    if (tableColumns.has('id') && !selectedColumns.includes('id')) {
      selectExpressions.push('src.id AS id');
    }

    for (const column of selectedColumns) {
      const fk = fkByColumn.get(column);
      if (!fk) {
        selectExpressions.push(`src."${column}"`);
        continue;
      }

      assertValidIdentifier(fk.foreign_table);
      assertValidIdentifier(fk.foreign_column);
      // Rilegge le colonne della tabella esterna per riconoscere anche modifiche
      // appena effettuate allo schema.
      tableColumnsCache.delete('main:' + fk.foreign_table);
      const foreignColumns = await getTableColumns(fk.foreign_table);
      const foreignNames = [...foreignColumns];
      const preferredNames = ['description', 'descrizione', 'name', 'nome', 'title', 'label', 'valore2'];
      const displayColumn = foreignNames.find(name => /^desc_/i.test(name))
        || preferredNames.find(name => foreignColumns.has(name))
        || null;

      if (!displayColumn) {
        selectExpressions.push(`src."${column}"`);
        continue;
      }
      assertValidIdentifier(displayColumn);
      const alias = `fk_${joinIndex++}`;
      joins.push(`LEFT JOIN "${fk.foreign_table}" ${alias} ON ${alias}."${fk.foreign_column}" = src."${column}"`);
      // Conserva anche il valore grezzo (uuid) sotto "__raw_<colonna>": la colonna
      // visibile mostra l'etichetta leggibile, ma il salvataggio deve scrivere l'id reale,
      // non il testo mostrato (altrimenti "invalid input syntax for type uuid").
      selectExpressions.push(`src."${column}" AS "__raw_${column}"`);
      selectExpressions.push(`COALESCE(${alias}."${displayColumn}"::text, src."${column}"::text) AS "${column}"`);
    }

    const selectList = selectExpressions.join(', ');
    const joinClause = joins.length ? '\n       ' + joins.join('\n       ') : '';
    const orderBy = tableColumns.has('id') ? ' ORDER BY src.id' : '';

    // Tabelle con colonna project_id (es. proj_anno_fatt, proj_componenti) vanno SEMPRE
    // filtrate anche per progetto, non solo tenant/utente/cliente. Nel contesto "projects"
    // l'id del progetto corrente è l'argument della riga di configurazione del widget
    // (la riga del campo tipo_valore=11 vive sotto il progetto stesso).
    const queryParams = [req.user.tenant_id, effectiveUserId, clientId];
    let projectFilter = '';
    if (source === 'projects' && tableColumns.has('project_id')) {
      queryParams.push(config.argument);
      projectFilter = ` AND src.project_id = $${queryParams.length}`;
    }

    const result = await db.query(
      `SELECT ${selectList}
       FROM "${tableName}" src${joinClause}
       WHERE src.tenant_id = $1 AND src.user_id = $2 AND src.client_id = $3${projectFilter}${orderBy}
       LIMIT 100`,
      queryParams
    );
    // Formato oggetto uniforme per tutte le sorgenti: righe, colonne effettivamente
    // visibili (dopo l'eventuale filtro HH/GG per i progetti) e se la tabella è una view
    // (sola lettura, il frontend nasconde Nuova riga/Modifica/Elimina in quel caso).
    res.json({ rows: result.rows, columns: selectedColumns, isView });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Risolve la configurazione di una griglia (tipo_valore = 11) e verifica che l'utente
// corrente possa operare su di essa. Restituisce { config, tableName, tableColumns,
// generatedColumns, effectiveUserId, clientId } oppure lancia un errore con statusCode.
async function resolveGridWidgetContext(source, fieldId, req, needWrite) {
  if (!fieldId) {
    throw Object.assign(new Error('Parametro fieldId richiesto'), { statusCode: 400 });
  }
  const clientColumn = source === 'projects' ? 'client_id' : 'NULL::uuid AS client_id';
  const configResult = await db.query(
    `SELECT id, argument, tabella, colonna, tenant_id, user_id, ${clientColumn}
     FROM "${source}"
     WHERE id = $1 AND tenant_id = $2 AND tipo_valore::text = '11'
     LIMIT 1`,
    [fieldId, req.user.tenant_id]
  );
  if (configResult.rows.length === 0) {
    throw Object.assign(new Error('Configurazione griglia non trovata'), { statusCode: 404 });
  }
  const config = configResult.rows[0];

  let effectiveUserId = req.user.user_id;
  if (source === 'clients') {
    const access = await clientAccessByArgument(config.argument, req, needWrite);
    if (!access) throw Object.assign(new Error('Non autorizzato'), { statusCode: 403 });
    effectiveUserId = access.ownerUserId;
    if (String(config.user_id) !== String(effectiveUserId)) {
      throw Object.assign(new Error('Non autorizzato'), { statusCode: 403 });
    }
  } else if (String(config.user_id) !== String(req.user.user_id)) {
    throw Object.assign(new Error('Non autorizzato'), { statusCode: 403 });
  }

  const tableName = assertValidIdentifier(String(config.tabella || '').trim());
  if (!tableName) {
    throw Object.assign(new Error('Tabella non configurata'), { statusCode: 400 });
  }
  tableColumnsCache.delete('main:' + tableName);
  const tableColumns = await getTableColumns(tableName);
  if (tableColumns.size === 0) {
    throw Object.assign(new Error('Tabella non trovata'), { statusCode: 404 });
  }
  const generatedColumns = await getGeneratedColumns(tableName);

  let clientId = String(config.client_id || '').trim();
  if (!clientId && source === 'clients') {
    const root = await resolveClientRoot(config.argument, req.user.tenant_id);
    clientId = root ? String(root.clientId) : '';
  }

  return { config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId };
}

// Metadati delle colonne per il widget griglia (tipo_valore = 11): nome, se generata,
// tipo Postgres e foreign key (per i menu a discesa). A differenza di
// /api/data/:table/columns, questo endpoint NON richiede che la tabella sia registrata
// in table_structures: la fiducia deriva dalla configurazione del campo (settings.tabella),
// impostata da un utente privilegiato, esattamente come per la lettura/scrittura delle righe.
app.get('/api/:source(settings|clients|projects)/grid-widget/columns', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const { tableName } = await resolveGridWidgetContext(source, fieldId, req, false);

    const result = await db.query(
      `SELECT column_name, is_generated, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
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
    for (const r of result.rows) {
      if (r.column_name === 'id_roles' || r.column_name === 'id_roles_write') {
        fkMap[r.column_name] = 'roles';
        fkColMap[r.column_name] = 'id_roles';
      }
    }
    res.json(result.rows.map((r) => ({
      name: r.column_name,
      generated: r.is_generated === 'ALWAYS',
      type: r.data_type,
      references: fkMap[r.column_name] || null,
      referencesColumn: fkColMap[r.column_name] || null
    })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Opzioni per un campo FK della griglia (tipo_valore = 11), usate dal menu a discesa dei
// form "Nuova riga"/"Modifica". A differenza di GET /api/data/:table (generico, usato altrove),
// qui il filtro su tenant_id, user_id, client_id e project_id viene SEMPRE ricavato dal
// contesto della griglia (autenticazione + configurazione), mai da valori inviati dal browser:
// così l'elenco mostra solo le righe pertinenti al progetto/cliente aperto, non l'intero database.
app.get('/api/:source(settings|clients|projects)/grid-widget/fk-options', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const column = assertValidIdentifier(((req.query && req.query.column) || '').trim());
    if (!column) return res.status(400).json({ error: 'Parametro column richiesto' });

    const ctx = await resolveGridWidgetContext(source, fieldId, req, false);
    const { config, tableName, tableColumns, effectiveUserId, clientId } = ctx;
    if (!tableColumns.has(column)) {
      return res.status(400).json({ error: `Colonna ${column} non trovata nella tabella ${tableName}` });
    }

    const fkResult = await db.query(
      `SELECT ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
         AND tc.table_name = $1 AND kcu.column_name = $2
       LIMIT 1`,
      [tableName, column]
    );
    if (fkResult.rows.length === 0) {
      return res.status(400).json({ error: `La colonna ${column} non ha una foreign key` });
    }
    const foreignTable = assertValidIdentifier(fkResult.rows[0].foreign_table);
    const foreignColumn = assertValidIdentifier(fkResult.rows[0].foreign_column);
    if (!(await isManagedTable(foreignTable))) {
      return res.status(404).json({ error: 'Tabella referenziata non gestita' });
    }

    // Rilegge le colonne della tabella referenziata per riconoscere anche modifiche
    // appena effettuate allo schema (stessa cautela usata per la griglia principale).
    tableColumnsCache.delete('main:' + foreignTable);
    const foreignColumns = await getTableColumns(foreignTable);
    const preferredNames = ['description', 'descrizione', 'name', 'nome', 'title', 'label', 'valore2'];
    const displayColumn = [...foreignColumns].find(name => /^desc_/i.test(name))
      || preferredNames.find(name => foreignColumns.has(name))
      || foreignColumn;
    assertValidIdentifier(displayColumn);

    // Filtro SEMPRE dal contesto server-side (mai da query string): tenant, utente,
    // cliente e, nei progetti, il progetto corrente.
    const conds = [];
    const params = [];
    if (foreignColumns.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (foreignColumns.has('user_id')) { params.push(effectiveUserId); conds.push(`user_id = $${params.length}`); }
    if (foreignColumns.has('client_id') && clientId) { params.push(clientId); conds.push(`client_id = $${params.length}`); }
    if (foreignColumns.has('project_id') && source === 'projects') { params.push(config.argument); conds.push(`project_id = $${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await db.query(
      `SELECT "${foreignColumn}" AS id, "${displayColumn}" AS display
       FROM "${foreignTable}" ${where}
       ORDER BY "${displayColumn}" NULLS LAST
       LIMIT 200`,
      params
    );
    res.json(stripSensitive(result.rows));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Inserisce una nuova riga nella griglia (tipo_valore = 11). tenant_id/user_id/client_id
// (e project_id per i progetti) vengono sempre forzati dal contesto, non dal browser.
app.post('/api/:source(settings|clients|projects)/grid-widget/row', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.body && req.body.fieldId) || '').trim();
    const values = (req.body && req.body.values) || {};

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId } = ctx;
    if (!clientId) return res.status(400).json({ error: 'Contesto client_id non disponibile' });

    const data = {};
    for (const [k, v] of Object.entries(values)) {
      if (tableColumns.has(k) && !generatedColumns.has(k)
          && !['id', 'tenant_id', 'user_id', 'client_id', 'project_id'].includes(k)) {
        data[k] = v === '' ? null : v;
      }
    }
    if (tableColumns.has('tenant_id')) data.tenant_id = req.user.tenant_id;
    if (tableColumns.has('user_id')) data.user_id = effectiveUserId;
    if (tableColumns.has('client_id')) data.client_id = clientId;
    if (tableColumns.has('project_id') && source === 'projects') data.project_id = config.argument;

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) return res.status(400).json({ error: 'Nessun dato da inserire' });
    const paramsArr = columns.map((c) => data[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quoted = columns.map((c) => `"${c}"`).join(', ');
    const result = await db.query(
      `INSERT INTO "${tableName}" (${quoted}) VALUES (${placeholders}) RETURNING *`,
      paramsArr
    );
    res.status(201).json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Modifica una riga esistente della griglia (tipo_valore = 11), filtrando sempre per il
// contesto (tenant/utente/cliente/progetto), mai per valori inviati dal browser.
app.put('/api/:source(settings|clients|projects)/grid-widget/row', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.body && req.body.fieldId) || '').trim();
    const rowId = ((req.body && req.body.rowId) || '').trim();
    const values = (req.body && req.body.values) || {};
    if (!rowId) return res.status(400).json({ error: 'rowId richiesto' });

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId } = ctx;

    const data = {};
    for (const [k, v] of Object.entries(values)) {
      if (tableColumns.has(k) && !generatedColumns.has(k)
          && !['id', 'tenant_id', 'user_id', 'client_id', 'project_id'].includes(k)) {
        data[k] = v === '' ? null : v;
      }
    }
    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) return res.status(400).json({ error: 'Nessun dato da aggiornare' });

    const setClause = columns.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
    const paramsArr = columns.map((c) => data[c]);
    paramsArr.push(rowId);
    const conditions = [`id = $${paramsArr.length}`];
    if (tableColumns.has('tenant_id')) { paramsArr.push(req.user.tenant_id); conditions.push(`tenant_id = $${paramsArr.length}`); }
    if (tableColumns.has('user_id')) { paramsArr.push(effectiveUserId); conditions.push(`user_id = $${paramsArr.length}`); }
    if (tableColumns.has('client_id') && clientId) { paramsArr.push(clientId); conditions.push(`client_id = $${paramsArr.length}`); }
    if (tableColumns.has('project_id') && source === 'projects') { paramsArr.push(config.argument); conditions.push(`project_id = $${paramsArr.length}`); }

    const updatedAtClause = tableColumns.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
    const result = await db.query(
      `UPDATE "${tableName}" SET ${setClause}${updatedAtClause} WHERE ${conditions.join(' AND ')} RETURNING *`,
      paramsArr
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
    res.json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Elimina una riga della griglia (tipo_valore = 11), filtrando sempre per il contesto.
app.delete('/api/:source(settings|clients|projects)/grid-widget/row', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const rowId = ((req.query && req.query.rowId) || '').trim();
    if (!rowId) return res.status(400).json({ error: 'rowId richiesto' });

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, effectiveUserId, clientId } = ctx;

    const conditions = ['id = $1'];
    const paramsArr = [rowId];
    if (tableColumns.has('tenant_id')) { paramsArr.push(req.user.tenant_id); conditions.push(`tenant_id = $${paramsArr.length}`); }
    if (tableColumns.has('user_id')) { paramsArr.push(effectiveUserId); conditions.push(`user_id = $${paramsArr.length}`); }
    if (tableColumns.has('client_id') && clientId) { paramsArr.push(clientId); conditions.push(`client_id = $${paramsArr.length}`); }
    if (tableColumns.has('project_id') && source === 'projects') { paramsArr.push(config.argument); conditions.push(`project_id = $${paramsArr.length}`); }

    const result = await db.query(
      `DELETE FROM "${tableName}" WHERE ${conditions.join(' AND ')} RETURNING id`,
      paramsArr
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
    res.json({ deleted: result.rowCount });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// KPI Fatturato: legge la vista kpi_fatturazione, filtrata SEMPRE per tenant_id e user_id
// del login; anno e client_id sono filtri opzionali (client_id assente = tutti i clienti).
app.get('/api/kpi-fatturazione', requireAuth, async (req, res) => {
  try {
    const anno = req.query.anno ? Number(req.query.anno) : null;
    const clientId = ((req.query && req.query.clientId) || '').trim();
    const conditions = ['tenant_id = $1', 'user_id = $2'];
    const params = [req.user.tenant_id, req.user.user_id];
    if (Number.isFinite(anno)) { params.push(anno); conditions.push(`anno = $${params.length}`); }
    if (clientId) { params.push(clientId); conditions.push(`client_id = $${params.length}`); }
    const result = await db.query(
      `SELECT tenant_id, client_id, user_id, anno, totale, forecast
       FROM kpi_fatturazione WHERE ${conditions.join(' AND ')}`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Elenco degli anni disponibili in kpi_fatturazione per il login (tenant+utente), a
// prescindere dai filtri correnti: serve a popolare la tendina "Anno".
app.get('/api/kpi-fatturazione/years', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT anno FROM kpi_fatturazione WHERE tenant_id = $1 AND user_id = $2 ORDER BY anno`,
      [req.user.tenant_id, req.user.user_id]
    );
    res.json(result.rows.map(r => r.anno));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dynamic Generic Table Routes - reads from table_structures
// Supporta filtri per colonna: qualsiasi query param con chiave = nome di una colonna
// filtra quella colonna con ILIKE %valore% (case-insensitive, ricerca parziale).
app.get('/api/data/:table', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);

    if (!(await isManagedTable(tableName, pool))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const columns = await getTableColumns(tableName, pool, dbKey);
    const admin = isAdminUser(req);
    const conditions = [];
    const params = [];

    // Filtri per colonna (dal query string). Colonne qualificate con "src." per coerenza
    // con la query sottostante.
    for (const [key, val] of Object.entries(req.query)) {
      if (columns.has(key) && val != null && String(val) !== '') {
        assertValidIdentifier(key);
        params.push('%' + String(val) + '%');
        conditions.push(`src."${key}"::text ILIKE $${params.length}`);
      }
    }

    // Isolamento multi-tenant per i non-admin
    if (!admin) {
      if (tableName === 'tenants') {
        // "tenants" non ha tenant_id: il proprio tenant è la riga con id = tenant del login
        params.push(req.user.tenant_id);
        conditions.push(`src.id = $${params.length}`);
      } else if (columns.has('tenant_id')) {
        params.push(req.user.tenant_id);
        conditions.push(`src.tenant_id = $${params.length}`);
      }
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    // Ordinamento deterministico (evita che due query identiche restituiscano ordini diversi).
    const orderBy = columns.has('id') ? 'ORDER BY src.id' : '';

    // NOTA: niente colonne aggiuntive "<col>_label" qui. Questo endpoint alimenta anche
    // le PUT/POST del database-viewer, che rispediscono al server tutte le chiavi ricevute:
    // colonne extra non esistenti sul DB causavano errore di scrittura.
    const result = await pool.query(
      `SELECT src.* FROM "${tableName}" src ${whereClause} ${orderBy} LIMIT 100`,
      params
    );
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
    const pool = pickDb(req);
    const tableName = assertValidIdentifier(req.params.table);
    if (!(await isManagedTable(tableName, pool))) {
      return res.status(404).json({ error: 'Table not found' });
    }
    const result = await pool.query(
      `SELECT column_name, is_generated, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    // Foreign key della tabella: colonna -> tabella + colonna referenziata (per i dropdown nel form).
    const fk = await pool.query(
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
    // id_roles / id_roles_write non hanno un vincolo FK reale (sono smallint), ma vanno
    // sempre risolti come riferimento a roles.id_roles (codice) -> roles.name (etichetta),
    // così il form li mostra come menu a discesa dei ruoli.
    for (const r of result.rows) {
      if (r.column_name === 'id_roles' || r.column_name === 'id_roles_write') {
        fkMap[r.column_name] = 'roles';
        fkColMap[r.column_name] = 'id_roles';
      }
    }
    res.json(result.rows.map((r) => ({
      name: r.column_name,
      generated: r.is_generated === 'ALWAYS',
      type: r.data_type,                       // tipo Postgres (es. 'date', 'timestamp without time zone')
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
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);
    let data = { ...req.body };
    // Ambito scelto dall'admin al salvataggio (this-tenant | all-tenants); non è una
    // colonna della tabella, va rimosso prima dell'INSERT.
    const scope = data.__scope;
    delete data.__scope;

    // Le stringhe vuote diventano NULL: colonne numeriche/date/boolean non accettano ''.
    for (const k of Object.keys(data)) {
      if (data[k] === '') data[k] = null;
    }

    if (!(await isManagedTable(tableName, pool))) {
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
    const tableColumns = await getTableColumns(tableName, pool, dbKey);
    // I campi di contesto non sono mai lasciati al browser: il server li determina
    // dal login e, per i progetti, dal progetto/cliente corrente. Questo evita in
    // particolare il NOT NULL su user_id nelle INSERT di clients/settings.
    if (tableColumns.has('tenant_id')) data.tenant_id = req.user.tenant_id;
    if (tableColumns.has('user_id')) data.user_id = req.user.user_id;

    // Quando un utente non admin crea un record-struttura (settings/clients/projects),
    // se il form contiene il campo `campo` il nome deve essere sempre marcato come custom.
    // Questa normalizzazione è necessaria anche per il POST generico /api/data/:table,
    // usato dal form Aggiungi, non solo per l'endpoint specializzato /field.
    if (['settings', 'clients', 'projects'].includes(tableName)
        && Object.prototype.hasOwnProperty.call(data, 'campo')
        && !isAdminUser(req)) {
      const rawCampo = String(data.campo || '').trim().replace(/^\(\*\)\s*/, '');
      if (!rawCampo) return res.status(400).json({ error: 'nome campo richiesto' });
      data.campo = '(*) ' + rawCampo;
    }

    if (tableName === 'clients') {
      // clients non possiede client_id: se arrivasse dal form viene scartato.
      delete data.client_id;
      delete data.project_id;
    } else if (tableName === 'projects') {
      // Nel form il project_id è il contesto leggibile del progetto corrente.
      // Nel DB EAV il contenitore è rappresentato da argument = projects.id.
      // Se l'installazione dispone anche di una vera colonna project_id, la valorizziamo;
      // altrimenti la convertiamo in argument e non la mandiamo mai come colonna inesistente.
      const projectId = String(data.project_id || data.argument || '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'project_id richiesto per un campo del progetto' });
      }
      const projectContext = await pool.query(
        `SELECT id, client_id FROM projects
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3
           AND argument = 'Progetto' AND campo = 'Progetto'
         LIMIT 1`,
        [projectId, req.user.tenant_id, req.user.user_id]
      );
      if (projectContext.rows.length === 0) {
        return res.status(403).json({ error: "Progetto non disponibile per l'utente corrente" });
      }
      data.argument = projectId;
      if (tableColumns.has('client_id')) data.client_id = projectContext.rows[0].client_id;
      if (tableColumns.has('project_id')) data.project_id = projectId;
      else delete data.project_id;
    }

    // Le colonne generate non sono scrivibili: rimuovile dai dati in ingresso.
    const generatedColumns = await getGeneratedColumns(tableName, pool, dbKey);
    for (const g of generatedColumns) delete data[g];

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da inserire' });
    }

    // Admin + ambito "tutti i tenant": inserisce la stessa riga per ciascun tenant esistente
    // (solo se la tabella ha tenant_id). Altrimenti comportamento invariato (singolo insert).
    if (isAdminUser(req) && scope === 'all-tenants' && tableColumns.has('tenant_id')) {
      const tenantsRes = await pool.query('SELECT id FROM tenants');
      const insertedRows = [];
      for (const t of tenantsRes.rows) {
        const rowData = { ...data, tenant_id: t.id };
        const cols = Object.keys(rowData).map(assertValidIdentifier);
        const vals = cols.map((c) => rowData[c]);
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        const qc = cols.map((c) => `"${c}"`).join(', ');
        const r = await pool.query(`INSERT INTO "${tableName}" (${qc}) VALUES (${ph}) RETURNING *`, vals);
        if (r.rows[0]) insertedRows.push(r.rows[0]);
      }
      return res.status(201).json(stripSensitive(insertedRows.length ? [insertedRows[0]] : [])[0] || { inserted: insertedRows.length });
    }

    const values = columns.map((col) => data[col]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quotedColumns = columns.map((c) => `"${c}"`).join(', ');

    const query = `INSERT INTO "${tableName}" (${quotedColumns}) VALUES (${placeholders}) RETURNING *`;
    const result = await pool.query(query, values);

    res.status(201).json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// PUT - Update record
app.put('/api/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);
    const id = req.params.id;
    let data = { ...req.body };
    // Ambito scelto dall'admin al salvataggio; non è una colonna della tabella.
    const scope = data.__scope;
    const tenantScope = data.__tenantScope || 'this-tenant';
    delete data.__scope;
    delete data.__tenantScope;

    // Le stringhe vuote diventano NULL: colonne numeriche/date/boolean non accettano ''.
    for (const k of Object.keys(data)) {
      if (data[k] === '') data[k] = null;
    }

    if (!(await isManagedTable(tableName, pool))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Hash password if present
    if (data.password || data.password_hash) {
      const passwordValue = data.password || data.password_hash;
      const hashedPassword = await bcrypt.hash(passwordValue, 10);
      data = { ...data, password_hash: hashedPassword };
      delete data.password; // Remove plain password
    }

    // I campi di contesto del flyout sono sempre in sola lettura.
    // In modifica non devono mai essere aggiornati dal browser: tenant_id e
    // user_id restano quelli della riga autenticata; client_id è valido solo
    // nelle tabelle che lo possiedono (es. projects). In particolare la tabella
    // clients NON ha client_id, quindi va sempre escluso dalla UPDATE.
    const tableColumns = await getTableColumns(tableName, pool, dbKey);
    const admin = isAdminUser(req);
    if (tenantScope === 'all-tenants' && !admin) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }

    // Quando la PUT proviene dal form Aggiungi/Modifica campo, gli utenti non admin
    // possono creare/modificare solo campi custom: il prefisso '(*) ' viene imposto
    // dal server e non può essere rimosso dal browser.
    if (['settings', 'clients', 'projects'].includes(tableName) && Object.prototype.hasOwnProperty.call(data, 'campo') && !admin) {
      const rawCampo = String(data.campo || '').trim().replace(/^\(\*\)\s*/, '');
      if (!rawCampo) return res.status(400).json({ error: 'nome campo richiesto' });
      data.campo = '(*) ' + rawCampo;
    }

    // Per la propagazione 'all' serve il nome originale del campo prima della PUT.
    // Deve essere letto nel perimetro dell'utente/tenant autenticato.
    let originalFieldRow = null;
    if (['settings', 'clients', 'projects'].includes(tableName)) {
      const where = [];
      const params = [id];
      where.push(`id = $1`);
      if (tableColumns.has('tenant_id') && !admin) { params.push(req.user.tenant_id); where.push(`tenant_id = $${params.length}`); }
      if (tableColumns.has('user_id') && !admin) { params.push(req.user.user_id); where.push(`user_id = $${params.length}`); }
      const original = await pool.query(`SELECT id, argument, campo, valore2, tenant_id, user_id FROM "${tableName}" WHERE ${where.join(' AND ')} LIMIT 1`, params);
      originalFieldRow = original.rows[0] || null;
      if (originalFieldRow && ['clients', 'projects'].includes(tableName) && originalFieldRow.argument) {
        const container = await pool.query(`SELECT campo, valore2 FROM "${tableName}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [originalFieldRow.argument, originalFieldRow.tenant_id]);
        originalFieldRow.containerCampo = container.rows[0]?.campo || null;
        originalFieldRow.containerValue = container.rows[0]?.valore2 ?? null;
      }
    }

    delete data.tenant_id;
    delete data.user_id;
    delete data.client_id;

    // Difesa ulteriore: accetta soltanto colonne realmente presenti nella tabella.
    // Così eventuali campi aggiunti dal frontend non possono diventare identificatori
    // SQL e provocare errori come "column client_id of relation clients does not exist".
    data = Object.fromEntries(
      Object.entries(data).filter(([column]) => tableColumns.has(column))
    );

    // Isolamento clienti (ACL): un non-admin può modificare una riga di "clients" solo se
    // proprietario del cliente o con condivisione in scrittura. Enforce del permesso 'read'.
    if (tableName === 'clients' && !admin && dbKey === 'main') {
      const acc = await clientAccessByArgument(id, req, true);
      if (!acc) return res.status(403).json({ error: 'Non autorizzato a modificare questo cliente' });
    }

    // Le colonne generate non sono scrivibili: rimuovile dai dati in ingresso.
    const generatedColumns = await getGeneratedColumns(tableName, pool, dbKey);
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
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const savedRow = result.rows[0];

    // Propagazione della modifica del campo.
    // - Clienti/Progetti: scope='all' = tutti i contenitori del tenant/utente,
    //   scope='this' = solo il contenitore selezionato. È la stessa semantica di Elimina.
    // - Settings: scope='all-tenants' resta riservato all'admin e propaga a tutti i tenant;
    //   scope='this-tenant' limita al tenant corrente.
    const shouldPropagateField = ['clients', 'projects'].includes(tableName)
      ? (scope === 'all' || tenantScope === 'all-tenants')
      : tableName === 'settings' && scope === 'all-tenants' && admin;
    if (shouldPropagateField && originalFieldRow && originalFieldRow.campo != null) {
      try {
        // Propaghiamo anche 'campo' (rinomina) e tutti gli altri valori editati,
        // ma mai le chiavi di contesto o l'argument del singolo contenitore.
        const propagateCols = columns.filter(c => !['id', 'tenant_id', 'user_id', 'argument'].includes(c));
        if (propagateCols.length > 0) {
          const setClause = propagateCols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
          const pParams = propagateCols.map(c => data[c]);
          let where = `campo = $${propagateCols.length + 1} AND id <> $${propagateCols.length + 2}`;
          pParams.push(originalFieldRow.campo, savedRow.id);
          if (tenantScope === 'all-tenants' && admin && ['clients','projects'].includes(tableName)) {
            // Per all-tenants il contenitore viene individuato logicamente tramite
            // la riga identità (campo Cliente/Progetto + valore2), non tramite UUID.
            if (scope === 'this' && originalFieldRow.containerValue != null) {
              pParams.push(originalFieldRow.containerCampo || (tableName === 'projects' ? 'Progetto' : 'Cliente'));
              where += ` AND argument IN (SELECT id::text FROM "${tableName}" roots WHERE roots.campo = $${pParams.length} AND roots.valore2 = $${pParams.length + 1})`;
              pParams.push(originalFieldRow.containerValue);
            }
            // scope='all' non aggiunge filtro tenant/user: tutti i tenant.
          } else {
            if (tableColumns.has('tenant_id')) {
              pParams.push(req.user.tenant_id);
              where += ` AND tenant_id = $${pParams.length}`;
            }
            if (tableColumns.has('user_id')) {
              pParams.push(req.user.user_id);
              where += ` AND user_id = $${pParams.length}`;
            }
          }
          if (tableName === 'settings' && originalFieldRow.argument != null) {
            pParams.push(originalFieldRow.argument);
            where += ` AND argument = $${pParams.length}`;
          }
          await pool.query(`UPDATE "${tableName}" SET ${setClause} WHERE ${where}`, pParams);
        }
      } catch (e) { /* la propagazione non deve far fallire il salvataggio principale */ }
    }

    // Fattore di scala schermo (tipo_valore=30, valore2='schermo'): esiste una riga
    // "settings" per ciascun utente del tenant (seed via user_tenants), quindi salvare
    // valore3 sulla propria riga aggiornerebbe la scala solo per sé stessi. Propaga lo
    // stesso valore a tutte le righe gemelle del tenant (stesso argument/campo) così il
    // ridimensionamento si applica a TUTTI gli utenti, incluso durante l'impersonificazione.
    if (tableName === 'settings' && Object.prototype.hasOwnProperty.call(data, 'valore3')
        && String(savedRow.tipo_valore) === '30' && savedRow.valore2 === 'schermo') {
      try {
        await pool.query(
          `UPDATE settings SET valore3 = $1
           WHERE tenant_id = $2 AND argument = $3 AND campo = $4 AND id <> $5`,
          [savedRow.valore3, savedRow.tenant_id, savedRow.argument, savedRow.campo, savedRow.id]
        );
      } catch (e) { /* la propagazione non deve far fallire il salvataggio principale */ }
    }

    res.json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// DELETE - Delete record
app.delete('/api/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);
    const id = req.params.id;

    if (!(await isManagedTable(tableName, pool))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // Isolamento clienti (ACL): un non-admin può eliminare una riga di "clients" solo se
    // proprietario o con condivisione in scrittura.
    if (tableName === 'clients' && !isAdminUser(req) && dbKey === 'main') {
      const acc = await clientAccessByArgument(id, req, true);
      if (!acc) return res.status(403).json({ error: 'Non autorizzato a eliminare questo cliente' });
    }

    // Isolamento multi-tenant: i non-admin cancellano solo i record del proprio
    // tenant; gli admin possono cancellare record di qualsiasi tenant.
    const tableColumns = await getTableColumns(tableName, pool, dbKey);
    let query = `DELETE FROM "${tableName}" WHERE id = $1 RETURNING *`;
    const values = [id];
    if (tableColumns.has('tenant_id') && !isAdminUser(req)) {
      query = `DELETE FROM "${tableName}" WHERE id = $1 AND tenant_id = $2 RETURNING *`;
      values.push(req.user.tenant_id);
    }

    const result = await pool.query(query, values);

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
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);

    if (!(await isManagedTable(tableName, pool))) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da importare' });
    }

    const tableColumns = await getTableColumns(tableName, pool, dbKey);
    const generatedColumns = await getGeneratedColumns(tableName, pool, dbKey);
    const admin = isAdminUser(req);
    const userKey = (req.user.user_id || req.user.email) + ':' + dbKey; // import per (utente, DB)

    // Se c'era già un import in sospeso per l'utente, annullalo prima di iniziarne uno nuovo
    const prev = takePendingImport(userKey);
    if (prev) {
      try { await prev.query('ROLLBACK'); } catch (e) { /* ignore */ }
      prev.release();
    }

    const client = await pool.connect();
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
  const userKey = (req.user.user_id || req.user.email) + ':' + pickDbKey(req);
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
  const userKey = (req.user.user_id || req.user.email) + ':' + pickDbKey(req);
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
    // Oltre al nome dell'argomento restituisce i dati della riga "segnaposto" (campo IS NULL):
    // tipo_valore, id e valore2. Servono a mostrare inline un campo editabile (es. tipo 50).
    const result = await db.query(
      `SELECT argument,
              MAX(CASE WHEN campo IS NULL THEN tipo_valore END) AS tipo_valore,
              MAX(CASE WHEN campo IS NULL THEN id::text END)    AS id,
              MAX(CASE WHEN campo IS NULL THEN valore2 END)     AS valore2
       FROM settings
       WHERE tenant_id = $1 AND user_id = $2 AND argument IS NOT NULL
         AND (id_roles IS NULL OR id_roles >= $3)
       GROUP BY argument
       -- Nascondi gli argomenti la cui riga segnaposto (campo IS NULL) ha scadenza < oggi.
       HAVING COALESCE(MAX(CASE WHEN campo IS NULL AND scadenza IS NOT NULL AND scadenza < CURRENT_DATE THEN 1 END), 0) = 0
       -- Ordina per l'ordinamento della riga segnaposto (campo IS NULL) = posizione dell'argomento,
       -- non per il MIN su tutte le righe (i campi di dettaglio hanno un proprio ordinamento).
       ORDER BY MAX(CASE WHEN campo IS NULL THEN ordinamento END) NULLS LAST, argument`,
      [req.user.tenant_id, req.user.user_id, roleLevel]
    );
    res.json(result.rows);
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

// ===================== PROVISIONING NUOVO UTENTE =====================
// Routine per il campo tipo_valore=50 con valore2='Nuovo_utente': un super user crea un
// nuovo utente della propria azienda. Scrive in cascata: Projexa-Auth.users (genera l'id) ->
// Projexa.users (stesso id) -> user_tenants (associa al tenant del creatore).
// Colonne mai mostrate/gestite dal form (auto o sensibili).
const NEW_USER_HIDDEN = new Set(['id', 'created_at', 'updated_at', 'updated_by', 'password_hash']);
const NEW_USER_LABELS = { email: 'Email', name: 'Nome', cognome: 'Cognome', scadenza: 'Scadenza' };

// Config del form: campi editabili delle due tabelle users + ruoli selezionabili (>= al proprio) +
// scadenza ereditata dal creatore (sola lettura).
app.get('/api/provisioning/new-user-config', requireAuth, async (req, res) => {
  try {
    const mainCols = await getTableColumns('users', db, 'main');
    const authCols = await getTableColumns('users', authDb, 'auth');

    // Scadenza del creatore (super user), letta da Projexa-Auth.
    let inheritedScadenza = '';
    try {
      const sc = await authDb.query('SELECT scadenza FROM users WHERE id = $1', [req.user.user_id]);
      const v = sc.rows[0] && sc.rows[0].scadenza;
      if (v) inheritedScadenza = new Date(v).toISOString().slice(0, 10);
    } catch (e) { /* ignore */ }

    const editable = [];
    let scadenzaField = null;
    // Projexa-Auth.users: email editabile; scadenza sola lettura (ereditata).
    for (const c of authCols) {
      if (NEW_USER_HIDDEN.has(c)) continue;
      if (c === 'scadenza') {
        scadenzaField = { name: 'scadenza', source: 'auth', label: NEW_USER_LABELS.scadenza, type: 'date', readonly: true, value: inheritedScadenza };
      } else {
        editable.push({ name: c, source: 'auth', label: NEW_USER_LABELS[c] || c, type: (c === 'email' ? 'email' : 'text'), readonly: false, value: '' });
      }
    }
    // Projexa.users (stub): name, cognome, ecc.
    for (const c of mainCols) {
      if (NEW_USER_HIDDEN.has(c)) continue;
      editable.push({ name: c, source: 'main', label: NEW_USER_LABELS[c] || c, type: 'text', readonly: false, value: '' });
    }
    const fields = scadenzaField ? [...editable, scadenzaField] : editable;

    // Ruoli selezionabili: solo id_roles >= a quello del creatore (uguale o meno privilegiato).
    const level = Number(req.user.id_roles);
    const rolesRes = await db.query(
      `SELECT id, id_roles, name FROM roles WHERE id_roles >= $1 ORDER BY id_roles`,
      [Number.isFinite(level) ? level : 9999]
    );

    // Nome del tenant del creatore (mostrato in sola lettura in cima al flyout).
    let tenantName = '';
    try {
      const t = await db.query('SELECT name FROM tenants WHERE id = $1', [req.user.tenant_id]);
      if (t.rows[0]) tenantName = t.rows[0].name || '';
    } catch (e) { /* ignore */ }

    res.json({ fields, roles: rolesRes.rows, tenantName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crea il nuovo utente in cascata sui due DB + user_tenants.
app.post('/api/provisioning/new-user', requireAuth, async (req, res) => {
  const fieldsIn = (req.body && req.body.fields) || {};
  const roleId = (req.body && req.body.roleId) ? String(req.body.roleId) : '';
  const email = String(fieldsIn.email || '').trim();
  const name = String(fieldsIn.name || '').trim();
  try {
    if (!email) return res.status(400).json({ error: 'Email obbligatoria' });
    if (!name) return res.status(400).json({ error: 'Nome obbligatorio' });
    if (!roleId) return res.status(400).json({ error: 'Ruolo obbligatorio' });

    // Ricava id_roles dalla riga ruolo selezionata (role_id = roles.id).
    const roleRow = await db.query('SELECT id, id_roles FROM roles WHERE id = $1 LIMIT 1', [roleId]);
    if (!roleRow.rows[0]) return res.status(400).json({ error: 'Ruolo non valido' });
    const idRoles = Number(roleRow.rows[0].id_roles);

    // Privilegio: non si può assegnare un ruolo più privilegiato del proprio (id_roles più basso).
    const myLevel = Number(req.user.id_roles);
    if (Number.isFinite(myLevel) && idRoles < myLevel) {
      return res.status(403).json({ error: 'Non puoi assegnare un ruolo più privilegiato del tuo' });
    }

    const mainCols = await getTableColumns('users', db, 'main');
    const authCols = await getTableColumns('users', authDb, 'auth');

    // Scadenza ereditata dal creatore (Projexa-Auth).
    let inheritedScadenza = null;
    const scRes = await authDb.query('SELECT scadenza FROM users WHERE id = $1', [req.user.user_id]);
    if (scRes.rows[0]) inheritedScadenza = scRes.rows[0].scadenza;

    // 1) Projexa-Auth.users: password non gestita ora -> hash casuale (accesso via OAuth o reset).
    const randomHash = await bcrypt.hash(String(Date.now()) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), 10);
    const aCols = ['email', 'password_hash'];
    const aVals = [email, randomHash];
    if (authCols.has('scadenza'))   { aCols.push('scadenza');   aVals.push(inheritedScadenza); }
    if (authCols.has('created_at')) { aCols.push('created_at'); aVals.push(new Date()); }
    if (authCols.has('updated_at')) { aCols.push('updated_at'); aVals.push(new Date()); }
    let newId;
    try {
      const insAuth = await authDb.query(
        `INSERT INTO users (${aCols.map(c => `"${c}"`).join(', ')}) VALUES (${aCols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        aVals
      );
      newId = insAuth.rows[0].id;
    } catch (e) {
      if (e && e.code === '23505') return res.status(409).json({ error: 'Email già registrata' });
      throw e;
    }

    // 2) Projexa.users (stesso id) + user_tenants, in transazione (stesso DB).
    //    In caso di errore: ROLLBACK e compensazione della riga già creata su Auth.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const mCols = ['id'];
      const mVals = [newId];
      if (mainCols.has('name'))       { mCols.push('name');       mVals.push(name); }
      if (mainCols.has('cognome'))    { mCols.push('cognome');    mVals.push(String(fieldsIn.cognome || '').trim() || null); }
      if (mainCols.has('created_at')) { mCols.push('created_at'); mVals.push(new Date()); }
      if (mainCols.has('updated_at')) { mCols.push('updated_at'); mVals.push(new Date()); }
      // updated_by è un uuid (riferimento utente): registra chi ha creato la riga = il super user.
      if (mainCols.has('updated_by')) { mCols.push('updated_by'); mVals.push(req.user.user_id); }
      await client.query(
        `INSERT INTO users (${mCols.map(c => `"${c}"`).join(', ')}) VALUES (${mCols.map((_, i) => `$${i + 1}`).join(', ')})`,
        mVals
      );
      // user_tenants: associa al tenant del creatore (attiva il trigger di seeding settings).
      // role_id = id (uuid) della riga in roles; id_roles = livello del ruolo.
      await client.query(
        `INSERT INTO user_tenants (user_id, tenant_id, role_id, id_roles) VALUES ($1, $2, $3, $4)`,
        [newId, req.user.tenant_id, roleId, idRoles]
      );
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      try { await authDb.query('DELETE FROM users WHERE id = $1', [newId]); } catch (_) { /* compensazione */ }
      client.release();
      throw e;
    }
    client.release();

    res.status(201).json({ success: true, id: newId });
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
    const admin = isAdminUser(req);

    // Eccezione: la visibilità dei clienti scaduti dipende dal booleano
    // Impostazioni/Gestione Clienti/"Mostra tutti i clienti" (valore1).
    // ON = mostra tutti; OFF (o assente) = nascondi i clienti con scadenza < oggi.
    // Per l'admin (nessun tenant/utente proprio su cui leggere questa preferenza)
    // usiamo il default prudente: nascondi i clienti scaduti.
    let showAll = false;
    if (!admin) {
      const pref = await db.query(
        `SELECT valore1 FROM settings
         WHERE tenant_id = $1 AND user_id = $2
           AND argument = 'Gestione Clienti' AND campo = 'Mostra tutti i clienti' LIMIT 1`,
        [req.user.tenant_id, req.user.user_id]
      );
      const v = pref.rows[0] && pref.rows[0].valore1;
      showAll = (v === true || v === 't' || v === 'true');
    }
    const scadCond = showAll ? '' : ` AND (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE)`;

    // Sempre filtrato per tenant_id e user_id del login, anche per gli amministratori:
    // un admin loggato sul tenant Projexa non deve vedere i clienti di altri tenant
    // (es. Teamsystem) in questa lista (Clienti / Progetti clienti / filtro in alto).
    // Clienti propri + clienti condivisi con me (ACL). Un flag "shared" distingue i secondi.
    const result = await db.query(
      `SELECT id, valore2 AS name,
              (user_id <> $2) AS shared
       FROM clients c
       WHERE argument = 'Cliente' AND campo = 'Cliente'
         AND tenant_id = $1 AND valore2 IS NOT NULL${scadCond}
         AND (user_id = $2 OR EXISTS (
               SELECT 1 FROM client_shares s
               WHERE s.client_id = c.id AND s.shared_with_user_id = $2 AND s.tenant_id = $1))
       ORDER BY valore2`,
      [req.user.tenant_id, req.user.user_id]
    );
    res.json(result.rows); // [{ id, name, shared }, ...]
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
    `SELECT id, campo, tipo_valore, id_roles, ordinamento, tabella, colonna, layout_col, layout_span, "VariabDB" AS variabdb
     FROM clients
     WHERE argument = $1 AND campo IS NOT NULL AND campo <> 'Cliente'
     ORDER BY ordinamento NULLS LAST, campo`,
    [srcArg]
  )).rows;
  for (const r of rows) {
    const insRes = await dbClient.query(
      `INSERT INTO clients (tenant_id, user_id, argument, campo, tipo_valore, id_roles, ordinamento, tabella, colonna, layout_col, layout_span, "VariabDB")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [tenantId, userId, newArg, r.campo, r.tipo_valore, r.id_roles, r.ordinamento, r.tabella, r.colonna, r.layout_col, r.layout_span, r.variabdb]
    );
    const newId = insRes.rows[0].id;
    // Nodo Padre: copia ricorsivamente i figli (argument = id del nodo sorgente -> nuovo nodo).
    if (String(r.tipo_valore) === '0') {
      await deepCopyClientTree(dbClient, tenantId, userId, String(r.id), String(newId));
    }
  }
}

// ===== Condivisione "viva" (ACL) dei clienti =====
// Risale dalla riga (id) alla riga identità del cliente (argument='Cliente') e ne restituisce
// { clientId, ownerUserId }, oppure null. idOrArgument = id di una qualsiasi riga dell'albero.
async function resolveClientRoot(idOrArgument, tenantId) {
  let cur = idOrArgument, guard = 0;
  while (cur && guard++ < 60) {
    const r = await db.query('SELECT id, argument, user_id FROM clients WHERE id = $1 AND tenant_id = $2', [cur, tenantId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (row.argument === 'Cliente') return { clientId: row.id, ownerUserId: row.user_id };
    cur = row.argument; // sali al contenitore padre
  }
  return null;
}

// Accesso dell'utente corrente a un cliente (id riga identità). Restituisce
// { ownerUserId, permission, isOwner } oppure null se nessun accesso.
async function clientAccess(clientId, req, needWrite) {
  const c = await db.query(
    `SELECT user_id FROM clients WHERE id = $1 AND argument = 'Cliente' AND campo = 'Cliente' AND tenant_id = $2`,
    [clientId, req.user.tenant_id]
  );
  if (c.rows.length === 0) return null;
  const ownerUserId = c.rows[0].user_id;
  if (String(ownerUserId) === String(req.user.user_id)) return { ownerUserId, permission: 'write', isOwner: true };
  const s = await db.query(
    'SELECT permission FROM client_shares WHERE client_id = $1 AND shared_with_user_id = $2 AND tenant_id = $3 LIMIT 1',
    [clientId, req.user.user_id, req.user.tenant_id]
  );
  if (s.rows.length === 0) return null;
  const permission = s.rows[0].permission || 'read';
  if (needWrite && permission !== 'write') return null;
  return { ownerUserId, permission, isOwner: false };
}

// Accesso a partire da un "argument" (container: id cliente o id Nodo Padre).
async function clientAccessByArgument(argument, req, needWrite) {
  const root = await resolveClientRoot(argument, req.user.tenant_id);
  if (!root) return null;
  const acc = await clientAccess(root.clientId, req, needWrite);
  return acc ? { ...acc, clientId: root.clientId } : null;
}

// Verifica che il campo tipo 15 (fieldId) sia configurato per la condivisione cliente:
// in function_db deve esistere una riga con cod_istruzione = <campo>.valore3, istruzione='insert'
// e funzione 'Condvidi_Cliente' (accetto anche la grafia corretta 'Condividi_Cliente').
async function assertShareClientFunction(source, fieldId, req) {
  const f = await db.query(
    `SELECT valore3 FROM "${source}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [fieldId, req.user.tenant_id, req.user.user_id]
  );
  if (f.rows.length === 0) throw Object.assign(new Error('Campo non trovato'), { statusCode: 404 });
  const cod = (f.rows[0].valore3 == null) ? null : Number(f.rows[0].valore3);
  if (!Number.isFinite(cod)) throw Object.assign(new Error('valore3 non impostato sul campo'), { statusCode: 400 });
  const fdb = await db.query(
    `SELECT 1 FROM function_db
     WHERE cod_istruzione = $1 AND lower(istruzione) = 'insert'
       AND funzione IN ('Condvidi_Cliente', 'Condividi_Cliente') LIMIT 1`,
    [cod]
  );
  if (fdb.rows.length === 0) throw Object.assign(new Error('Funzione di condivisione non configurata'), { statusCode: 400 });
  return { cod };
}

// Condivisione cliente — passo 1: elenco degli utenti dello stesso tenant con cui condividere,
// escluso l'utente corrente, il proprietario del cliente e chi ha già accesso.
// Restituisce nome, cognome (da Projexa) ed email (da Projexa-Auth).
app.get('/api/:source(settings|clients)/share-users', requireAuth, async (req, res) => {
  try {
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const clientId = ((req.query && req.query.clientId) || '').trim();
    if (!fieldId) return res.status(400).json({ error: 'fieldId richiesto' });
    await assertShareClientFunction(req.params.source, fieldId, req);

    // Chi può condividere: proprietario o chi ha una condivisione 'write'.
    let ownerUserId = null;
    if (clientId) {
      const acc = await clientAccess(clientId, req, true);
      if (!acc) return res.status(403).json({ error: 'Non hai i permessi per condividere questo cliente' });
      ownerUserId = acc.ownerUserId;
    }

    const us = await db.query(
      `SELECT ut.user_id, u.name, u.cognome
       FROM user_tenants ut JOIN users u ON u.id = ut.user_id
       WHERE ut.tenant_id = $1 AND ut.user_id <> $2
         AND ($3::uuid IS NULL OR ut.user_id <> $3)
         AND ($4::uuid IS NULL OR NOT EXISTS (
               SELECT 1 FROM client_shares s
               WHERE s.client_id = $4 AND s.shared_with_user_id = ut.user_id))
       ORDER BY u.name NULLS LAST, u.cognome NULLS LAST`,
      [req.user.tenant_id, req.user.user_id, ownerUserId, clientId || null]
    );
    const users = us.rows;
    if (users.length) {
      const ids = users.map(u => u.user_id);
      try {
        const em = await authDb.query('SELECT id, email FROM users WHERE id = ANY($1)', [ids]);
        const byId = new Map(em.rows.map(r => [String(r.id), r.email]));
        for (const u of users) u.email = byId.get(String(u.user_id)) || '';
      } catch (e) { for (const u of users) u.email = ''; }
    }
    res.json({ users });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Condivisione cliente — passo 2: crea/aggiorna la condivisione ACL (nessuna copia dei dati).
// body: { fieldId, clientId, targetUserId, permission ('read'|'write') }.
app.post('/api/:source(settings|clients)/share-client', requireAuth, async (req, res) => {
  const source = req.params.source;
  const fieldId = ((req.body && req.body.fieldId) || '').trim();
  const clientId = ((req.body && req.body.clientId) || '').trim();
  const targetUserId = ((req.body && req.body.targetUserId) || '').trim();
  let permission = ((req.body && req.body.permission) || 'write').trim().toLowerCase();
  if (permission !== 'read' && permission !== 'write') permission = 'write';
  if (!fieldId || !clientId || !targetUserId) {
    return res.status(400).json({ error: 'fieldId, clientId e targetUserId richiesti' });
  }
  try {
    await assertShareClientFunction(source, fieldId, req);
    if (String(targetUserId) === String(req.user.user_id)) {
      return res.status(400).json({ error: 'Non puoi condividere con te stesso' });
    }
    // Chi condivide deve avere accesso in scrittura al cliente (proprietario o share 'write').
    const acc = await clientAccess(clientId, req, true);
    if (!acc) return res.status(403).json({ error: 'Non hai i permessi per condividere questo cliente' });
    if (String(targetUserId) === String(acc.ownerUserId)) {
      return res.status(400).json({ error: 'Il cliente è già del proprietario' });
    }
    // Il destinatario deve appartenere allo stesso tenant.
    const tgt = await db.query(
      'SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2 LIMIT 1',
      [targetUserId, req.user.tenant_id]
    );
    if (tgt.rows.length === 0) return res.status(400).json({ error: 'Utente non appartenente al tenant' });

    // Crea/aggiorna la condivisione (ri-condividere aggiorna il permesso).
    await db.query(
      `INSERT INTO client_shares (tenant_id, client_id, shared_with_user_id, owner_user_id, permission, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (client_id, shared_with_user_id)
       DO UPDATE SET permission = EXCLUDED.permission`,
      [req.user.tenant_id, clientId, targetUserId, acc.ownerUserId, permission, req.user.user_id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Crea un nuovo cliente (riga argument='Cliente', campo='Cliente', valore2=<nome>) e
// ne copia la STRUTTURA (valori vuoti) da un cliente modello, preservando la gerarchia.
// Consentito agli utenti con ruolo id_roles <= 70 (numeri più bassi = più privilegi):
// super user, admin e Project Manager.
app.post('/api/clients', requireAuth, async (req, res) => {
  const roleLevel = Number(req.user.id_roles);
  if (!Number.isFinite(roleLevel) || roleLevel > 70) {
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

// ===================== PROGETTI CLIENTI (tabella projects, EAV, scoped per client_id) =====================
// Copia ricorsivamente la STRUTTURA dei campi di un progetto (valori vuoti), preservando la
// gerarchia (Nodo Padre + figli). I nuovi campi ereditano tenant/user/client del destinatario.
async function deepCopyProjectTree(dbClient, tenantId, userId, clientId, srcArg, newArg) {
  const rows = (await dbClient.query(
    `SELECT id, campo, tipo_valore, id_roles, ordinamento, tabella, colonna, layout_col, layout_span, "VariabDB" AS variabdb
     FROM projects WHERE argument = $1 AND campo IS NOT NULL AND campo <> 'Progetto'
     ORDER BY ordinamento NULLS LAST, campo`,
    [srcArg]
  )).rows;
  for (const r of rows) {
    const ins = await dbClient.query(
      `INSERT INTO projects (tenant_id, user_id, client_id, argument, campo, tipo_valore, id_roles, ordinamento, tabella, colonna, layout_col, layout_span, "VariabDB")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [tenantId, userId, clientId, newArg, r.campo, r.tipo_valore, r.id_roles, r.ordinamento, r.tabella, r.colonna, r.layout_col, r.layout_span, r.variabdb]
    );
    // Verifica se esistono figli reali sotto questa riga (argument = id sorgente), a prescindere
    // dal flag tipo_valore: nel template master alcuni contenitori non sono marcati "0" ma hanno
    // comunque righe figlie (argument = id di questa riga) che vanno copiate ricorsivamente.
    const hasChildren = await dbClient.query(
      `SELECT 1 FROM projects WHERE argument = $1 AND campo IS NOT NULL AND campo <> 'Progetto' LIMIT 1`,
      [String(r.id)]
    );
    if (hasChildren.rows.length > 0) {
      await deepCopyProjectTree(dbClient, tenantId, userId, clientId, String(r.id), String(ins.rows[0].id));
    }
  }
}

// Elenco progetti. Con clientId -> i progetti di quel cliente (livello 2); senza clientId ->
// tutti i progetti dell'utente (per la tendina "modello" alla creazione).
app.get('/api/projects/list', requireAuth, async (req, res) => {
  try {
    const clientId = ((req.query && req.query.clientId) || '').trim();
    const params = [req.user.tenant_id, req.user.user_id];
    let where = `argument = 'Progetto' AND campo = 'Progetto' AND tenant_id = $1 AND user_id = $2 AND valore2 IS NOT NULL
                 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`;
    if (clientId) { params.push(clientId); where += ` AND client_id = $${params.length}`; }
    const r = await db.query(
      `SELECT id, valore2 AS name, client_id FROM projects WHERE ${where} ORDER BY valore2`,
      params
    );
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crea un nuovo progetto per un cliente: riga identità (argument='Progetto', campo='Progetto',
// valore2=nome, client_id) + copia della struttura da un progetto modello scelto
// (sourceProjectId) o, in mancanza, dal master 'PROGETTO_COPIA' del tenant PROJEXA.
app.post('/api/projects', requireAuth, async (req, res) => {
  const roleLevel = Number(req.user.id_roles);
  if (!Number.isFinite(roleLevel) || roleLevel > 70) {
    return res.status(403).json({ error: 'Non autorizzato a creare progetti' });
  }
  const clientId = ((req.body && req.body.clientId) || '').trim();
  const name = ((req.body && req.body.name) || '').trim();
  const sourceProjectId = ((req.body && req.body.sourceProjectId) || '').trim();
  if (!clientId) return res.status(400).json({ error: 'clientId richiesto' });
  if (!name) return res.status(400).json({ error: 'Nome progetto richiesto' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 1) Riga identità del progetto.
    const ins = await client.query(
      `INSERT INTO projects (argument, campo, valore2, tenant_id, user_id, client_id)
       VALUES ('Progetto', 'Progetto', $1, $2, $3, $4) RETURNING *`,
      [name, req.user.tenant_id, req.user.user_id, clientId]
    );
    const newProject = ins.rows[0];

    // 2) Sorgente struttura: progetto modello scelto (stesso tenant+utente) o master PROGETTO_COPIA.
    let srcId = null;
    if (sourceProjectId) {
      const v = await client.query(
        `SELECT id FROM projects WHERE id = $1 AND argument='Progetto' AND campo='Progetto'
           AND tenant_id = $2 AND user_id = $3`,
        [sourceProjectId, req.user.tenant_id, req.user.user_id]
      );
      if (v.rows.length) srcId = v.rows[0].id;
    }
    if (!srcId) {
      const m = await client.query(
        `SELECT p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id
         WHERE t.name = 'PROJEXA' AND p.argument='Progetto' AND p.campo='Progetto'
           AND p.valore2 = 'PROGETTO_COPIA' LIMIT 1`
      );
      if (m.rows.length) srcId = m.rows[0].id;
    }
    if (srcId) {
      await deepCopyProjectTree(client, req.user.tenant_id, req.user.user_id, clientId, srcId, newProject.id);
    }

    await client.query('COMMIT');
    res.status(201).json(newProject);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Colonne configurate per un dato tipo_valore (usate dal form mobile Aggiungi/Modifica campo).
// Filtra SEMPRE anche per tabella (settings/clients/projects, cioè la sorgente corrente del
// flyout): la stessa configurazione tipo_valore può avere colonne diverse a seconda della
// tabella di destinazione. Cerca prima le righe del proprio tenant; se assenti, ripiega
// sulle righe globali (tenant_id IS NULL), configurazione standard di sistema.
app.get('/api/set-var-layout', requireAuth, async (req, res) => {
  try {
    const tipoValore = ((req.query && req.query.tipo_valore) || '').trim();
    const tabella = ((req.query && req.query.source) || '').trim();
    if (!tipoValore) return res.status(400).json({ error: 'tipo_valore richiesto' });
    if (!tabella || !['settings', 'clients', 'projects'].includes(tabella)) {
      return res.status(400).json({ error: 'source richiesto (settings, clients o projects)' });
    }
    // "valori" (opzionale): se configurato, es. "1:Aperto;2:Chiuso", il campo va mostrato
    // come menu a discesa nel form Aggiungi/Modifica (scrive il codice, mostra l'etichetta).
    let r;
    try {
      r = await db.query(
        `SELECT colonna, valori FROM set_var_layout WHERE tenant_id = $1 AND tipo_valore = $2 AND tabella = $3 ORDER BY ordinamento NULLS LAST, colonna`,
        [req.user.tenant_id, tipoValore, tabella]
      );
      if (r.rows.length === 0) {
        r = await db.query(
          `SELECT colonna, valori FROM set_var_layout WHERE tenant_id IS NULL AND tipo_valore = $1 AND tabella = $2 ORDER BY ordinamento NULLS LAST, colonna`,
          [tipoValore, tabella]
        );
      }
    } catch (e) {
      // Fallback per compatibilità se la colonna "valori" non esiste ancora sul DB.
      r = await db.query(
        `SELECT colonna FROM set_var_layout WHERE tenant_id = $1 AND tipo_valore = $2 AND tabella = $3 ORDER BY ordinamento NULLS LAST, colonna`,
        [req.user.tenant_id, tipoValore, tabella]
      );
      if (r.rows.length === 0) {
        r = await db.query(
          `SELECT colonna FROM set_var_layout WHERE tenant_id IS NULL AND tipo_valore = $1 AND tabella = $2 ORDER BY ordinamento NULLS LAST, colonna`,
          [tipoValore, tabella]
        );
      }
    }
    const columns = r.rows.map(x => x.colonna).filter(Boolean);
    const fields = r.rows.filter(x => x.colonna).map(x => ({ colonna: x.colonna, valori: x.valori || null }));
    res.json({ columns, fields });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Contesto leggibile dei form Aggiungi/Modifica dei flyout.
// Gli ID reali restano nel contesto autenticato/server; il client riceve solo
// le descrizioni da mostrare in sola lettura. Per clients il client_id è l'id
// del cliente corrente, mentre per projects è il client_id del progetto corrente.
app.get('/api/flyout/context', requireAuth, async (req, res) => {
  try {
    const source = String(req.query?.source || '').trim();
    if (!['settings', 'clients', 'projects'].includes(source)) {
      return res.status(400).json({ error: 'source richiesto (settings, clients o projects)' });
    }

    const tenantResult = await db.query(
      'SELECT id, name FROM tenants WHERE id = $1 LIMIT 1',
      [req.user.tenant_id]
    );

    const userResult = await db.query(
      `SELECT id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', cognome, name)), ''), id::text) AS name
       FROM users WHERE id = $1 LIMIT 1`,
      [req.user.user_id]
    );

    let clientId = String(req.query?.clientId || '').trim();
    let projectId = String(req.query?.projectId || '').trim();
    if (source === 'clients') {
      clientId = clientId || '';
      if (clientId) {
        const root = await resolveClientRoot(clientId, req.user.tenant_id);
        if (root) clientId = String(root.clientId);
        else clientId = '';
      }
    } else if (source === 'projects') {
      // Nel flyout Progetti il project_id è l'id della riga identità del progetto
      // (projects.id / ele_progetti.project_id). Ricaviamo sempre da quello il client_id,
      // così il form non può perdere il contesto del progetto corrente.
      if (projectId) {
        const project = await db.query(
          `SELECT id, client_id, valore2 AS name
           FROM projects
           WHERE id = $1 AND tenant_id = $2 AND user_id = $3
             AND argument = 'Progetto' AND campo = 'Progetto'
           LIMIT 1`,
          [projectId, req.user.tenant_id, req.user.user_id]
        );
        if (project.rows.length > 0) {
          clientId = String(project.rows[0].client_id || clientId || '');
        } else {
          projectId = '';
        }
      }
      if (clientId) {
        const client = await db.query(
          `SELECT id FROM clients WHERE id = $1 AND tenant_id = $2 AND argument = 'Cliente' AND campo = 'Cliente' LIMIT 1`,
          [clientId, req.user.tenant_id]
        );
        if (client.rows.length === 0) clientId = '';
      }
    } else {
      clientId = '';
      projectId = '';
    }

    let clientResult = { rows: [] };
    if (clientId) {
      clientResult = await db.query(
        `SELECT id, valore2 AS name
         FROM clients
         WHERE id = $1 AND tenant_id = $2 AND argument = 'Cliente' AND campo = 'Cliente'
         LIMIT 1`,
        [clientId, req.user.tenant_id]
      );
    }

    let projectResult = { rows: [] };
    if (source === 'projects' && projectId) {
      projectResult = await db.query(
        `SELECT id, valore2 AS name, client_id
         FROM projects
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3
           AND argument = 'Progetto' AND campo = 'Progetto'
         LIMIT 1`,
        [projectId, req.user.tenant_id, req.user.user_id]
      );
    }

    res.json({
      tenant: tenantResult.rows[0] || { id: req.user.tenant_id, name: '' },
      user: userResult.rows[0] || { id: req.user.user_id, name: '' },
      client: clientResult.rows[0] || (clientId ? { id: clientId, name: '' } : null),
      project: projectResult.rows[0] || (projectId ? { id: projectId, name: '' } : null)
    });
  } catch (error) {
    console.error('[FLYOUT CONTEXT]', error);
    res.status(500).json({ error: error.message });
  }
});

// Restituisce il tenant del contesto autenticato (sola lettura), da mostrare nei form
// Aggiungi/Modifica di tutti i flyout (evita l'errore di inserimento per tenant mancante).
app.get('/api/tenant/current', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT id, name FROM tenants WHERE id = $1', [req.user.tenant_id]);
    res.json(r.rows[0] || { id: req.user.tenant_id, name: '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Elenco clienti per i menu a discesa dei campi client_id: usa la vista ele_clienti,
// filtrata per tenant_id e user_id del CONTESTO (login corrente).
app.get('/api/lookup/clients', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, valore2 AS name FROM ele_clienti WHERE tenant_id = $1 AND user_id = $2 ORDER BY valore2',
      [req.user.tenant_id, req.user.user_id]
    );
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Elenco progetti per i menu a discesa dei campi project_id: usa la vista ele_progetti,
// filtrata per tenant_id, user_id (contesto) e client_id (se indicato).
app.get('/api/lookup/projects', requireAuth, async (req, res) => {
  try {
    const clientId = ((req.query && req.query.clientId) || '').trim();
    const params = [req.user.tenant_id, req.user.user_id];
    let where = 'tenant_id = $1 AND user_id = $2';
    if (clientId) { params.push(clientId); where += ` AND client_id = $${params.length}`; }
    const r = await db.query(`SELECT id, valore2 AS name FROM ele_progetti WHERE ${where} ORDER BY valore2`, params);
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
// valore2='schermo'. 100 = normale; es. 70 = interfaccia al 70%.
// Cascata di ricerca: prima l'eventuale valore personale dell'utente del login (così
// resta possibile una preferenza individuale); se assente, qualunque valore configurato
// per il tenant, in modo che la scala si applichi a TUTTI gli utenti del tenant e non solo
// a chi l'ha impostata. tenant_id/user_id derivano sempre dal token corrente, quindi la
// stessa logica vale automaticamente anche durante l'impersonificazione.
app.get('/api/settings/screen-scale', requireAuth, async (req, res) => {
  try {
    let result = await db.query(
      `SELECT valore3 FROM settings
       WHERE tenant_id = $1 AND user_id = $2 AND tipo_valore = '30' AND valore2 = 'schermo'
         AND valore3 IS NOT NULL
       ORDER BY valore3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id]
    );
    if (result.rows.length === 0) {
      result = await db.query(
        `SELECT valore3 FROM settings
         WHERE tenant_id = $1 AND tipo_valore = '30' AND valore2 = 'schermo'
           AND valore3 IS NOT NULL
         ORDER BY valore3 LIMIT 1`,
        [req.user.tenant_id]
      );
    }
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
app.post('/api/:source(settings|clients|projects)/field', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const clientId = ((req.body && req.body.clientId) || '').trim();
    // Per i progetti: id del cliente (colonna client_id); "clientId" qui è invece l'id del progetto (argument).
    const projClientId = ((req.body && req.body.projClientId) || '').trim() || null;
    const rawCampo = ((req.body && req.body.campo) || '').trim();
    const tipoValore = (req.body && req.body.tipo_valore) || null;
    const tabella = ((req.body && req.body.tabella) || '').trim() || null;
    const colonna = ((req.body && req.body.colonna) || '').trim() || null;
    const variabDb = ((req.body && req.body.VariabDB) || '').trim() || null; // colonna "VariabDB"
    const valore2 = ((req.body && req.body.valore2) || '').trim() || null;   // valore iniziale (es. tipo 30)
    const scope = (req.body && req.body.scope) || 'this';
    const tenantScope = (req.body && req.body.tenantScope) || 'this-tenant';
    const isAdminTenantScope = Number(req.user.id_roles) === 1;
    if (tenantScope === 'all-tenants' && !isAdminTenantScope) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
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
    const isStandard = (kind === 'standard') && roleLevel === 1;
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

    if (tenantScope === 'all-tenants' && isAdminTenantScope) {
      // Admin: la scelta Tenant è indipendente dalla scelta Cliente/Progetto.
      // 'all' = tutti i contenitori di tutti i tenant; 'this' = il contenitore
      // logicamente corrispondente in tutti i tenant, usando la sua etichetta valore2.
      let containerValue = null;
      if (scope === 'this' && clientId) {
        const currentContainer = await db.query(
          `SELECT valore2 FROM "${source}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [clientId, req.user.tenant_id]
        );
        containerValue = currentContainer.rows[0]?.valore2 ?? null;
      }
      const rootCampo = source === 'projects' ? 'Progetto' : containerCampo;
      const whereValue = (scope === 'this' && containerValue != null)
        ? ' AND c.valore2 = $10' : '';
      // Progetti: la tabella richiede sempre client_id. Nel contenitore sorgente (c)
      // il client_id è già presente: lo trasciniamo nella nuova riga.
      const clientIdCol = source === 'projects' ? ', client_id' : '';
      const clientIdSel = source === 'projects' ? ', c.client_id' : '';
      const q = `INSERT INTO "${source}" (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles${clientIdCol})
        SELECT c.id::text, $1, $2, $3, $4, $5, $6, c.tenant_id, c.user_id,
               COALESCE((SELECT MAX(x.ordinamento) + 1 FROM "${source}" x WHERE x.tenant_id = c.tenant_id AND x.campo NOT LIKE '(*)%'), $7), $8::smallint${clientIdSel}
        FROM "${source}" c
        WHERE c.campo = $9${whereValue}`;
      const params = [campo, tipoValore, tabella, colonna, variabDb, valore2, bandBase, idRoles, rootCampo];
      if (scope === 'this' && containerValue != null) params.push(containerValue);
      const result = await db.query(q, params);
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
      // Progetti: la tabella richiede sempre client_id, altrimenti l'INSERT fallisce
      // (o la riga perde il collegamento al cliente/progetto). Lo prendiamo dal
      // contenitore sorgente (c.client_id), che lo possiede già.
      const clientIdCol = source === 'projects' ? ', client_id' : '';
      const clientIdSel = source === 'projects' ? ', c.client_id' : '';
      const result = await db.query(
        `INSERT INTO "${source}" (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles${clientIdCol})
         SELECT c.id::text, $1, $2, $3, $4, $10, $11, $5, $6, $7, $9::smallint${clientIdSel}
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

    // Progetti: il nuovo campo porta anche client_id (scope tenant+user+client).
    if (source === 'projects') {
      const result = await db.query(
        `INSERT INTO projects (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles, client_id)
         VALUES ($1, $2, $3, $4, $5, $10, $11, $6, $7, $8, $9, $12) RETURNING *`,
        [clientId, campo, tipoValore, tabella, colonna, req.user.tenant_id, req.user.user_id, newOrd, idRoles, variabDb, valore2, projClientId]
      );
      return res.status(201).json(result.rows[0]);
    }

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
app.post('/api/:source(settings|clients|projects)/delete-fields', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const campos = (req.body && req.body.campos) || [];
    const scope = (req.body && req.body.scope) || 'this';
    const tenantScope = (req.body && req.body.tenantScope) || 'this-tenant';
    const clientId = ((req.body && req.body.clientId) || '').trim();
    if (!Array.isArray(campos) || campos.length === 0) {
      return res.status(400).json({ error: 'Nessun campo selezionato' });
    }
    // Admin (id_roles = 1): nessun vincolo -> elimina anche i campi standard.
    // Altrimenti solo i campi custom (nome con prefisso "(*)").
    const isAdmin = Number(req.user.id_roles) === 1;
    // Progetti: dati personali → il proprietario può eliminare qualsiasi campo (anche standard).
    const ordGuard = (isAdmin || source === 'projects') ? '' : "AND campo LIKE '(*)%'";
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
    } else if (tenantScope === 'all-tenants' && isAdmin) {
      if (scope === 'this' && !clientId) return res.status(400).json({ error: 'clientId richiesto' });
      if (scope === 'this') {
        const root = await db.query(`SELECT valore2 FROM "${source}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [clientId, req.user.tenant_id]);
        const logicalValue = root.rows[0]?.valore2 ?? null;
        if (logicalValue != null) {
          query = `DELETE FROM "${source}" f USING "${source}" c WHERE f.campo = ANY($1::text[]) AND c.id::text = f.argument AND c.campo = $2 AND c.valore2 = $3 ${ordGuard}`;
          params = [campos, source === 'projects' ? 'Progetto' : 'Cliente', logicalValue];
        } else {
          return res.status(400).json({ error: 'Impossibile determinare il contenitore corrispondente negli altri tenant' });
        }
      } else {
        query = `DELETE FROM "${source}" WHERE campo = ANY($1::text[]) ${ordGuard}`;
        params = [campos];
      }
    } else if (scope === 'all') {
      query = `DELETE FROM "${source}"
               WHERE campo = ANY($1::text[]) AND tenant_id = $2 AND user_id = $3 ${ordGuard}`;
      params = [campos, req.user.tenant_id, req.user.user_id];
    } else {
      if (!clientId) return res.status(400).json({ error: 'clientId richiesto' });
      query = `DELETE FROM "${source}"
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
app.post('/api/:source(settings|clients|projects)/rename-fields', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const renames = (req.body && req.body.renames) || [];
    const scope = (req.body && req.body.scope) || 'all';
    const tenantScope = (req.body && req.body.tenantScope) || 'this-tenant';
    const clientId = ((req.body && req.body.clientId) || '').trim();
    if (!Array.isArray(renames) || renames.length === 0) {
      return res.status(400).json({ error: 'Nessuna rinomina' });
    }
    const isAdmin = Number(req.user.id_roles) === 1;
    if (tenantScope === 'all-tenants' && !isAdmin) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
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
    const custGuard = (isAdmin || source === 'projects') ? '' : " AND campo LIKE '(*)%'";
    let updated = 0;
    for (const rn of renames) {
      const oldName = ((rn && rn.old) || '').trim();
      let newName = ((rn && rn.new) || '').trim();
      // Solo i campi custom mantengono il prefisso "(*)": se il campo originale era custom
      // e il prefisso è stato tolto, reinseriscilo. I campi standard restano senza prefisso.
      // Per gli utenti non admin una rinomina/modifica deve sempre produrre un
      // campo custom riconoscibile. Il prefisso viene quindi imposto anche quando
      // il campo originale era standard (non solo quando era già custom).
      if (!isAdmin) {
        newName = newName.replace(/^\(\*\)\s*/, '');
        if (newName) newName = '(*) ' + newName;
      } else {
        const wasCustom = oldName.startsWith('(*)');
        if (wasCustom && newName && !newName.startsWith('(*)')) newName = '(*) ' + newName;
      }
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
      } else if (tenantScope === 'all-tenants' && isAdmin) {
        if (scope === 'this') {
          const root = await db.query(`SELECT valore2 FROM "${source}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [clientId, req.user.tenant_id]);
          const logicalValue = root.rows[0]?.valore2 ?? null;
          if (logicalValue != null) {
            query = `UPDATE "${source}" f SET campo = $1 FROM "${source}" c
                     WHERE c.id::text = f.argument AND c.campo = $2 AND c.valore2 = $3 AND f.campo = $4${custGuard}`;
            params = [newName, source === 'projects' ? 'Progetto' : 'Cliente', logicalValue, oldName];
          } else {
            return res.status(400).json({ error: 'Impossibile determinare il contenitore corrispondente negli altri tenant' });
          }
        } else {
          query = `UPDATE "${source}" SET campo = $1 WHERE campo = $2${custGuard}`;
          params = [newName, oldName];
        }
      } else if (scope === 'this') {
        query = `UPDATE "${source}" SET campo = $1
                 WHERE campo = $2 AND argument = $3 AND tenant_id = $4 AND user_id = $5${custGuard}`;
        params = [newName, oldName, clientId, req.user.tenant_id, req.user.user_id];
      } else {
        query = `UPDATE "${source}" SET campo = $1
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
app.post('/api/:source(settings|clients|projects)/reorder-fields', requireAuth, async (req, res) => {
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

// Elenco "decodificato": colonna = lista separata da virgole di token "col" o "decode:col".
// "decode:col" mostra il valore leggibile invece dell'id:
//   - client_id            -> nome del cliente (clients.valore2 della riga identità)
//   - *_user_id/created_by -> "Cognome Nome" dell'utente
// Scope: righe della tabella filtrate per tenant e (se presente) owner_user_id/user_id = utente.
// campo/mode servono per abilitare l'eliminazione (mode=1) via function_db.
async function respondDecodedOptions(req, res, tabella, colonna, campo, mode) {
  assertValidIdentifier(tabella);
  const cols = await getTableColumns(tabella);
  if (!cols || cols.size === 0) return res.status(400).json({ error: 'Tabella inesistente: ' + tabella });

  // Parsing dei token e validazione dei nomi colonna.
  const specs = String(colonna).split(',').map(s => s.trim()).filter(Boolean).map(tok => {
    const decode = /^decode:/i.test(tok);
    const col = tok.replace(/^decode:/i, '').trim();
    return { col, decode };
  });
  for (const s of specs) {
    assertValidIdentifier(s.col);
    if (!cols.has(s.col)) return res.status(400).json({ error: 'Colonna inesistente: ' + s.col });
  }

  // Filtri di visibilità.
  const conds = [];
  const params = [];
  if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
  if (cols.has('owner_user_id')) { params.push(req.user.user_id); conds.push(`owner_user_id = $${params.length}`); }
  else if (cols.has('user_id')) { params.push(req.user.user_id); conds.push(`user_id = $${params.length}`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const selCols = ['id', ...specs.map(s => s.col)].map(c => `"${c}"`).join(', ');
  const rows = (await db.query(`SELECT ${selCols} FROM "${tabella}" ${where} ORDER BY id LIMIT 500`, params)).rows;

  // Classifica le colonne da decodificare e raccoglie gli id per la risoluzione in blocco.
  const isUserCol = (c) => /_user_id$/i.test(c) || c === 'created_by' || c === 'user_id' || c === 'owner_user_id';
  const isClientCol = (c) => c === 'client_id';
  const clientIds = new Set(), userIds = new Set();
  for (const r of rows) for (const s of specs) {
    if (!s.decode) continue;
    const v = r[s.col];
    if (v == null) continue;
    if (isClientCol(s.col)) clientIds.add(v);
    else if (isUserCol(s.col)) userIds.add(v);
  }
  const clientMap = new Map(), userMap = new Map();
  if (clientIds.size) {
    const cr = await db.query(
      `SELECT id, valore2 FROM clients WHERE id = ANY($1) AND argument='Cliente' AND campo='Cliente'`,
      [[...clientIds]]
    );
    for (const x of cr.rows) clientMap.set(String(x.id), x.valore2);
  }
  if (userIds.size) {
    const ur = await db.query('SELECT id, name, cognome FROM users WHERE id = ANY($1)', [[...userIds]]);
    for (const x of ur.rows) userMap.set(String(x.id), [x.cognome, x.name].filter(Boolean).join(' '));
  }

  const items = rows.map(r => {
    const parts = specs.map(s => {
      const v = r[s.col];
      if (v == null) return '';
      if (!s.decode) return String(v);
      if (isClientCol(s.col)) return clientMap.get(String(v)) || String(v);
      if (isUserCol(s.col)) return userMap.get(String(v)) || String(v);
      return String(v);
    }).filter(p => p !== '');
    return { id: r.id, value: parts.join(' — ') };
  });
  // Modalità 1 (elimina/revoca): abilita il pulsante solo se function_db ha la riga
  // cod_istruzione=valore3, istruzione='delete', funzione=campo.
  let deleteEnabled = false;
  if (mode === 1 && campo) {
    const fd = await db.query(
      `SELECT 1 FROM function_db WHERE cod_istruzione = $1 AND lower(istruzione) = 'delete' AND funzione = $2 LIMIT 1`,
      [mode, campo]
    );
    deleteEnabled = fd.rows.length > 0;
  }
  let updateEnabled = false;
  if (mode === 3 && campo) {
    const fu = await db.query(
      `SELECT 1 FROM function_db WHERE cod_istruzione = $1 AND lower(istruzione) = 'update' AND funzione = $2 LIMIT 1`,
      [mode, campo]
    );
    updateEnabled = fu.rows.length > 0;
  }
  res.json({ tabella, colonna, mode: (mode == null ? null : mode), deleteEnabled, updateEnabled, items });
}

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
      `SELECT campo, tabella, colonna, "VariabDB" AS variabdb, valore3 FROM "${source}"
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [fieldId, req.user.tenant_id, req.user.user_id]
    );
    if (f.rows.length === 0) return res.status(404).json({ error: 'Campo non trovato' });
    const campo = f.rows[0].campo;
    const tabella = f.rows[0].tabella;
    const colonna = f.rows[0].colonna;
    const variab = (f.rows[0].variabdb || '').trim();
    const mode = (f.rows[0].valore3 == null) ? null : Number(f.rows[0].valore3); // valore3 = modalità
    if (!tabella || !colonna) return res.status(400).json({ error: 'tabella/colonna non impostate sul campo' });
    // Elenco "decodificato" (colonna con token decode:...): risoluzione id -> nome leggibile.
    if (/(^|,)\s*decode:/i.test(colonna)) {
      return await respondDecodedOptions(req, res, tabella, colonna, campo, mode);
    }
    assertValidIdentifier(tabella);
    assertValidIdentifier(colonna);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const conds = [];
    const params = [];
    if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (cols.has('user_id')) {
      params.push(req.user.user_id);
      const up = params.length;
      if (tabella === 'clients') {
        // Includi anche i clienti condivisi con me (ACL), non solo i miei.
        params.push(req.user.tenant_id);
        conds.push(`(user_id = $${up} OR EXISTS (SELECT 1 FROM client_shares s WHERE s.client_id = clients.id AND s.shared_with_user_id = $${up} AND s.tenant_id = $${params.length}))`);
      } else {
        conds.push(`user_id = $${up}`);
      }
    }
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
    // Modalità 1 (elimina): il pulsante Cancella compare solo se in function_db esiste la riga
    // cod_istruzione=valore3, istruzione='delete', funzione=campo.
    let deleteEnabled = false;
    if (mode === 1 && campo) {
      const fd = await db.query(
        `SELECT 1 FROM function_db WHERE cod_istruzione = $1 AND lower(istruzione) = 'delete' AND funzione = $2 LIMIT 1`,
        [mode, campo]
      );
      deleteEnabled = fd.rows.length > 0;
    }
    // Modalità 3 (update/disattiva): pulsante attivo solo se function_db ha la riga
    // cod_istruzione=valore3, istruzione='update', funzione=campo.
    let updateEnabled = false;
    if (mode === 3 && campo) {
      const fu = await db.query(
        `SELECT 1 FROM function_db WHERE cod_istruzione = $1 AND lower(istruzione) = 'update' AND funzione = $2 LIMIT 1`,
        [mode, campo]
      );
      updateEnabled = fu.rows.length > 0;
    }
    res.json({ tabella, colonna, mode, deleteEnabled, updateEnabled, items: stripSensitive(result.rows) });
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
    if (cod === 3) conds.push("istruzione = 'update'"); // guardia di sicurezza
    const fdb = await db.query(`SELECT * FROM function_db WHERE ${conds.join(' AND ')}`, params);
    if (fdb.rows.length === 0) return res.json({ deleted: 0, updated: 0, executed: 0 });

    // 3) Esecuzione in transazione (tutte o nessuna)
    const isAdmin = isAdminUser(req);
    const client = await db.connect();
    let deleted = 0, updated = 0, executed = 0;
    try {
      await client.query('BEGIN');
      for (const r of fdb.rows) {
        const istr = (r.istruzione || '').toLowerCase();
        if (istr !== 'delete' && istr !== 'update') continue; // supportate delete e update
        const tab = r.fun_tabella, col = r.fun_colonna;
        if (!tab || !col) continue;
        assertValidIdentifier(tab);
        assertValidIdentifier(col);
        // fun_tabella proviene da function_db (configurazione privilegiata, non input utente):
        // basta che la tabella/colonna esistano fisicamente (ammesse anche tabelle di sistema
        // non presenti in table_structures, es. client_shares).
        const tcols = await getTableColumns(tab);
        if (tcols.size === 0) throw Object.assign(new Error('Tabella inesistente: ' + tab), { statusCode: 400 });
        if (!tcols.has(col)) throw Object.assign(new Error('Colonna inesistente: ' + col), { statusCode: 400 });

        // Filtri di sicurezza tenant/user (colonne indicate in fun_tenant/fun_user; per i
        // non-admin, in mancanza, forza tenant_id/user_id).
        let tenCol = (r.fun_tenant || '').trim();
        if (!tenCol && tcols.has('tenant_id') && !isAdmin) tenCol = 'tenant_id';
        let usrCol = (r.fun_user || '').trim();
        if (!usrCol && tcols.has('user_id') && !isAdmin) usrCol = 'user_id';

        if (istr === 'delete') {
          // DELETE: la riga da eliminare è identificata da fun_colonna = record selezionato.
          const parts = [`"${col}" = $1`];
          const p = [selectedId];
          if (tenCol) { assertValidIdentifier(tenCol); p.push(req.user.tenant_id); parts.push(`"${tenCol}" = $${p.length}`); }
          if (usrCol) { assertValidIdentifier(usrCol); p.push(req.user.user_id); parts.push(`"${usrCol}" = $${p.length}`); }
          const rr = await client.query(`DELETE FROM "${tab}" WHERE ${parts.join(' AND ')}`, p);
          deleted += rr.rowCount;
          executed++;
        } else {
          // UPDATE: imposta fun_colonna = ieri (data sistema -1) sul record SELEZIONATO
          // (match sull'id della riga) + filtri tenant/user.
          if (!tcols.has('id')) throw Object.assign(new Error("La tabella non ha colonna 'id': " + tab), { statusCode: 400 });
          const parts = ['id = $1'];
          const p = [selectedId];
          if (tenCol) { assertValidIdentifier(tenCol); p.push(req.user.tenant_id); parts.push(`"${tenCol}" = $${p.length}`); }
          if (usrCol) { assertValidIdentifier(usrCol); p.push(req.user.user_id); parts.push(`"${usrCol}" = $${p.length}`); }
          const rr = await client.query(
            `UPDATE "${tab}" SET "${col}" = CURRENT_DATE - INTERVAL '1 day' WHERE ${parts.join(' AND ')}`,
            p
          );
          updated += rr.rowCount;
          executed++;
        }
      }
      await client.query('COMMIT');
      res.json({ deleted, updated, executed });
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

// Risolve l'espressione del tipo_valore=12 configurata in VariabDB.
// Sintassi supportata:
//   clients.valore2 with campo='Repository Cliente' and tenant_id=[tenant_id] and user_id=[user_id] and argument=[client_id]
//   + settings.valore2 with campo='cartella Progetti' and tenant_id=[tenant_id] and user_id=[user_id]
//   + '/' + projects.valore2 with campo='Progetto' and argument='Progetto' and tenant_id=[tenant_id] and user_id=[user_id] and client_id=[client_id]
// Ogni blocco tabella.colonna viene letto dalla tabella indicata; i blocchi letterali tra apici
// vengono semplicemente concatenati. I placeholder tra [] sono valori del contesto corrente.
function splitType12Expression(expr) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (const ch of String(expr || '')) {
    if ((ch === "'" || ch === '"') && (quote === null || quote === ch)) {
      quote = quote === null ? ch : null;
      cur += ch;
    } else if (ch === '+' && quote === null) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function type12Unquote(value) {
  const v = String(value ?? '').trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1).replace(/''/g, "'").replace(/""/g, '"');
  }
  return v;
}

async function resolveType12Expression(expression, req, context = {}) {
  const pieces = splitType12Expression(expression);
  const out = [];
  const ctx = {
    tenant_id: req.user.tenant_id,
    user_id: req.user.user_id,
    client_id: context.clientId || null,
    project_id: context.projectId || null,
    argument: context.argument || null
  };

  for (const piece of pieces) {
    if (!piece) continue;
    // Stringa letterale: '/' oppure qualsiasi testo racchiuso tra apici.
    if ((piece.startsWith("'") && piece.endsWith("'")) || (piece.startsWith('"') && piece.endsWith('"'))) {
      out.push(type12Unquote(piece));
      continue;
    }

    const m = piece.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s+with\s+(.+)$/i);
    if (!m) throw new Error(`Sintassi VariabDB tipo 12 non valida: ${piece}`);
    const table = m[1].toLowerCase();
    const column = m[2];
    const whereText = m[3].trim();
    if (!['settings', 'clients', 'projects'].includes(table)) {
      throw new Error(`Tabella non consentita nel tipo 12: ${table}`);
    }
    assertValidIdentifier(column);

    const conditions = whereText.split(/\s+and\s+/i).map(x => x.trim()).filter(Boolean);
    const where = [];
    const params = [];
    for (const condition of conditions) {
      const cm = condition.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      if (!cm) throw new Error(`Condizione VariabDB tipo 12 non valida: ${condition}`);
      const field = cm[1];
      assertValidIdentifier(field);
      let raw = cm[2].trim();
      let value;
      const ph = raw.match(/^\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
      if (ph) {
        const key = ph[1].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(ctx, key)) {
          throw new Error(`Placeholder non supportato nel tipo 12: [${ph[1]}]`);
        }
        value = ctx[key];
      } else {
        value = type12Unquote(raw);
      }
      params.push(value);
      where.push(`"${field}" = $${params.length}`);
    }

    const cols = await getTableColumns(table);
    if (!cols.has(column)) throw new Error(`Colonna non trovata: ${table}.${column}`);
    // Aggiunge solo le condizioni esplicitamente configurate in VariabDB. La sicurezza
    // dei dati resta garantita dal filtro tenant/user richiesto nella configurazione.
    const result = await db.query(
      `SELECT "${column}" AS v FROM "${table}" WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    let v = result.rows.length && result.rows[0].v != null ? result.rows[0].v : '';
    // valore3 e' una colonna numerica con decimali (es. 2026.00): nel tipo 12 va mostrata
    // come intero, senza parte decimale (es. 2026).
    if (column === 'valore3' && v !== '') {
      const n = Number(v);
      v = Number.isFinite(n) ? String(Math.trunc(n)) : String(v);
    } else {
      v = String(v);
    }
    out.push(v);
  }
  return out.join('');
}

// Dettaglio delle righe (settings o clients) per un dato "argument", filtrate per
// tenant e utente del token. Il :source è vincolato a settings|clients dalla route.
app.get('/api/:source(settings|clients|projects)/details', requireAuth, async (req, res) => {
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
    // Per i clienti l'accesso può derivare da una condivisione (ACL): le righe appartengono al
    // proprietario, quindi il filtro user_id usa l'id del proprietario del cliente accessibile.
    // La visibilità dei campi resta filtrata sul RUOLO del destinatario (come richiesto).
    let effectiveUserId = req.user.user_id;
    // Contesto aggiuntivo usato dalla risoluzione dei campi tipo 4 (vedi sotto):
    // clientContextId = client_id del cliente/progetto corrente; projectContextId = id del
    // progetto corrente (per i progetti, l'id del progetto è il suo stesso "argument").
    let clientContextId = null;
    let projectContextId = null;
    if (table === 'clients') {
      const acc = await clientAccessByArgument(argument, req, false);
      if (!acc) return res.status(403).json({ error: 'Non autorizzato' });
      effectiveUserId = acc.ownerUserId;
      clientContextId = acc.clientId;
    }
    // Progetti: filtro aggiuntivo per client_id (accesso a parità di tenant+user+client).
    const params = [argument, req.user.tenant_id, effectiveUserId, roleLevel];
    let projClause = '';
    if (table === 'projects') {
      const projClientId = ((req.query && req.query.clientId) || '').trim();
      if (projClientId) { params.push(projClientId); projClause = ` AND client_id = $${params.length}`; clientContextId = projClientId; }
      projectContextId = argument;
    }
    const result = await db.query(
      `SELECT * FROM "${table}"
       WHERE argument = $1 AND tenant_id = $2 AND user_id = $3
         AND (id_roles IS NULL OR id_roles >= $4)
         AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)  -- nascondi i campi scaduti
         ${projClause}
       ORDER BY ordinamento NULLS LAST, campo`,
      params
    );

    // Per i campi di tipo 4 risolve il valore leggendolo dalla tabella/colonna di
    // riferimento, sulla riga del login (WHERE su user_id/tenant_id o PK id).
    // Se il campo vive dentro "clients" il filtro include anche client_id; se vive
    // dentro "projects" include anche client_id e project_id (solo sulle colonne
    // effettivamente presenti nella tabella di riferimento).
    // In più, se sulla riga è impostata la colonna "VariabDB" (condizione SQL configurata
    // da un utente privilegiato, non input dell'utente finale), viene aggiunta in AND dopo
    // i filtri di contesto — utile quando la tabella di riferimento ha altre dimensioni
    // (es. anno, cod_billing, ecc.) oltre a tenant/user/client/project.
    const rows = result.rows;
    for (const row of rows) {
      if (Number(row.tipo_valore) === 4 && row.tabella && row.colonna) {
        try {
          assertValidIdentifier(row.tabella);
          assertValidIdentifier(row.colonna);
          const keys = await referenceKeys(row.tabella, req.user, { clientId: clientContextId, projectId: projectContextId });
          let where = keys.length
            ? 'WHERE ' + keys.map((k, i) => `"${k.col}" = $${i + 1}`).join(' AND ')
            : '';
          // VariabDB contiene sempre l'operatore iniziale (AND/OR); se non ci sono filtri
          // di contesto precedenti, l'operatore iniziale viene rimosso per evitare "WHERE AND ...".
          const variab = (row.VariabDB || '').trim();
          if (variab) {
            where = where
              ? `${where} ${variab}`
              : 'WHERE ' + variab.replace(/^\s*(and|or)\s+/i, '');
          }
          const ref = await db.query(
            `SELECT "${row.colonna}" AS v FROM "${row.tabella}" ${where} LIMIT 1`,
            keys.map(k => k.val)
          );
          row.resolved_value = ref.rows[0] ? ref.rows[0].v : null;
        } catch (e) {
          row.resolved_value = null;
        }
      }
      // Tipo 12: VariabDB contiene una piccola espressione di concatenazione. Il backend
      // la risolve nel contesto della riga corrente e restituisce il risultato al dashboard.
      if (Number(row.tipo_valore) === 12 && row.VariabDB) {
        try {
          row.resolved_value = await resolveType12Expression(row.VariabDB, req, {
            clientId: clientContextId,
            projectId: projectContextId,
            argument: row.argument || argument
          });
        } catch (e) {
          row.resolved_value = '';
          console.error('[TIPO 12] Errore risoluzione VariabDB:', e.message);
        }
      }

      // Tipi 9 (multi-selezione) e 10 (elenco): le opzioni arrivano da lookup_values, non da "colonna".
      // Match per (tenant, user, tipo_valore, nome_campo=campo), filtrate per ruolo e date attive.
      const t = Number(row.tipo_valore);
      if (t === 9 || t === 10) {
        try {
          const rawCampo = String(row.campo || '');
          const stripped = rawCampo.replace(/^\(\*\)\s*/, '');
          const lookup = await resolveLookupValues(
            req.user.tenant_id, effectiveUserId, String(row.tipo_valore), rawCampo, stripped, roleLevel
          );
          row.lookup_options = lookup.rows.map(x => x.valore);
          row.lookup_is_custom = lookup.isCustom; // true se la sorgente ha tenant_id/user_id valorizzati
        } catch (e) { row.lookup_options = []; }
      }
    }

    res.json(stripSensitive(rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Salvataggio di un campo di tipo 4 (riferimento a un'altra tabella) per settings, clients o projects.
// Prima di scrivere il valore nella tabella di riferimento, verifica che non esista già
// nella colonna <colonna> della tabella <tabella> indicate nella riga (per lo stesso contesto:
// tenant/user, +client_id se "clients", +client_id/project_id se "projects", + eventuale VariabDB).
app.put('/api/:source(settings|clients|projects)/:id/reference-value', requireAuth, async (req, res) => {
  try {
    const table = req.params.source;
    const { id } = req.params;
    const { value } = req.body;

    // Carica la riga (settings/clients/projects) dell'utente per leggere tabella/colonna/
    // argument/VariabDB (e client_id, presente solo sulle righe di "projects").
    const s = await db.query(
      `SELECT * FROM "${table}" WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, req.user.tenant_id, req.user.user_id]
    );
    if (s.rows.length === 0) {
      return res.status(404).json({ error: 'Impostazione non trovata' });
    }

    const row = s.rows[0];
    const { tabella, colonna } = row;
    if (!tabella || !colonna) {
      return res.status(400).json({ error: 'Tabella o colonna non definite per questa impostazione' });
    }

    // Valida gli identificatori prima di interpolarli (anti SQL injection)
    assertValidIdentifier(tabella);
    assertValidIdentifier(colonna);

    // Contesto aggiuntivo: per "clients" risale alla riga identità (Cliente) partendo
    // dall'argument del campo; per "projects" il client_id è già in colonna sulla riga
    // stessa e il project_id corrisponde all'argument (il progetto è il contenitore diretto).
    let clientContextId = null;
    let projectContextId = null;
    if (table === 'clients') {
      const root = await resolveClientRoot(row.argument, req.user.tenant_id);
      if (root) clientContextId = root.clientId;
    } else if (table === 'projects') {
      clientContextId = row.client_id || null;
      projectContextId = row.argument || null;
    }

    // Individua la riga del login (+ client/project di contesto) nella tabella di riferimento
    const keys = await referenceKeys(tabella, req.user, { clientId: clientContextId, projectId: projectContextId });
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Impossibile identificare la riga di riferimento (mancano user_id/tenant_id)' });
    }
    let identityWhere = keys.map((k, i) => `"${k.col}" = $${i + 2}`).join(' AND ');
    const keyValues = keys.map(k => k.val);

    // VariabDB: condizione SQL aggiuntiva configurata sul campo (facoltativa, non input
    // dell'utente finale), aggiunta in AND ai filtri di contesto sopra — utile quando la
    // tabella di riferimento ha altre dimensioni (es. anno, cod_billing, ecc.).
    const variab = (row.VariabDB || '').trim();
    if (variab) {
      identityWhere = identityWhere
        ? `${identityWhere} ${variab}`
        : variab.replace(/^\s*(and|or)\s+/i, '');
    }

    // Controllo di unicità: il valore non deve già esistere in un'ALTRA riga di
    // tabella.colonna (la riga corrente del login/contesto è esclusa dal controllo).
    if (value !== null && value !== undefined && value !== '') {
      const dup = await db.query(
        `SELECT 1 FROM "${tabella}" WHERE "${colonna}" = $1 AND NOT (${identityWhere}) LIMIT 1`,
        [value, ...keyValues]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'Valore già esistente nel database' });
      }
    }

    // Scrive il valore nella tabella di riferimento, sulla riga del login/contesto
    const upd = await db.query(
      `UPDATE "${tabella}" SET "${colonna}" = $1 WHERE ${identityWhere} RETURNING "${colonna}" AS v`,
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

    // Chiave transazione per (utente, DB scelto): così main e auth non si mescolano.
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const txKey = getTokenId(req) + ':' + dbKey;

    // Client su cui eseguire: quello della transazione aperta, se esiste.
    let client = activeTransactions.get(txKey);

    // Se non c'è una transazione ed è una query di modifica, aprine una
    // su un client dedicato preso dal pool selezionato.
    if (!client && /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)/i.test(sql)) {
      client = await pool.connect();
      await client.query('BEGIN');
      activeTransactions.set(txKey, client);
    }

    // Esegui sul client della transazione se presente, altrimenti sul pool.
    const runner = client || pool;
    const result = await runner.query(sql);

    res.json({
      rows: result.rows,
      columns: result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] || {}),
      affectedRows: result.rowCount,
      transactionActive: activeTransactions.has(txKey)
    });
  } catch (error) {
    console.error('SQL Error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Commit Transaction
app.post('/api/sql/commit', requireAuth, requireAdmin, ensureSqlEditorEnabled, async (req, res) => {
  const txKey = getTokenId(req) + ':' + pickDbKey(req);
  const client = activeTransactions.get(txKey);

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
    activeTransactions.delete(txKey);
    client.release();
  }
});

// Rollback Transaction
app.post('/api/sql/rollback', requireAuth, requireAdmin, ensureSqlEditorEnabled, async (req, res) => {
  const txKey = getTokenId(req) + ':' + pickDbKey(req);
  const client = activeTransactions.get(txKey);

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
    activeTransactions.delete(txKey);
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