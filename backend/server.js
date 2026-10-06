import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import tls from 'tls';
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
import aiRoutes from './routes/ai.js';
import jiraRoutes from './routes/jira.js';
import cryptoMigrationRoutes from './routes/crypto-migration.js';
import integrazioniRoutes from './routes/integrazioni.js';
import promptsRoutes from './routes/prompts.js';
import chatbotRoutes from './routes/chatbot.js';
import vmMonitorRoutes, { startVmSampler } from './routes/vm-monitor.js';
import jobSchedulesRoutes from './routes/job-schedules.js';
import auditLogRoutes from './routes/audit-log.js';
import notificheRoutes from './routes/notifiche.js';
import auditEventiRoutes from './routes/audit-eventi.js';
import { sendMail, buildRichiestaCancellazioneEmail, EMAIL_PROJEXA } from './config/mailer.js';
import { regoleColonne, metaColonna, etichetteColonne, etichetteValori, opzioniColonna, applicaRegoleScrittura, ordineGriglia, filtroSopraGriglia, TABELLE_VERIFICA, etichettaComune } from './config/gridColumnRules.js';
import { kickTranscriptionWorker } from './jobs/meetingTranscription.js';
import { askAiProvider, PROVIDERS as AI_PROVIDERS } from './routes/ai.js';
import { getIntegration } from './config/integrations.js';
import { getPromptFor } from './config/prompts.js';
import { leggiTemplate, descriviTemplate, applicaModifiche, leggiRispostaAi, leggiRevisioneAi, testoRisultante, spostamentiRichiesti } from './config/kickoffPptx.js';
import * as OffertaDocx from './config/offertaDocx.js';
import { avviaScheduler } from './jobs/scheduler.js';
import { avviaInvioAudit } from './jobs/auditShipper.js';
import { allowedOrigins } from './config/origins.js';
import { requireAuth } from './middleware/auth.js';
import { encryptRowForWrite } from './config/crypto.js';
import { resolveDbUrl } from './config/dbEnv.js';

dotenv.config();

// In locale su Windows, dietro il proxy aziendale che ispeziona l'HTTPS (certificato
// aziendale installato in Windows), Node rifiuta le connessioni verso i servizi esterni
// (es. Gemini: SELF_SIGNED_CERT_IN_CHAIN) perché usa solo i propri certificati.
// Qui si aggiungono quelli di Windows a quelli di Node: stesso effetto di --use-system-ca,
// senza cambiare il comando di avvio. Sul server Linux non si applica.
if (process.platform === 'win32' && typeof tls.setDefaultCACertificates === 'function') {
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
  } catch (e) {
    console.warn('⚠️ Certificati di sistema non caricati:', e.message);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Dietro il reverse proxy (Caddy): fidati del primo hop per ottenere l'IP reale (req.ip).
app.set('trust proxy', 1);

// CORS ristretto: consenti le richieste same-origin (Origin assente) e solo le origini
// in whitelist (localhost per lo sviluppo + quelle in ALLOWED_ORIGINS, es. l'URL di produzione).
// La lista sta in config/origins.js perché la usa anche il flusso OAuth di Jira.
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error('Origine non consentita (CORS)'));
  }
}));

// Header di sicurezza di base (difesa in profondità).
app.disable('x-powered-by'); // non dichiarare che il server è Express

// Content-Security-Policy: le pagine possono caricare codice e stili solo da Projexa, da
// cdnjs (Font Awesome e librerie) e da Google (pulsante di accesso), e inviare dati solo
// al proprio backend. 'unsafe-inline' serve perché le pagine usano script e onclick
// inline; la politica limita comunque dove può finire un dato rubato (connect-src),
// vieta plugin (object-src) e il cambio di <base>, e impedisce di incorniciare l'app.
// Dal 2026-09-29 non ci sono più modelli che girano nel browser (trascrizione Browser-leggero/
// pesante e recap Browser-Medio/Alto eliminati): tolti jsdelivr, huggingface,
// raw.githubusercontent, 'wasm-unsafe-eval' e blob: negli script, che servivano solo a loro.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://accounts.google.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Microfono consentito solo alle pagine di Projexa (self): serve alla finestra
  // "Dispositivi audio" delle riunioni. Geolocalizzazione e fotocamera restano vietate.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  // HSTS solo su HTTPS (dietro Caddy req.secure viene da X-Forwarded-Proto): il browser
  // userà sempre HTTPS per 180 giorni, anche se l'utente scrive http://.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// Limite di default di express.json() = 100kb: troppo basso per payload come
// l'import Qlik voucher (gruppi aggregati da file Excel di migliaia di righe)
// o altri batch consistenti (es. import CSV). Alzato a 15mb.
app.use(express.json({ limit: '15mb' }));

// Corpo JSON malformato (o oltre il limite): il parser lancia un errore che senza questo
// handler diventerebbe un 500 generico. Qui si risponde con un 400 chiaro.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Richiesta troppo grande.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Corpo della richiesta non valido (JSON malformato).' });
  }
  next(err);
});

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
app.use('/api/ai', aiRoutes);
app.use('/api/jira', jiraRoutes);
// Pulsante «Aggiorna Integrazioni» della dashboard -> programmi in backend/jobs/.
app.use('/api/integrazioni', integrazioniRoutes);
// Editor dei prompt AI (prompt-editor.html): solo admin del tenant PROJEXA.
app.use('/api/prompts', promptsRoutes);
// Pagina Monitor (monitor.html): solo admin del tenant PROJEXA, sola lettura per MONITOR_LETTURA_EMAILS.
app.use('/api/vm-monitor', vmMonitorRoutes);
// Schedulazioni dei job (monitor.html, scheda Schedulazioni).
app.use('/api/job-schedules', jobSchedulesRoutes);
// Log (monitor.html, scheda Log): accessi e variazioni salvati su Oracle
app.use('/api/audit-log', auditLogRoutes);
// Campanella della dashboard: notifiche dell'utente del login (projexa_notif).
app.use('/api/notifiche', notificheRoutes);
// Eventi da registrare nei log inviati dal browser (es. email del recap aperta): tutti gli utenti
app.use('/api/audit', auditEventiRoutes);
// Assistente "Projexa" della dashboard (Gemini + Manuale Utente): tutti gli utenti.
app.use('/api/chatbot', chatbotRoutes);
// Migrazione Crypto (database-viewer): riservata agli amministratori.
app.use('/api/crypto', requireAuth, requireAdmin, cryptoMigrationRoutes);

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
// Database supportati: main=Projexa, auth=Projexa-Auth, lic=Projexa-Lic, notif=Projexa-Notif.
// Usato da database-viewer e sql-editor per leggere/scrivere sul progetto selezionato.
// Solo l'admin può scegliere un database diverso dal principale: Projexa-Auth contiene
// email, password e scadenze di tutti gli utenti, e la tabella users non ha tenant_id,
// quindi senza questo controllo un utente qualsiasi poteva cambiare la password di chiunque.
const DB_POOLS = { main: db, auth: authDb, lic: licenseDb, notif: notifDb };
function pickDbKey(req) {
  const k = (req && req.get && req.get('x-target-db')) || '';
  const key = Object.prototype.hasOwnProperty.call(DB_POOLS, k) ? k : 'main';
  if (key !== 'main' && !isAdminUser(req)) {
    throw Object.assign(new Error('Database riservato all\'amministratore'), { statusCode: 403 });
  }
  return key;
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

// Cifratura a riposo: prima di ogni INSERT/UPDATE i valori previsti dalla regola
// (config/crypto.js) vengono sostituiti con il testo cifrato. La lettura è già
// gestita dal pool (config/cryptoPool.js), quindi a video il dato resta in chiaro.
// Se la tabella non ha la colonna "crypto", o la riga ha crypto = 0, o manca
// ENCRYPTION_KEY, i dati passano invariati.
async function cryptoWrite(pool, dbKey, tableName, data, id = null) {
  try {
    const result = await encryptRowForWrite(pool, tableName, data, { id, dbKey });
    return result.data;
  } catch (e) {
    console.error('⚠️  Cifratura non applicata su', tableName, '-', e.message);
    return data;
  }
}

// Un ORDER BY su una colonna cifrata ordinerebbe il testo cifrato (cioè a caso).
// Gli elenchi brevi di nomi (clienti, progetti) vengono quindi riordinati qui,
// dopo la decifratura fatta dal pool.
function sortByName(rows) {
  return rows.slice().sort((a, b) =>
    String(a.name == null ? '' : a.name).localeCompare(
      String(b.name == null ? '' : b.name), 'it', { sensitivity: 'base' })
  );
}

// INSERT costruita dalle chiavi di un oggetto, con la cifratura già applicata.
// Serve dove l'elenco delle colonne non è fisso: la cifratura può aggiungere la
// colonna "crypto", che però esiste solo sulle tabelle già predisposte.
async function insertRowEncrypted(target, dbKey, tableName, values) {
  const data = await cryptoWrite(target, dbKey, tableName, values);
  const cols = Object.keys(data).map(assertValidIdentifier);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  return target.query(
    `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`,
    cols.map((c) => data[c])
  );
}

// Admin di sistema (ruolo "Admin" = id_roles 1): bypassa l'isolamento per tenant,
// così può leggere/scrivere/scegliere qualsiasi tenant dal database-viewer.
function isAdminUser(req) {
  return Number(req.user?.id_roles) === 1;
}

// Tabelle di ruoli e configurazione: solo l'admin può scriverle, da qualunque endpoint
// (form generico, import, campi collegati, griglie, reference-value, function_db).
//   - user_tenants/roles: da qui dipende chi è admin (id_roles = 1);
//   - table_structures: quali tabelle sono modificabili dal form generico;
//   - kpi_tab/function_db: contengono SQL e istruzioni eseguite dal server;
//   - tipo_valore: quali tipi di campo può configurare ciascun ruolo.
const ROLE_PROTECTED_TABLES = new Set(['user_tenants', 'roles', 'table_structures', 'kpi_tab', 'function_db', 'tipo_valore']);
// Anagrafiche senza tenant_id (una riga per utente / per tenant): i non admin le scrivono
// solo con reference-value, che tocca esclusivamente la riga del login (campi del Profilo).
const IDENTITY_TABLES = new Set(['users', 'tenants']);
function assertCanWriteTable(req, tableName, dbKey = 'main', { ownRowOnly = false } = {}) {
  if (dbKey !== 'main' || isAdminUser(req)) return;
  const t = String(tableName || '').toLowerCase();
  if (ROLE_PROTECTED_TABLES.has(t) || (IDENTITY_TABLES.has(t) && !ownRowOnly)) {
    throw Object.assign(new Error('Operazione riservata all\'amministratore'), { statusCode: 403 });
  }
}

// ---------- Permesso di scrittura per riga (colonna id_roles_write) ----------
// Una riga è modificabile solo se il suo id_roles_write coincide con l'id_roles del
// contesto (login o impersonificazione). L'Admin (id_roles = 1) modifica sempre tutto.
// id_roles_write vuoto = sola lettura. Il valore può contenere più ruoli separati da
// virgola/punto e virgola (colonna varchar su settings/clients/projects).
// Le tabelle senza la colonna non hanno questa restrizione.
function roleWriteList(value) {
  return value == null ? [] : String(value).split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean);
}
function contextRole(req) {
  const raw = req.user?.id_roles;
  return (raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw))) ? null : String(Number(raw));
}
// Eccezione per la tabella settings: id_roles_write è una SOGLIA. Modifica chi ha id_roles
// minore o uguale al valore (es. '70' -> ruoli 1..70; '90' -> tutti i ruoli fino a 90).
const ROLE_WRITE_THRESHOLD_TABLES = new Set(['settings']);
function canWriteRow(req, idRolesWrite, tableName = null) {
  if (isAdminUser(req)) return true;
  const role = contextRole(req);
  if (role == null) return false;
  const list = roleWriteList(idRolesWrite);
  if (ROLE_WRITE_THRESHOLD_TABLES.has(String(tableName || '').toLowerCase())) {
    return list.some((v) => /^\d+$/.test(v) && Number(role) <= Number(v));
  }
  return list.includes(role);
}
const READ_ONLY_ERROR = 'Sola lettura: il tuo ruolo non può modificare questo elemento';
// Verifica che tutte le righe indicate siano modificabili; altrimenti errore 403.
async function assertRowsWritable(req, pool, tableName, ids, tableColumns = null) {
  if (isAdminUser(req)) return;
  const cols = tableColumns || await getTableColumns(tableName, pool);
  if (!cols.has('id_roles_write')) return;
  const list = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!list.length) return;
  const r = await pool.query(
    `SELECT id, id_roles_write FROM "${assertValidIdentifier(tableName)}" WHERE id::text = ANY($1::text[])`,
    [list]
  );
  if (r.rows.some((row) => !canWriteRow(req, row.id_roles_write, tableName))) {
    throw Object.assign(new Error(READ_ONLY_ERROR), { statusCode: 403 });
  }
}
// Condizione SQL da aggiungere alle UPDATE/DELETE massive: limita alle righe modificabili.
// Per l'admin (o tabelle senza colonna) non aggiunge nulla. alias = 'f.' o ''.
function roleWriteSql(req, params, alias = '', tableColumns = null, tableName = null) {
  if (isAdminUser(req) || (tableColumns && !tableColumns.has('id_roles_write'))) return '';
  const values = `regexp_split_to_array(btrim(COALESCE(${alias}id_roles_write::text, '')), '[;,[:space:]]+')`;
  if (ROLE_WRITE_THRESHOLD_TABLES.has(String(tableName || '').toLowerCase())) {
    // settings: soglia, id_roles del contesto <= valore
    params.push(Number(contextRole(req)) || 999999);
    return ` AND EXISTS (SELECT 1 FROM unnest(${values}) AS rw(v) WHERE rw.v ~ '^[0-9]+$' AND rw.v::int >= $${params.length}::int)`;
  }
  params.push(contextRole(req) || '#nessun-ruolo#'); // ruolo assente: nessuna riga corrisponde
  return ` AND $${params.length} = ANY(${values})`;
}
// Valore di id_roles_write per le righe nuove: il ruolo di chi le crea.
function roleWriteValue(req) {
  return contextRole(req);
}
// Nuova riga: id_roles_write = ruolo del creatore (l'admin può indicarne uno esplicito).
function stampRoleWrite(req, data, tableColumns) {
  if (!tableColumns.has('id_roles_write')) return;
  const explicit = data.id_roles_write != null && String(data.id_roles_write).trim() !== '';
  if (!(isAdminUser(req) && explicit)) data.id_roles_write = roleWriteValue(req);
}
// Riga esistente: solo l'admin può cambiare id_roles_write (evita di "promuoversi").
function stripRoleWrite(req, data) {
  if (!isAdminUser(req)) delete data.id_roles_write;
}

// ---------- Struttura dei campi (settings/clients/projects) per i non admin ----------
// - settings: nessuna modifica di struttura (nuovo/elimina/rinomina/sposta campo o argomento);
//   si modificano solo i valori, se id_roles_write lo consente.
// - clients/projects: solo sui campi custom "(*)", e l'ordinamento resta nella fascia >= 200.
//   I campi standard (senza "(*)") non si toccano; i loro valori seguono id_roles_write.
const CUSTOM_ORD_BASE = 200;
const STRUCTURE_COLUMNS = ['campo', 'tipo_valore', 'tabella', 'colonna', 'VariabDB', 'ordinamento',
  'layout_col', 'layout_span', 'id_roles', 'argument'];
const isCustomCampo = (campo) => String(campo || '').trim().startsWith('(*)');
function denyStructure(msg) { throw Object.assign(new Error(msg), { statusCode: 403 }); }
function assertStructureSourceAllowed(req, source) {
  if (!isAdminUser(req) && source === 'settings') {
    denyStructure('Impostazioni: aggiungere, eliminare, rinominare o spostare campi è riservato all\'amministratore');
  }
}
// Modifica di una riga esistente: blocca i cambi di struttura non consentiti. Le colonne di
// struttura inviate ma invariate vengono tolte da data (così non "cambiano" per errore).
async function assertStructureUpdateAllowed(req, pool, source, id, data) {
  if (isAdminUser(req) || !FIELD_SOURCES.has(source)) return;
  const r = await pool.query(`SELECT * FROM "${source}" WHERE id = $1 LIMIT 1`, [id]);
  const original = r.rows[0];
  if (!original) return;
  const norm = (v) => (v == null ? '' : String(v).trim());
  const changed = [];
  for (const col of STRUCTURE_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(data, col)) continue;
    if (norm(data[col]) === norm(original[col])) delete data[col];
    else changed.push(col);
  }
  if (!changed.length) return;
  assertStructureSourceAllowed(req, source);
  if (!isCustomCampo(original.campo)) denyStructure('I campi standard non si possono modificare');
  if (changed.includes('argument')) denyStructure('Spostare un campo in un altro contenitore è riservato all\'amministratore');
  if (changed.includes('id_roles')) denyStructure('Il ruolo del campo è riservato all\'amministratore');
  if (changed.includes('ordinamento') && !(Number(data.ordinamento) >= CUSTOM_ORD_BASE)) {
    denyStructure(`Un campo custom resta nella zona dall'ordinamento ${CUSTOM_ORD_BASE} in poi`);
  }
}

// Livello del ruolo del login (numeri più bassi = più privilegi). Ruolo assente o non
// valido = livello minimo.
function userRoleLevel(req) {
  const raw = req.user?.id_roles;
  return (raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw))) ? 9999 : Number(raw);
}

// Livello richiesto da un tipo di campo (tipo_valore.id_roles): null = tutti i ruoli,
// undefined = tipo inesistente.
async function tipoValoreRoleLevel(code) {
  const r = await db.query('SELECT id_roles FROM tipo_valore WHERE id_code::text = $1 LIMIT 1', [String(code).trim()]);
  if (!r.rows[0]) return undefined;
  return r.rows[0].id_roles == null ? null : Number(r.rows[0].id_roles);
}

// Colonne di configurazione dei campi settings/clients/projects: decidono cosa esegue il
// server (tabella/colonna collegate, VariabDB = frammento SQL). Il menu del browser mostra
// a ciascun ruolo solo i tipi consentiti da tipo_valore.id_roles; qui la stessa regola
// vale anche per le chiamate dirette. Si controllano solo i valori CAMBIATI rispetto alla
// riga esistente (original, null per una riga nuova): chi modifica il valore di un campo
// configurato dall'admin rimanda indietro anche la sua configurazione, invariata.
//   - tipo_valore: consentito se il ruolo arriva al livello del tipo;
//   - VariabDB: è SQL, consentito solo a chi può configurare il tipo 15 (Accesso DB);
//   - tabella/colonna: mai verso tabelle di ruoli/configurazione o anagrafiche.
const FIELD_SOURCES = new Set(['settings', 'clients', 'projects']);
const FIELD_CONFIG_KEYS = ['tipo_valore', 'tabella', 'colonna', 'VariabDB'];
async function assertFieldConfigAllowed(req, source, data, original) {
  if (isAdminUser(req) || !FIELD_SOURCES.has(source) || !data) return;
  const norm = (v) => (v == null ? '' : String(v).trim());
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
  const changed = FIELD_CONFIG_KEYS.filter((k) => has(k) && norm(data[k]) !== norm(original ? original[k] : null));
  if (!changed.length) return;
  const deny = (msg) => { throw Object.assign(new Error(msg), { statusCode: 403 }); };
  const level = userRoleLevel(req);

  const tipo = norm(has('tipo_valore') ? data.tipo_valore : original && original.tipo_valore);
  if (tipo) {
    const need = await tipoValoreRoleLevel(tipo);
    if (need === undefined) throw Object.assign(new Error('Tipo di campo non valido'), { statusCode: 400 });
    if (need !== null && need < level) deny('Tipo di campo non consentito al tuo ruolo');
  }
  if (changed.includes('VariabDB') && norm(data.VariabDB)) {
    const needSql = await tipoValoreRoleLevel('15');
    if (needSql === undefined || (needSql !== null && needSql < level)) {
      deny('La condizione SQL (VariabDB) è riservata a chi può configurare l\'accesso al database');
    }
  }
  const tab = norm(has('tabella') ? data.tabella : original && original.tabella).toLowerCase();
  if ((changed.includes('tabella') || changed.includes('colonna')) && tab
      && (ROLE_PROTECTED_TABLES.has(tab) || IDENTITY_TABLES.has(tab))) {
    deny('Tabella riservata all\'amministratore');
  }
}

// Salvataggio "grezzo" richiesto dall'editor tabelle della pagina Database: le righe
// vengono scritte con i soli valori del form, senza forzare tenant_id/user_id/client_id
// dal contesto di login. È una scorciatoia riservata agli admin (la pagina Database è
// visibile solo a loro): per chiunque altro il flag viene ignorato e valgono le
// normali regole di isolamento multi-tenant.
function isRawColumnsRequest(req, data) {
  const flag = data && data.__rawColumns;
  return isAdminUser(req) && (flag === true || flag === 'true' || flag === 1 || flag === '1');
}

// ---------- Contenitori EAV (settings/clients/projects) ----------
// In queste tabelle un campo "vive" dentro un contenitore indicato dalla colonna argument:
// un nome (argomento delle impostazioni, 'Cliente', 'Progetto') oppure l'id di un'altra
// riga (Nodo Padre, tipo_valore = 0). Quell'id esiste una volta per ogni coppia
// (tenant, utente) — e per i clienti anche per ogni cliente — quindi NON può essere usato
// per raggiungere lo stesso contenitore altrove: va ricostruito logicamente.
const EAV_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Risale la catena dei contenitori a partire da un id: [radice, ..., contenitore indicato].
// Ritorna null se l'id non è un contenitore o se la catena non è ricostruibile.
async function eavContainerChain(source, containerId, tenantId, pool = db) {
  if (!EAV_UUID_RE.test(String(containerId || ''))) return null;
  const chain = [];
  let cursor = containerId;
  for (let depth = 0; depth < 10 && cursor; depth++) {
    const r = await pool.query(
      `SELECT id, campo, valore2, argument FROM "${source}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [cursor, tenantId]
    );
    const row = r.rows[0];
    if (!row) return null;
    chain.unshift(row);
    cursor = EAV_UUID_RE.test(String(row.argument || '')) ? row.argument : null;
  }
  return chain.length ? chain : null;
}

// Traduce la catena in FROM + condizioni SQL che ritrovano lo stesso contenitore in ogni
// tenant/utente: gli alias sono k0..kN, l'ultimo (proprietà "alias") è il contenitore
// finale, da cui prendere id/tenant_id/user_id.
// startIndex = primo livello da vincolare: 0 parte dalla radice (contenitore specifico),
// chain.length-1 vincola solo l'ultimo nodo (stesso nodo in QUALSIASI contenitore).
// matchRootValue = riconosce la radice anche dal nome (valore2): serve ai clienti/progetti,
// dove tutte le righe identità condividono campo e argument.
function eavChainSql(source, chain, startIndex, params, matchRootValue) {
  const froms = [], conds = [];
  chain.slice(startIndex).forEach((row, i) => {
    const alias = 'k' + i;
    froms.push(`"${source}" ${alias}`);
    params.push(row.campo);
    conds.push(`${alias}.campo = $${params.length}`);
    if (i === 0 && startIndex === 0) {
      params.push(row.argument);
      conds.push(`${alias}.argument IS NOT DISTINCT FROM $${params.length}`);
      if (matchRootValue && row.valore2 != null) {
        params.push(row.valore2);
        conds.push(`${alias}.valore2 = $${params.length}`);
      }
    } else if (i > 0) {
      conds.push(`${alias}.argument = k${i - 1}.id::text`);
    }
  });
  return { froms, conds, alias: 'k' + (chain.length - startIndex - 1) };
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
  'data_inizio', 'scadenza', 'id_roles', 'id_roles_write',
  'appo_task_2', 'appo_task_3', 'appo_task_4'
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
    // assigned_to = rubrica.id: il contatto deve appartenere a tenant e utente del contesto.
    const contact = await db.query(
      `SELECT 1
       FROM rubrica
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
       LIMIT 1`,
      [data.assigned_to, req.user.tenant_id, req.user.user_id]
    );
    if (contact.rows.length === 0) {
      const error = new Error('Assegnatario non presente in rubrica');
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

      // assigned_to contiene rubrica.id; in griglia viene mostrato rubrica.nominativo.
      if (column === 'assigned_to' && metadata.udt_name === 'uuid') {
        selectExpressions.push('src."assigned_to" AS "__raw_assigned_to"');
        selectExpressions.push(
          `CASE WHEN src.assigned_to IS NULL THEN NULL ELSE COALESCE((
             SELECT NULLIF(TRIM(r.nominativo::text), '')
             FROM rubrica r
             WHERE r.id = src.assigned_to
               AND r.tenant_id = src.tenant_id
               AND r.user_id = src.user_id
             LIMIT 1
           ), 'Nominativo non disponibile') END AS "assigned_to"`
        );
        resolvedForeign = true;
      }

      if (!resolvedForeign && metadata.udt_name === 'uuid' && fk) {
        assertValidIdentifier(fk.foreign_table);
        assertValidIdentifier(fk.foreign_column);
        tableColumnsCache.delete('main:' + fk.foreign_table);
        const foreignColumns = await getTableColumns(fk.foreign_table);
        const foreignNames = [...foreignColumns];
        const preferredNames = ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'titile', 'label', 'valore2', 'commessa'];
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
        references: fk ? fk.foreign_table : (column === 'assigned_to' ? 'rubrica' : null),
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
      // Assegnatari = contatti della rubrica di tenant e utente del contesto (non scaduti),
      // indipendenti da cliente e progetto. Il valore già salvato resta sempre selezionabile.
      const selectedValue = String(req.query.selectedValue || '').trim();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (selectedValue && !uuidPattern.test(selectedValue)) {
        return res.status(400).json({ error: 'Assegnatario non valido' });
      }
      await sincronizzaRubricaTenant(req.user.tenant_id); // rubrica condivisa nel tenant
      const result = await db.query(
        `SELECT r.id::text AS value,
                COALESCE(NULLIF(TRIM(r.nominativo::text), ''), 'Nominativo non disponibile') AS label,
                r.email::text AS email
         FROM rubrica r
         WHERE r.tenant_id = $1
           AND r.user_id = $2
           AND ((r.scadenza IS NULL OR r.scadenza >= CURRENT_DATE) OR r.id::text = $3)
         LIMIT 5000`,
        [req.user.tenant_id, req.user.user_id, selectedValue]
      );
      // Ordinamento dopo la lettura: con la cifratura attiva il database vedrebbe
      // solo il testo cifrato. L'email distingue eventuali omonimi.
      const counts = new Map();
      result.rows.forEach(row => counts.set(row.label, (counts.get(row.label) || 0) + 1));
      const options = result.rows
        .map(row => ({
          value: row.value,
          label: counts.get(row.label) > 1 && row.email ? `${row.label} (${row.email})` : row.label,
          name: row.label,
          email: row.email || ''
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'it', { sensitivity: 'base' }));
      // Pulsante "me": il contatto di rubrica con l'email dell'utente collegato. Confronto
      // fatto qui (non in SQL) perché l'email in rubrica può essere cifrata.
      const myEmail = String(req.user.email || '').trim().toLowerCase();
      const meRow = myEmail ? result.rows.find(row => String(row.email || '').trim().toLowerCase() === myEmail) : null;
      return res.json({ options, me: meRow ? meRow.value : null });
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
    const preferredNames = ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'titile', 'label', 'valore2', 'commessa'];
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

// ==========================================
// RUBRICA CONDIVISA NEL TENANT (chiave: email)
// ==========================================
// Ogni utente ha la sua rubrica (tenant_id + user_id), ma i contatti si condividono: quando
// una email è nella rubrica di un utente del tenant (riga attiva), viene aggiunta a tutti gli
// altri utenti del tenant che non hanno nessuna riga con quella email. Se l'email c'è già
// (anche in una riga chiusa) non si fa nulla: un contatto chiuso da un utente non torna.
// Il confronto si fa qui e non in SQL perché nominativo ed email possono essere cifrati
// (cifratura casuale). La copia prende la riga attiva più completa (ruolo, foto) con tutte
// le sue colonne tranne id e user_id; id_roles_write = ruolo del nuovo proprietario nel
// tenant (user_tenants.id_roles), così ognuno può modificare la sua copia.
// Si esegue dopo ogni nuovo contatto e quando si apre la rubrica (griglia, Kick-off, task),
// così si allineano anche i contatti entrati da altre strade (import, editor del database).
const RUBRICA_ESCLUSE_COPIA = new Set(['id', 'user_id', 'crypto', 'created_at', 'updated_at']);
const rubricaInCorso = new Map(); // tenant -> Promise (una sincronizzazione alla volta)

function sincronizzaRubricaTenant(tenantId) {
  const k = String(tenantId || '');
  if (!k) return Promise.resolve({ aggiunte: 0 });
  if (rubricaInCorso.has(k)) return rubricaInCorso.get(k);
  const p = (async () => {
    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      // Anche tra più processi/istanze: una sincronizzazione per tenant alla volta.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rubrica_sync|${k}`]);
      // Utenti del tenant con il loro ruolo: la copia è modificabile dal suo proprietario.
      const ruoli = new Map();
      // L'account Admin Projexa (id_roles = 1, account di sistema) non riceve copie.
      for (const r of (await client.query('SELECT user_id, id_roles FROM user_tenants WHERE tenant_id = $1 AND id_roles <> 1', [k])).rows) {
        if (!ruoli.has(String(r.user_id))) ruoli.set(String(r.user_id), r.id_roles);
      }
      const utenti = [...ruoli.keys()];
      if (utenti.length < 2) { await client.query('COMMIT'); return { aggiunte: 0 }; }
      const righe = (await client.query('SELECT * FROM rubrica WHERE tenant_id = $1', [k])).rows;
      const norm = (e) => String(e || '').trim().toLowerCase();
      const oggi = new Date(new Date().toDateString());
      const attiva = (r) => !r.scadenza || new Date(r.scadenza) >= oggi;
      const peso = (r) => (attiva(r) ? 4 : 0) + (r.foto ? 2 : 0) + (String(r.ruolo || '').trim() ? 1 : 0);
      const perUtente = new Map(utenti.map((u) => [u, new Set()]));
      const modello = new Map(); // email -> riga da copiare
      for (const r of righe) {
        const e = norm(r.email);
        if (!e) continue;
        const u = String(r.user_id);
        if (perUtente.has(u)) perUtente.get(u).add(e);
        if (!attiva(r)) continue;
        if (!modello.has(e) || peso(r) > peso(modello.get(e))) modello.set(e, r);
      }
      const cols = await getTableColumns('rubrica', client);
      let aggiunte = 0;
      for (const [e, r] of modello) {
        for (const u of utenti) {
          if (perUtente.get(u).has(e)) continue;
          const dati = {};
          for (const c of Object.keys(r)) {
            if (!RUBRICA_ESCLUSE_COPIA.has(c) && cols.has(c) && r[c] !== undefined) dati[c] = r[c];
          }
          dati.user_id = u;
          dati.email = String(r.email).trim();
          if (cols.has('id_roles_write') && ruoli.get(u) != null) dati.id_roles_write = String(ruoli.get(u));
          await client.query('SAVEPOINT rubrica_copia');
          try {
            await insertRowEncrypted(client, 'main', 'rubrica', dati);
            await client.query('RELEASE SAVEPOINT rubrica_copia');
            perUtente.get(u).add(e);
            aggiunte += 1;
          } catch (err) {
            // Chiave doppia (inserita nel frattempo): si salta quella copia.
            await client.query('ROLLBACK TO SAVEPOINT rubrica_copia');
            if (err.code !== '23505') console.warn(`[RUBRICA] copia di ${e} non riuscita: ${err.message}`);
          }
        }
      }
      await client.query('COMMIT');
      if (aggiunte) console.log(`[RUBRICA] tenant ${k}: ${aggiunte} contatti condivisi con gli altri utenti`);
      return { aggiunte };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[RUBRICA] sincronizzazione non riuscita:', error.message);
      return { aggiunte: 0, errore: error.message };
    } finally {
      if (client) client.release();
      rubricaInCorso.delete(k);
    }
  })();
  rubricaInCorso.set(k, p);
  return p;
}

// Nuovo contatto in rubrica dal campo "Assegnato a:" del task (tenant e utente dal token).
// Un'email può comparire una sola volta per tenant e utente: il controllo è fatto qui,
// dopo la lettura, perché l'email in rubrica può essere cifrata.
app.post('/api/dashboard/rubrica', requireAuth, async (req, res) => {
  try {
    const nominativo = String((req.body && req.body.nominativo) || '').replace(/\s+/g, ' ').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!nominativo) return res.status(400).json({ error: 'Il nominativo è obbligatorio' });
    if (nominativo.length > 255) return res.status(400).json({ error: 'Nominativo troppo lungo' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      return res.status(400).json({ error: 'Indirizzo email non valido' });
    }
    const existing = await db.query(
      'SELECT id, nominativo, email FROM rubrica WHERE tenant_id = $1 AND user_id = $2',
      [req.user.tenant_id, req.user.user_id]
    );
    const duplicate = existing.rows.find(row => String(row.email || '').trim().toLowerCase() === email);
    if (duplicate) {
      return res.status(409).json({
        error: `L'email è già in rubrica (${duplicate.nominativo})`,
        option: { value: String(duplicate.id), label: duplicate.nominativo, name: duplicate.nominativo, email: String(duplicate.email || '').trim() }
      });
    }
    const rubricaRow = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, nominativo, email };
    stampRoleWrite(req, rubricaRow, await getTableColumns('rubrica')); // modificabile dal ruolo del creatore
    const result = await insertRowEncrypted(db, 'main', 'rubrica', rubricaRow);
    sincronizzaRubricaTenant(req.user.tenant_id); // condivide il nuovo contatto con il tenant
    res.status(201).json({ option: { value: String(result.rows[0].id), label: nominativo, name: nominativo, email } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: "L'email è già in rubrica" });
    console.error('[RUBRICA CREATE]', error);
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
    // Nuova task: modificabile dal ruolo di chi la crea.
    stampRoleWrite(req, data, new Set(metadata.map(column => column.column_name)));

    const encrypted = await cryptoWrite(db, 'main', 'tasks', data);
    const columns = Object.keys(encrypted);
    const values = Object.values(encrypted);
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
    stripRoleWrite(req, data);
    await assertRowsWritable(req, db, 'tasks', [taskId]);
    const encrypted = await cryptoWrite(db, 'main', 'tasks', data, taskId);
    const columns = Object.keys(encrypted);
    if (columns.length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

    const values = Object.values(encrypted);
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

// Eliminazione di una task dalla To-Do List: solo task dello stesso tenant e utente, e solo
// se il ruolo del contesto può modificarla (id_roles_write). L'eliminazione resta nel log
// di audit con i valori della riga.
app.delete('/api/dashboard/tasks/:id', requireAuth, async (req, res) => {
  try {
    const taskId = String(req.params.id || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
      return res.status(400).json({ error: 'Id task non valido' });
    }
    await assertRowsWritable(req, db, 'tasks', [taskId]);
    const result = await db.query(
      'DELETE FROM tasks WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING id',
      [taskId, req.user.tenant_id, req.user.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task non trovata' });
    res.json({ id: result.rows[0].id, deleted: true });
  } catch (error) {
    console.error('[DASHBOARD TASK DELETE]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Divide il contenuto di "VariabDB" (frammento SQL configurato da un utente
// privilegiato in fase di definizione del campo, non input dell'utente finale) nella
// parte di condizione e nell'eventuale ORDER BY finale. Sono ammesse tutte e tre le
// forme: solo condizioni ("AND stato = 'X'"), condizioni + ordinamento, solo
// ordinamento ("ORDER BY data_inizio"). L'ORDER BY viene cercato solo al livello
// esterno, così un eventuale ORDER BY dentro una sottoquery non spezza il frammento.
function splitVariabDbClause(raw) {
  const text = String(raw || '').trim().replace(/;+\s*$/, '');
  if (!text) return { condition: '', orderBy: '' };
  let depth = 0, quote = null, cut = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && (i === 0 || /\s/.test(text[i - 1])) && /^order\s+by\b/i.test(text.slice(i))) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { condition: text, orderBy: '' };
  return { condition: text.slice(0, cut).trim(), orderBy: text.slice(cut).trim() };
}

// Elenco colonne della griglia (tipo_valore = 11 e 13), configurato nel campo "colonna".
// Sono supportati array JSON e nomi separati da virgola o punto e virgola.
// Un nome racchiuso tra parentesi indica una colonna in SOLA LETTURA: resta visibile in
// griglia esattamente come le altre, ma il suo contenuto non è modificabile (tipicamente
// perché governato da un'origine esterna, es. una sincronizzazione).
// Esempio: colonna = '(colonna_projexa),colonna_jira' -> entrambe visibili, solo
// colonna_jira modificabile.
// La presenza di almeno una colonna tra parentesi rende la griglia "a sola modifica":
// resta il pulsante Modifica, mentre Nuova riga ed Elimina non vengono proposti (le righe
// nascono e muoiono nell'origine dei dati, non qui). Senza parentesi nulla cambia.
function parseGridColumnsSpec(rawColonna) {
  const raw = String(rawColonna || '').trim();
  let tokens = [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) tokens = parsed.map(String);
    } catch (e) { /* usa il formato separato */ }
  }
  if (tokens.length === 0) tokens = raw.split(/[;,]/);
  const columns = [];
  const locked = new Set();
  for (const token of tokens) {
    const text = String(token).trim();
    if (!text) continue;
    const wrapped = /^\((.*)\)$/.exec(text);
    const name = (wrapped ? wrapped[1] : text).trim();
    if (!name) continue;
    if (!columns.includes(name)) columns.push(name);
    if (wrapped) locked.add(name);
  }
  return { columns, locked, editOnly: locked.size > 0 };
}

// Widget griglia (tipo_valore = 11 e 13: il 13 è identico in visualizzazione,
// cambia solo la modalità di modifica, che avviene nella pagina gantt.html).
// La configurazione della tabella e delle colonne viene letta dalla riga EAV del
// contesto corrente; tenant e utente non vengono accettati dal browser ma
// ricavati dall'autenticazione.
app.get('/api/:source(settings|clients|projects)/grid-widget', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = String(req.query.fieldId || '').trim();
    if (!fieldId) return res.status(400).json({ error: 'Parametro fieldId richiesto' });

    const clientColumn = source === 'projects' ? 'client_id' : 'NULL::uuid AS client_id';
    const configResult = await db.query(
      `SELECT id, argument, tabella, colonna, tipo_valore, "VariabDB" AS variabdb, tenant_id, user_id, id_roles_write, ${clientColumn}
       FROM "${source}"
       WHERE id = $1 AND tenant_id = $2 AND tipo_valore::text IN ('11', '13')
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
    // Le colonne tra parentesi restano visibili ma non modificabili (vedi parseGridColumnsSpec).
    const columnsSpec = parseGridColumnsSpec(config.colonna);
    let selectedColumns = columnsSpec.columns;
    if (selectedColumns.length === 0) {
      return res.status(400).json({ error: 'Nessuna colonna configurata' });
    }

    // La struttura delle tabelle può cambiare durante la configurazione del progetto.
    // Non usare una fotografia precedente della cache per il widget dinamico.
    tableColumnsCache.delete('main:' + tableName);
    const tableColumns = await getTableColumns(tableName);
    if (tableColumns.size === 0) return res.status(404).json({ error: 'Tabella non trovata' });
    // Rubrica condivisa nel tenant: prima di mostrarla si aggiungono i contatti nuovi degli
    // altri utenti (vedi sincronizzaRubricaTenant).
    if (tableName === 'rubrica') await sincronizzaRubricaTenant(req.user.tenant_id);
    for (const column of selectedColumns) {
      assertValidIdentifier(column);
      if (!tableColumns.has(column)) {
        return res.status(400).json({ error: `Colonna ${column} non trovata nella tabella ${tableName}` });
      }
    }
    // Isolamento minimo obbligatorio: tenant e utente. client_id e project_id sono
    // facoltativi perché dipendono dal contesto: nei Progetti ci sono sempre, nelle
    // Impostazioni la griglia non è legata a un cliente e la tabella può non averli.
    for (const required of ['tenant_id', 'user_id']) {
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
    // Il filtro per cliente si applica solo se la tabella ha la colonna e il contesto
    // corrente ha un cliente. In Clienti e Progetti il cliente c'è sempre, quindi la sua
    // assenza resta un errore; nelle Impostazioni la griglia mostra le righe dell'utente
    // senza distinzione di cliente.
    const filterByClient = tableColumns.has('client_id') && !!clientId;
    if (tableColumns.has('client_id') && !clientId && source !== 'settings') {
      return res.status(400).json({ error: 'Contesto client_id non disponibile' });
    }

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
        return res.json({
          rows: [],
          columns: [],
          lockedColumns: [],
          editOnly: columnsSpec.editOnly,
          canExpire: !isView && String(config.tipo_valore) === '11'
            && tableColumns.has('id') && tableColumns.has('scadenza')
        });
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
    // Permesso per riga: letto a parte e trasformato in __can_write (vedi sotto).
    const hasRoleWrite = tableColumns.has('id_roles_write');
    if (hasRoleWrite) selectExpressions.push('src.id_roles_write AS "__roles_write"');
    // Rubrica con le colonne della foto (Supporto/CreaDB/rubrica_foto.sql): la griglia
    // mostra la colonna Foto (carica / lente). Si legge solo se c'è, non l'immagine.
    const fotoProfilo = tableName === 'rubrica' && tableColumns.has('foto') && tableColumns.has('foto_mime') && tableColumns.has('id');
    if (fotoProfilo) selectExpressions.push('(src.foto IS NOT NULL) AS "__ha_foto"');

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
      const preferredNames = ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'label', 'valore2', 'commessa'];
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

    // Colonna del filtro sopra la griglia (es. tipologia) non tra quelle visibili: si legge
    // lo stesso, nascosta in __raw_<colonna>, così il filtro e le righe nuove funzionano.
    const filtroSopra = filtroSopraGriglia(tableName);
    if (filtroSopra && !selectedColumns.includes(filtroSopra.column) && tableColumns.has(filtroSopra.column)) {
      selectExpressions.push(`src."${assertValidIdentifier(filtroSopra.column)}" AS "__raw_${filtroSopra.column}"`);
    }
    // Scadenza della riga anche se non è tra le colonne visibili: con "Mostra tutti" il
    // browser riconosce le righe chiuse (es. card attenuate nella vista a elenco).
    if (tableColumns.has('scadenza')) selectExpressions.push('src.scadenza AS "__scadenza"');
    const selectList = selectExpressions.join(', ');
    const joinClause = joins.length ? '\n       ' + joins.join('\n       ') : '';

    // VariabDB del campo: condizioni aggiuntive e/o ORDER BY personalizzato. Le
    // condizioni si sommano SEMPRE ai filtri di visibilità (tenant/utente/cliente/
    // progetto), che restano obbligatori; l'ORDER BY, se presente, sostituisce quello
    // predefinito su id. Nel frammento le colonne possono essere scritte così come
    // sono o qualificate con "src." (alias della tabella della griglia).
    const variab = splitVariabDbClause(config.variabdb);
    let extraCondition = '';
    if (variab.condition) {
      // VariabDB deve restringere i risultati, mai poter aggirare i filtri obbligatori
      // (tenant/utente/cliente/progetto/scadenza). Rimuove un eventuale AND/OR iniziale
      // e racchiude l'intera espressione: anche "AND A OR B" diventa AND (A OR B).
      const normalizedCondition = variab.condition
        .replace(/^\s*(and|or)\b/i, '')
        .trim();
      if (normalizedCondition) extraCondition = ` AND (${normalizedCondition})`;
    }
    const orderBy = variab.orderBy
      ? ` ${variab.orderBy}`
      : (ordineGriglia(tableName) ? ` ORDER BY ${ordineGriglia(tableName)}`
        : (tableColumns.has('id') ? ' ORDER BY src.id' : ''));

    // Tabelle con colonna project_id (es. proj_anno_fatt, proj_componenti) vanno SEMPRE
    // filtrate anche per progetto, non solo tenant/utente/cliente. Nel contesto "projects"
    // l'id del progetto corrente è l'argument della riga di configurazione del widget
    // (la riga del campo tipo_valore=11 vive sotto il progetto stesso).
    const queryParams = [req.user.tenant_id, effectiveUserId];
    let clientFilter = '';
    if (filterByClient) {
      queryParams.push(clientId);
      clientFilter = ` AND src.client_id = $${queryParams.length}`;
    }
    let projectFilter = '';
    if (source === 'projects' && tableColumns.has('project_id')) {
      queryParams.push(config.argument);
      projectFilter = ` AND src.project_id = $${queryParams.length}`;
    }
    // Le griglie tipo 11 mostrano di default soltanto record non scaduti. Se la tabella
    // espone la colonna scadenza, NULL e date precedenti a oggi restano escluse.
    // Con ?tutti=1 (pulsante "Mostra tutti" nel titolo della griglia) il filtro non si
    // applica. Il tipo 13 mantiene invece il proprio comportamento Gantt invariato.
    const hasExpiry = String(config.tipo_valore) === '11' && tableColumns.has('scadenza');
    const expiryFilter = hasExpiry && req.query.tutti !== '1'
      ? ' AND src.scadenza >= CURRENT_DATE'
      : '';

    const result = await db.query(
      `SELECT ${selectList}
       FROM "${tableName}" src${joinClause}
       WHERE src.tenant_id = $1 AND src.user_id = $2${clientFilter}${projectFilter}${expiryFilter}${extraCondition}${orderBy}`,
      queryParams
    );
    // Formato oggetto uniforme per tutte le sorgenti: righe, colonne effettivamente
    // visibili (dopo l'eventuale filtro HH/GG per i progetti) e se la tabella è una view
    // (sola lettura, il frontend nasconde Nuova riga/Modifica/Elimina in quel caso).
    // lockedColumns = colonne configurate tra parentesi: visibili ma non modificabili.
    // editOnly = c'è almeno una colonna tra parentesi -> la griglia offre solo Modifica.
    // __can_write: la riga è modificabile dal ruolo del contesto (id_roles_write).
    // canWriteField: il campo griglia stesso (riga settings/clients/projects) è modificabile.
    const rows = result.rows.map((row) => {
      const out = { ...row, __can_write: hasRoleWrite ? canWriteRow(req, row.__roles_write, tableName) : true };
      delete out.__roles_write;
      // Colonne con elenco fisso (config/gridColumnRules.js): a video l'etichetta.
      return etichetteValori(tableName, out);
    });
    res.json({
      rows,
      canWriteField: canWriteRow(req, config.id_roles_write, source),
      columns: selectedColumns,
      isView,
      lockedColumns: selectedColumns.filter(c => columnsSpec.locked.has(c)),
      editOnly: columnsSpec.editOnly,
      // Etichette delle intestazioni diverse dal nome della colonna (gridColumnRules.js).
      columnLabels: etichetteColonne(tableName),
      // Elenco sopra la griglia che filtra le righe su una colonna (es. Tipologia).
      topFilter: filtroSopra && tableColumns.has(filtroSopra.column) ? filtroSopra : null,
      // Colonna Foto (rubrica): GET/PUT/DELETE /api/rubrica/:id/foto.
      fotoProfilo,
      // Tabella della griglia: per la rubrica stessa il nominativo non si cerca in rubrica.
      tabella: tableName,
      // La griglia filtra per scadenza: il titolo mostra "Mostra tutti" / "Nascondi chiusi".
      hasExpiry,
      // Il frontend mostra la selezione multipla soltanto quando l'operazione
      // richiesta è realmente applicabile alla tabella della griglia tipo 11.
      canExpire: !isView && String(config.tipo_valore) === '11'
        && tableColumns.has('id') && tableColumns.has('scadenza')
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Risolve la configurazione di una griglia (tipo_valore = 11 o 13) e verifica che
// l'utente corrente possa operare su di essa. Restituisce { config, tableName,
// tableColumns, generatedColumns, effectiveUserId, clientId } oppure lancia un
// errore con statusCode.
async function resolveGridWidgetContext(source, fieldId, req, needWrite) {
  if (!fieldId) {
    throw Object.assign(new Error('Parametro fieldId richiesto'), { statusCode: 400 });
  }
  const clientColumn = source === 'projects' ? 'client_id' : 'NULL::uuid AS client_id';
  const configResult = await db.query(
    `SELECT id, argument, tabella, colonna, tipo_valore, tenant_id, user_id, id_roles_write, ${clientColumn}
     FROM "${source}"
     WHERE id = $1 AND tenant_id = $2 AND tipo_valore::text IN ('11', '13')
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
  if (needWrite) assertCanWriteTable(req, tableName);
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

  // Colonne configurate tra parentesi: in sola lettura. Se ce n'è almeno una la griglia
  // è "a sola modifica" (niente inserimento né eliminazione). Il vincolo è applicato qui,
  // lato server, non solo nascondendo i pulsanti nel browser.
  const columnsSpec = parseGridColumnsSpec(config.colonna);

  return {
    config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId,
    lockedColumns: columnsSpec.locked,
    editOnly: columnsSpec.editOnly
  };
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
    const { tableName, lockedColumns } = await resolveGridWidgetContext(source, fieldId, req, false);

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
      // locked = colonna configurata tra parentesi in "colonna": visibile ma non
      // modificabile, quindi il form inline la mostra disabilitata come le generate.
      locked: lockedColumns.has(r.column_name),
      references: fkMap[r.column_name] || null,
      referencesColumn: fkColMap[r.column_name] || null,
      // Etichetta, valore predefinito, elenchi e colonne calcolate (config/gridColumnRules.js)
      ...metaColonna(tableName, r.column_name)
    })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Elenchi a discesa delle colonne "dynamic" (config/gridColumnRules.js), es. Tipologia da
// lookup_values o i campi verificabili di Clienti/Progetti. dep = valore della colonna da
// cui l'elenco dipende, nella stessa riga. Tenant e utente sempre dal contesto della griglia.
app.get('/api/:source(settings|clients|projects)/grid-widget/col-options', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const fieldId = String((req.query && req.query.fieldId) || '').trim();
    const column = assertValidIdentifier(String((req.query && req.query.column) || '').trim());
    const ctx = await resolveGridWidgetContext(source, fieldId, req, false);
    if (!regoleColonne(ctx.tableName)) return res.status(400).json({ error: 'Nessun elenco per questa griglia' });
    const opzioni = await opzioniColonna(db, ctx.tableName, column,
      { tenantId: req.user.tenant_id, userId: ctx.effectiveUserId }, String((req.query && req.query.dep) || ''));
    res.json(opzioni);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ==========================================
// CONFIGURATORE CHECK LIST (Impostazioni › Configura Check List, tabella config_chek_list)
// ==========================================
// Al posto della griglia tipo 11 la dashboard mostra fasi (master) e attività (slave)
// trascinabili. Il browser manda la struttura completa di una o più tipologie: padre, figlio
// e ordinamento si calcolano dalla posizione; le righe tolte si CHIUDONO (scadenza = ieri),
// come la chiusura della griglia, non si cancellano. Stessi controlli della griglia
// (config/gridColumnRules.js): elenchi, colonna_verif, vero/falso, tipo_verifica fisso.
const CKC_TABELLA = 'config_chek_list';
const CKC_COLONNE = ['id', 'tipologia', 'padre', 'figlio', 'ordinamento', 'description', 'tipo_verifica',
  'tabella_verif', 'campo_verif', 'colonna_verif', 'operatore_verif', 'risultato_verif', 'id_roles_write'];

async function ckcContesto(req, fieldId, needWrite) {
  const ctx = await resolveGridWidgetContext('settings', fieldId, req, needWrite);
  if (ctx.tableName !== CKC_TABELLA) {
    throw Object.assign(new Error('Il campo non è la configurazione della Check List'), { statusCode: 400 });
  }
  return ctx;
}

app.get('/api/settings/checklist-config', requireAuth, async (req, res) => {
  try {
    const fieldId = String((req.query && req.query.fieldId) || '').trim();
    const ctx = await ckcContesto(req, fieldId, false);
    const r = await db.query(
      `SELECT ${CKC_COLONNE.map((c) => `"${c}"`).join(', ')} FROM "${CKC_TABELLA}"
        WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        ORDER BY tipologia NULLS LAST, padre NULLS LAST, figlio NULLS LAST, id`,
      [req.user.tenant_id, ctx.effectiveUserId]
    );
    const tipologie = await opzioniColonna(db, CKC_TABELLA, 'tipologia',
      { tenantId: req.user.tenant_id, userId: ctx.effectiveUserId });
    res.json({
      rows: stripSensitive(r.rows).map((x) => ({ ...x, __can_write: canWriteRow(req, x.id_roles_write, CKC_TABELLA) })),
      tipologie: tipologie.map((t) => t.id),
      operatori: (metaColonna(CKC_TABELLA, 'operatore_verif').options || []),
      canWrite: canWriteRow(req, ctx.config.id_roles_write, 'settings')
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// body: { fieldId, tipologie: { "<tipologia>": [ { id?, titolo, ver?, attivita: [ { id?, titolo, ver? } ] } ] } }
// ver = { tabella, campo, operatore, risultato } oppure null (attività manuale).
app.put('/api/settings/checklist-config', requireAuth, async (req, res) => {
  let client;
  try {
    const fieldId = String((req.body && req.body.fieldId) || '').trim();
    const input = req.body && typeof req.body.tipologie === 'object' && !Array.isArray(req.body.tipologie) ? req.body.tipologie : null;
    if (!input || !Object.keys(input).length) return res.status(400).json({ error: 'Nessuna modifica da salvare' });
    const ctx = await ckcContesto(req, fieldId, true);
    const regoleCtx = { tenantId: req.user.tenant_id, userId: ctx.effectiveUserId };
    const valide = new Set((await opzioniColonna(db, CKC_TABELLA, 'tipologia', regoleCtx)).map((t) => t.id));

    client = await db.connect();
    await client.query('BEGIN');
    let inserite = 0, aggiornate = 0, chiuse = 0;
    for (const [tipologia, fasi] of Object.entries(input)) {
      if (!Array.isArray(fasi)) throw Object.assign(new Error('Struttura non valida'), { statusCode: 400 });
      // Righe attive attuali della tipologia (anche quelle con tipologia non più in elenco).
      const attuali = (await client.query(
        `SELECT * FROM "${CKC_TABELLA}" WHERE tenant_id = $1 AND user_id = $2 AND tipologia IS NOT DISTINCT FROM $3
           AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
        [req.user.tenant_id, ctx.effectiveUserId, tipologia === '' ? null : tipologia]
      )).rows;
      if (!valide.has(tipologia) && !attuali.length) {
        throw Object.assign(new Error(`Tipologia non valida: ${tipologia}`), { statusCode: 400 });
      }
      const perId = new Map(attuali.map((r) => [String(r.id), r]));

      // Righe da scrivere: fase = figlio 0, attività = figlio 1..n; padre = posizione della fase.
      const righe = [];
      fasi.forEach((fase, fi) => {
        righe.push({ id: fase.id, titolo: fase.titolo, ver: fase.ver, padre: fi + 1, figlio: 0 });
        (Array.isArray(fase.attivita) ? fase.attivita : []).forEach((a, ai) =>
          righe.push({ id: a.id, titolo: a.titolo, ver: a.ver, padre: fi + 1, figlio: ai + 1 }));
      });
      if (righe.length > 500) throw Object.assign(new Error('Al massimo 500 righe per tipologia'), { statusCode: 400 });

      const tenute = new Set();
      for (const r of righe) {
        const titolo = String(r.titolo || '').trim();
        if (!titolo) throw Object.assign(new Error(`Descrizione mancante (${r.padre}.${r.figlio})`), { statusCode: 400 });
        const ver = r.ver && typeof r.ver === 'object' && r.ver.campo ? r.ver : null;
        let data = {
          tipologia: tipologia === '' ? null : tipologia,
          padre: r.padre, figlio: r.figlio, description: titolo.slice(0, 255),
          tabella_verif: ver ? String(ver.tabella || '') || null : null,
          campo_verif: ver ? String(ver.campo || '') || null : null,
          operatore_verif: ver && ver.operatore != null && String(ver.operatore) !== '' ? String(ver.operatore) : null,
          risultato_verif: ver && ver.risultato != null && String(ver.risultato) !== '' ? String(ver.risultato) : null
        };
        const id = r.id != null && String(r.id).trim() !== '' ? String(r.id) : null;
        const esistente = id ? perId.get(id) : null;
        if (id && !esistente) throw Object.assign(new Error('Riga non trovata o di un\'altra tipologia'), { statusCode: 404 });
        await applicaRegoleScrittura(client, CKC_TABELLA, data, regoleCtx, esistente || null);
        if (esistente) {
          // Riga invariata: non si riscrive.
          const norm = (v) => (v == null ? '' : /^-?\d+(\.\d+)?$/.test(String(v)) ? String(Number(v)) : String(v));
          const uguale = Object.keys(data).every((k) => norm(data[k]) === norm(esistente[k]));
          tenute.add(id);
          if (uguale) continue;
          if (!canWriteRow(req, esistente.id_roles_write, CKC_TABELLA)) {
            throw Object.assign(new Error(READ_ONLY_ERROR), { statusCode: 403 });
          }
          data = await cryptoWrite(client, 'main', CKC_TABELLA, data, id);
          const cols = Object.keys(data).map(assertValidIdentifier);
          const params = cols.map((c) => data[c]);
          params.push(id, req.user.tenant_id, ctx.effectiveUserId);
          await client.query(
            `UPDATE "${CKC_TABELLA}" SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
              WHERE id::text = $${params.length - 2} AND tenant_id = $${params.length - 1} AND user_id = $${params.length}`,
            params
          );
          aggiornate += 1;
        } else {
          data.tenant_id = req.user.tenant_id;
          data.user_id = ctx.effectiveUserId;
          stampRoleWrite(req, data, ctx.tableColumns);
          data = await cryptoWrite(client, 'main', CKC_TABELLA, data);
          const cols = Object.keys(data).map(assertValidIdentifier);
          await client.query(
            `INSERT INTO "${CKC_TABELLA}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            cols.map((c) => data[c])
          );
          inserite += 1;
        }
      }
      // Righe tolte nel configuratore: chiuse (scadenza = ieri), come nella griglia.
      const daChiudere = attuali.filter((r) => !tenute.has(String(r.id)));
      for (const r of daChiudere) {
        if (!canWriteRow(req, r.id_roles_write, CKC_TABELLA)) throw Object.assign(new Error(READ_ONLY_ERROR), { statusCode: 403 });
      }
      if (daChiudere.length) {
        const x = await client.query(
          `UPDATE "${CKC_TABELLA}" SET scadenza = CURRENT_DATE - 1
            WHERE id::text = ANY($1::text[]) AND tenant_id = $2 AND user_id = $3`,
          [daChiudere.map((r) => String(r.id)), req.user.tenant_id, ctx.effectiveUserId]
        );
        chiuse += x.rowCount;
      }
    }
    await client.query('COMMIT');
    res.json({ inserite, aggiornate, chiuse });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// ==========================================
// CHECK LIST DEL PROGETTO (tabella chek_list), pulsante «Check List» nella scheda progetto
// ==========================================
// Perimetro: tenant + utente (proprietario delle righe del progetto, come la scheda) +
// cliente + progetto. Le righe nascono da config_chek_list (stesso tenant e utente, stessa
// tipologia del campo «Tipologia» del progetto, valore2) con ckpSincronizza, alla prima
// apertura e con il pulsante «Aggiorna» della finestra.
// Fasi con «[Licenze]» nella descrizione: una copia (fase + attività) per ogni licenza del
// campo «Licenze da attivare» del progetto, con [Licenze] sostituito dal nome della licenza.
// Ogni riga ricorda da dove nasce (config_id + licenza): l'aggiornamento allinea padre,
// figlio, descrizione e verifiche, aggiunge le righe nuove e chiude quelle non più previste,
// ma NON tocca mai check_ok e data_check (le righe spuntate non previste restano com'erano).
// Dal progetto si modifica solo check_ok: data_check = oggi quando si spunta, vuota se si toglie.
const CKP_TABELLA = 'chek_list';
const CKP_COLONNE_COPIATE = ['tipologia', 'padre', 'figlio', 'description', 'tipo_verifica',
  'tabella_verif', 'colonna_verif', 'campo_verif', 'operatore_verif', 'risultato_verif',
  'appo1_verif', 'appo2_verif', 'appo3_verif', 'appo4_verif'];
const CKP_SEGNAPOSTO_LICENZE = /\[licenze\]/i;

// Progetto del contesto: deve essere un progetto attivo dell'utente nel tenant.
async function ckpProgetto(req, projectId, pool = db) {
  const id = String(projectId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('Progetto non valido'), { statusCode: 400 });
  const p = (await pool.query(
    `SELECT id, client_id FROM projects
      WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3 AND argument = 'Progetto' AND campo = 'Progetto' LIMIT 1`,
    [id, req.user.tenant_id, req.user.user_id]
  )).rows[0];
  if (!p) throw Object.assign(new Error('Progetto non trovato'), { statusCode: 404 });
  const t = (await pool.query(
    `SELECT valore2 FROM projects
      WHERE argument = $1 AND tenant_id = $2 AND user_id = $3 AND lower(btrim(campo)) IN ('tipologia', '(*) tipologia')
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [id, req.user.tenant_id, req.user.user_id]
  )).rows[0];
  // Licenze del progetto (campo «Licenze da attivare», tipo 18: valori uniti da ", ").
  const l = (await pool.query(
    `SELECT valore2 FROM projects
      WHERE argument = $1 AND tenant_id = $2 AND user_id = $3 AND lower(btrim(campo)) IN ('licenze da attivare', '(*) licenze da attivare')
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [id, req.user.tenant_id, req.user.user_id]
  )).rows[0];
  const licenze = [...new Set(String((l && l.valore2) || '').split(',').map((x) => x.trim()).filter(Boolean))];
  return { projectId: id, clientId: p.client_id, tipologia: t && t.valore2 ? String(t.valore2).trim() : '', licenze };
}

// Condizione di una riga della configurazione (tabella_verif / campo_verif / colonna_verif /
// operatore_verif / risultato_verif): la riga entra nella check list solo se il campo del
// cliente (clients) o del progetto (projects) soddisfa il confronto. Es. «Inserire CIG /ODA su
// Commessa» solo se il cliente ha «Pubblica Amministrazione» = vero. Righe senza condizione:
// sempre previste. Campo assente o vuoto: un sì/no vale falso, gli altri valgono testo vuoto.
const CKP_VERIF_TABELLE = { clients: 'clientId', projects: 'projectId' };
const CKP_VERO = ['true', 'vero', 't', '1', 'si', 'sì', 'yes'];
const CKP_FALSO = ['false', 'falso', 'f', '0', 'no'];

async function ckpValoreCampo(pool, req, prog, tabella, campo, colonna, cache) {
  const k = `${tabella}|${campo}|${colonna}`;
  if (cache.has(k)) return cache.get(k);
  const masterId = prog[CKP_VERIF_TABELLE[tabella]];
  let valore;
  if (masterId) {
    const r = (await pool.query(
      `SELECT "${colonna}" AS v FROM "${tabella}"
        WHERE tenant_id = $1 AND user_id = $2 AND master_id = $3
          AND lower(btrim(campo)) IN (lower(btrim($4)), '(*) ' || lower(btrim($4)))
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        ORDER BY id LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, masterId, campo]
    )).rows[0];
    valore = r ? r.v : null;
  }
  cache.set(k, valore ?? null);
  return valore ?? null;
}

// booleano: colonna sì/no (valore1 dei campi, o colonna boolean delle tabelle a righe).
function ckpConfronta(valore, operatore, atteso, colonna, booleano = colonna === 'valore1') {
  const testo = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
  const bool = (v) => { const s = testo(v).toLowerCase(); return CKP_VERO.includes(s) ? 'true' : CKP_FALSO.includes(s) ? 'false' : s; };
  // Sì/no: vuoto = falso; vero/true/1 e falso/false/0 si confrontano tra loro.
  const isBool = !!booleano;
  const v = isBool ? (testo(valore) === '' ? 'false' : bool(valore)) : testo(valore);
  const a = isBool ? bool(atteso) : testo(atteso);
  const num = (s) => (s !== '' && Number.isFinite(Number(String(s).replace(',', '.'))) ? Number(String(s).replace(',', '.')) : null);
  const uguali = (x, y) => (num(x) != null && num(y) != null ? num(x) === num(y) : x.toLowerCase() === y.toLowerCase());
  const like = (x, pattern) => {
    const p = pattern.includes('%') || pattern.includes('_')
      ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
      : '.*' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*';
    return new RegExp(`^${p}$`, 'i').test(x);
  };
  switch (Number(operatore)) {
    case 1: return uguali(v, a);
    case 2: return !uguali(v, a);
    case 3: return a.split(/[,;]/).map((x) => (isBool ? bool(x) : x.trim())).some((x) => uguali(v, x));
    case 7: return !a.split(/[,;]/).map((x) => (isBool ? bool(x) : x.trim())).some((x) => uguali(v, x));
    case 4: return like(v, a);
    case 5: return !like(v, a);
    case 6: {
      // «tra»: due estremi separati da ";" o "," (es. 10;20 oppure 2026-01-01;2026-12-31).
      const [min, max] = a.split(/[;,]/).map((x) => x.trim());
      if (min == null || max == null) return false;
      if (num(v) != null && num(min) != null && num(max) != null) return num(v) >= num(min) && num(v) <= num(max);
      return v >= min && v <= max;
    }
    default: return true;
  }
}

// Condizione su una tabella a righe (Quotazioni, Task di sviluppo): righe attive del progetto
// in quella tabella (totali) e quante rispettano il confronto (ok). null se la condizione non è
// su una tabella a righe o non è completa. Colonna non più presente: totali contate, ok = 0.
async function ckpConteggioRighe(pool, req, prog, c, cache) {
  const tabella = String(c.tabella_verif || '').trim();
  const campo = String(c.campo_verif || '').trim();
  if (!tabella || !campo || c.operatore_verif == null || String(c.operatore_verif).trim() === '') return null;
  if (!(TABELLE_VERIFICA.find((t) => t.id === tabella) || {}).righe) return null;
  const col = String(c.colonna_verif || campo).trim();
  const kt = `${tabella}|tipo|${col}`;
  if (!cache.has(kt)) {
    cache.set(kt, ((await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [tabella, col]
    )).rows[0] || {}).data_type || null);
  }
  const tipo = cache.get(kt);
  const k = `${tabella}|righe|${tipo ? col : ''}`;
  if (!cache.has(k)) {
    const r = await pool.query(
      `SELECT ${tipo ? `"${assertValidIdentifier(col)}"` : 'NULL'} AS v FROM "${assertValidIdentifier(tabella)}"
        WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
      [req.user.tenant_id, req.user.user_id, prog.projectId]
    );
    cache.set(k, r.rows.map((x) => x.v));
  }
  const valori = cache.get(k);
  const ok = tipo ? valori.filter((v) => ckpConfronta(v, c.operatore_verif, c.risultato_verif, col, tipo === 'boolean')).length : 0;
  return { totali: valori.length, ok };
}

async function ckpCondizioneOk(pool, req, prog, c, cache) {
  const tabella = String(c.tabella_verif || '').trim();
  const campo = String(c.campo_verif || '').trim();
  if (!tabella || !campo || c.operatore_verif == null || String(c.operatore_verif).trim() === '') return true;
  // Tabelle a righe (Quotazioni, Task di sviluppo): vera se almeno una riga attiva del
  // progetto soddisfa il confronto; nessuna riga = falsa.
  const conteggio = await ckpConteggioRighe(pool, req, prog, c, cache);
  if (conteggio) return conteggio.ok > 0;
  if (!CKP_VERIF_TABELLE[tabella]) return true;
  const colonna = ['valore1', 'valore2', 'valore3'].includes(String(c.colonna_verif || '').trim())
    ? String(c.colonna_verif).trim() : 'valore2';
  const valore = await ckpValoreCampo(pool, req, prog, tabella, campo, colonna, cache);
  return ckpConfronta(valore, c.operatore_verif, c.risultato_verif, colonna);
}

// Righe previste per il progetto, calcolate dalla configurazione e dalle licenze.
// Chiave = config_id + licenza. ordinamento = padre * 100 + posizione della licenza: le copie
// di una fase [Licenze] stanno una dopo l'altra, nell'ordine delle licenze del progetto.
// Le righe con una condizione non soddisfatta (ckpCondizioneOk) non sono previste; se la
// condizione è sulla riga di fase (slave 0), restano fuori anche tutte le sue attività.
async function ckpRighePreviste(pool, req, prog) {
  if (!prog.tipologia) return [];
  let conf = (await pool.query(
    `SELECT * FROM config_chek_list
      WHERE tenant_id = $1 AND user_id = $2 AND tipologia = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY padre NULLS LAST, figlio NULLS LAST, id`,
    [req.user.tenant_id, req.user.user_id, prog.tipologia]
  )).rows;
  const cacheValori = new Map();
  const escluse = new Set();
  for (const c of conf) {
    if (!(await ckpCondizioneOk(pool, req, prog, c, cacheValori))) escluse.add(String(c.id));
  }
  const padriEsclusi = new Set(conf
    .filter((c) => Number(c.figlio || 0) === 0 && escluse.has(String(c.id)))
    .map((c) => String(c.padre)));
  conf = conf.filter((c) => !escluse.has(String(c.id)) && !padriEsclusi.has(String(c.padre)));
  // Fasi «licenze»: quelle la cui riga di fase (figlio 0) contiene [Licenze].
  const padriLicenze = new Set(conf
    .filter((c) => Number(c.figlio || 0) === 0 && CKP_SEGNAPOSTO_LICENZE.test(String(c.description || '')))
    .map((c) => String(c.padre)));
  const out = [];
  for (const c of conf) {
    const base = {};
    for (const col of CKP_COLONNE_COPIATE) base[col] = c[col] ?? null;
    base.config_id = c.id;
    if (padriLicenze.has(String(c.padre))) {
      // Senza licenze scelte la fase non si crea (vedi la nota del configuratore).
      prog.licenze.forEach((lic, i) => {
        out.push({ ...base, licenza: lic,
          description: String(c.description || '').replace(new RegExp(CKP_SEGNAPOSTO_LICENZE.source, 'gi'), lic).slice(0, 255),
          ordinamento: Number(c.padre || 0) * 100 + i + 1 });
      });
    } else {
      out.push({ ...base, licenza: null, ordinamento: Number(c.padre || 0) * 100 });
    }
  }
  return out;
}

// Allinea le righe del progetto a quelle previste (dentro una transazione con lock).
// Restituisce { aggiunte, aggiornate, chiuse, conservate }.
async function ckpSincronizza(client, req, prog) {
  const previste = await ckpRighePreviste(client, req, prog);
  const attuali = (await client.query(
    `SELECT * FROM "${CKP_TABELLA}"
      WHERE tenant_id = $1 AND user_id = $2 AND client_id IS NOT DISTINCT FROM $3 AND project_id = $4
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id`,
    [req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId]
  )).rows;
  const chiave = (configId, licenza) => `${configId == null ? '' : configId}|${licenza || ''}`;
  const perChiave = new Map();
  for (const r of attuali) {
    const k = chiave(r.config_id, r.licenza);
    if (r.config_id != null && !perChiave.has(k)) perChiave.set(k, r);
  }
  const norm = (v) => (v == null ? '' : /^-?\d+(\.\d+)?$/.test(String(v)) ? String(Number(v)) : String(v));
  const campi = [...CKP_COLONNE_COPIATE, 'ordinamento', 'config_id', 'licenza'];
  // Ordine delle sezioni licenza: quello già salvato (anche spostato a mano dalla finestra,
  // PUT /api/projects/checklist/ordine) vale per le sezioni esistenti; le nuove si accodano.
  const ordSezione = new Map(); // "padre|licenza" -> ordinamento
  for (const r of attuali) {
    if (!r.licenza || r.ordinamento == null) continue;
    const k = `${r.padre}|${r.licenza}`;
    if (!ordSezione.has(k)) ordSezione.set(k, Number(r.ordinamento));
  }
  const prossimo = new Map(); // padre -> ultimo ordinamento usato
  for (const [k, o] of ordSezione) {
    const padre = k.split('|')[0];
    if (o - Number(padre) * 100 < 50) prossimo.set(padre, Math.max(prossimo.get(padre) || Number(padre) * 100, o));
  }
  for (const p of previste) {
    if (!p.licenza) continue;
    const k = `${p.padre}|${p.licenza}`;
    if (!ordSezione.has(k)) {
      const n = (prossimo.get(String(p.padre)) || Number(p.padre) * 100) + 1;
      prossimo.set(String(p.padre), n);
      ordSezione.set(k, n);
    }
    p.ordinamento = ordSezione.get(k);
  }
  const usate = new Set();
  const esito = { aggiunte: 0, aggiornate: 0, chiuse: 0, conservate: 0 };
  const ruolo = isAdminUser(req) ? null : roleWriteValue(req);

  for (const p of previste) {
    const r = perChiave.get(chiave(p.config_id, p.licenza));
    if (r) {
      usate.add(String(r.id));
      // Solo struttura e testi: check_ok e data_check restano quelli che sono.
      const diversi = campi.filter((c) => norm(p[c]) !== norm(r[c]));
      if (!diversi.length) continue;
      const params = diversi.map((c) => p[c]);
      params.push(r.id);
      await client.query(
        `UPDATE "${CKP_TABELLA}" SET ${diversi.map((c, i) => `"${c}" = $${i + 1}`).join(', ')} WHERE id = $${params.length}`,
        params
      );
      esito.aggiornate += 1;
    } else {
      const data = { ...p, tenant_id: req.user.tenant_id, user_id: req.user.user_id, client_id: prog.clientId,
        project_id: prog.projectId, check_ok: false, data_check: null };
      if (ruolo != null) data.id_roles_write = ruolo;
      const cols = Object.keys(data);
      await client.query(
        `INSERT INTO "${CKP_TABELLA}" (${cols.map((c) => `"${assertValidIdentifier(c)}"`).join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => data[c])
      );
      esito.aggiunte += 1;
    }
  }
  // Righe non più previste: chiuse se non spuntate; quelle con Check/data restano com'erano.
  // Se una sezione non più prevista (es. licenza tolta) ha voci spuntate, resta aperta anche
  // la sua riga di fase e la sezione va in fondo alle altre della stessa fase (ordinamento
  // padre * 100 + 50 + n), così le voci conservate non si mescolano alle sezioni attuali.
  const spuntata = (r) => r.check_ok === true || r.data_check != null;
  const gruppo = (r) => `${r.padre}|${r.licenza || ''}`;
  const orfane = attuali.filter((r) => !usate.has(String(r.id)));
  const gruppiConservati = [...new Set(orfane.filter(spuntata).map(gruppo))];
  const daChiudere = [];
  for (const r of orfane) {
    const g = gruppo(r);
    const conserva = spuntata(r) || (Number(r.figlio || 0) === 0 && gruppiConservati.includes(g));
    if (!conserva) { daChiudere.push(String(r.id)); continue; }
    esito.conservate += 1;
    const ord = Number(r.padre || 0) * 100 + 50 + gruppiConservati.indexOf(g);
    if (Number(r.ordinamento) !== ord) {
      await client.query(`UPDATE "${CKP_TABELLA}" SET ordinamento = $1 WHERE id = $2`, [ord, r.id]);
    }
  }
  if (daChiudere.length) {
    const x = await client.query(
      `UPDATE "${CKP_TABELLA}" SET scadenza = CURRENT_DATE - 1 WHERE id::text = ANY($1::text[])`,
      [daChiudere]
    );
    esito.chiuse = x.rowCount;
  }
  await ckpRicalcolaFasi(client, req, prog);
  return esito;
}

// Fasi con attività: il loro Check non si mette a mano, lo calcola il server. Fatta quando
// tutte le attività della sezione (stesso padre e stessa licenza) sono fatte; data = la più
// recente delle attività. Fasi senza attività: Check manuale, non toccate.
async function ckpRicalcolaFasi(pool, req, prog) {
  await pool.query(
    `UPDATE "${CKP_TABELLA}" p
        SET check_ok = s.tutte, data_check = CASE WHEN s.tutte THEN s.ultima ELSE NULL END
       FROM (SELECT padre, licenza, bool_and(COALESCE(check_ok, false)) AS tutte, max(data_check) AS ultima
               FROM "${CKP_TABELLA}"
              WHERE tenant_id = $1 AND user_id = $2 AND client_id IS NOT DISTINCT FROM $3 AND project_id = $4
                AND figlio > 0 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
              GROUP BY padre, licenza) s
      WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.client_id IS NOT DISTINCT FROM $3 AND p.project_id = $4
        AND COALESCE(p.figlio, 0) = 0 AND (p.scadenza IS NULL OR p.scadenza >= CURRENT_DATE)
        AND p.padre IS NOT DISTINCT FROM s.padre AND p.licenza IS NOT DISTINCT FROM s.licenza
        AND (p.check_ok IS DISTINCT FROM s.tutte
             OR p.data_check IS DISTINCT FROM (CASE WHEN s.tutte THEN s.ultima ELSE NULL END))`,
    [req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId]
  );
}

async function ckpRighe(req, prog, pool = db) {
  const r = await pool.query(
    `SELECT id, tipologia, padre, figlio, ordinamento, description, licenza, check_ok, data_check::text AS data_check, id_roles_write,
            tabella_verif, campo_verif, colonna_verif, operatore_verif, risultato_verif
       FROM "${CKP_TABELLA}"
      WHERE tenant_id = $1 AND user_id = $2 AND client_id IS NOT DISTINCT FROM $3 AND project_id = $4
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY ordinamento NULLS LAST, padre NULLS LAST, figlio NULLS LAST, id`,
    [req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId]
  );
  // Voci con condizione su Quotazioni / Task di sviluppo: conteggio da mostrare accanto alla
  // descrizione (righe del progetto nella tabella e quante rispettano la condizione).
  const cache = new Map();
  const out = [];
  for (const x of r.rows) {
    const { tabella_verif, campo_verif, colonna_verif, operatore_verif, risultato_verif, ...riga } = x;
    let conteggio = null;
    try {
      conteggio = await ckpConteggioRighe(pool, req, prog, { tabella_verif, campo_verif, colonna_verif, operatore_verif, risultato_verif }, cache);
    } catch (e) { /* conteggio non disponibile: la voce resta senza */ }
    const dove = conteggio ? (TABELLE_VERIFICA.find((t) => t.id === tabella_verif) || {}).display : null;
    out.push({ ...riga, ...(conteggio ? { conteggio: { ...conteggio, tabella: dove } } : {}),
      __can_write: canWriteRow(req, x.id_roles_write, CKP_TABELLA) });
  }
  return out;
}

// Lettura senza creare nulla (stato del pulsante all'apertura della scheda).
app.get('/api/projects/checklist', requireAuth, async (req, res) => {
  try {
    const prog = await ckpProgetto(req, req.query && req.query.projectId);
    res.json({ tipologia: prog.tipologia, licenze: prog.licenze, rows: await ckpRighe(req, prog) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Apertura dal pulsante: se il progetto non ha ancora la check list la crea dalla configurazione.
app.post('/api/projects/checklist/apri', requireAuth, async (req, res) => {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const prog = await ckpProgetto(req, req.body && req.body.projectId, client);
    // Un'apertura alla volta per progetto: due clic ravvicinati non creano righe doppie.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chek_list|${prog.projectId}`]);
    let rows = await ckpRighe(req, prog, client);
    // A ogni apertura: se manca la check list si crea, altrimenti si riallinea a configurazione,
    // condizioni e licenze attuali (stessa funzione dell'ex pulsante «Aggiorna»: Check e date
    // non cambiano mai).
    const nuova = !rows.length;
    let esito = null;
    if (prog.tipologia) {
      esito = await ckpSincronizza(client, req, prog);
      if (esito.aggiunte || esito.aggiornate || esito.chiuse) rows = await ckpRighe(req, prog, client);
    }
    await client.query('COMMIT');
    res.json({ tipologia: prog.tipologia, licenze: prog.licenze, creata: nuova && !!(esito && esito.aggiunte), esito: nuova ? null : esito, rows });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// Pulsante «Aggiorna» della finestra: riallinea la check list a configurazione e licenze
// attuali (ckpSincronizza). Check e data non cambiano mai.
app.post('/api/projects/checklist/aggiorna', requireAuth, async (req, res) => {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const prog = await ckpProgetto(req, req.body && req.body.projectId, client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chek_list|${prog.projectId}`]);
    if (!prog.tipologia) throw Object.assign(new Error('Il progetto non ha una Tipologia'), { statusCode: 400 });
    const esito = await ckpSincronizza(client, req, prog);
    const rows = await ckpRighe(req, prog, client);
    await client.query('COMMIT');
    res.json({ tipologia: prog.tipologia, licenze: prog.licenze, esito, rows });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// Ordine delle sezioni licenza di una fase, scelto dalla finestra con le frecce:
// { projectId, padre, licenze: [ "Presenze", "Nota Spese", ... ] } nell'ordine voluto.
// ordinamento = padre * 100 + posizione; check e date non cambiano.
app.put('/api/projects/checklist/ordine', requireAuth, async (req, res) => {
  let client;
  try {
    const padre = Number(req.body && req.body.padre);
    const licenze = Array.isArray(req.body && req.body.licenze) ? req.body.licenze.map((x) => String(x)) : [];
    if (!Number.isInteger(padre) || padre < 0 || !licenze.length || licenze.length > 40) {
      return res.status(400).json({ error: 'Ordine non valido' });
    }
    client = await db.connect();
    await client.query('BEGIN');
    const prog = await ckpProgetto(req, req.body && req.body.projectId, client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chek_list|${prog.projectId}`]);
    for (let i = 0; i < licenze.length; i++) {
      await client.query(
        `UPDATE "${CKP_TABELLA}" SET ordinamento = $1
          WHERE tenant_id = $2 AND user_id = $3 AND client_id IS NOT DISTINCT FROM $4 AND project_id = $5
            AND padre = $6 AND licenza = $7 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
        [padre * 100 + i + 1, req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId, padre, licenze[i]]
      );
    }
    const rows = await ckpRighe(req, prog, client);
    await client.query('COMMIT');
    res.json({ tipologia: prog.tipologia, licenze: prog.licenze, rows });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// ==========================================
// KICK-OFF DEL PROGETTO (pulsante «Kick-off» accanto a Check List nella scheda progetto)
// ==========================================
// Team = righe di proj_componenti del progetto (tenant + utente + progetto, non scadute):
// si aggiungono scegliendo un contatto della rubrica e si tolgono chiudendo la riga
// (scadenza = ieri, come nel resto dell'app). Licenze = campo «Licenze da attivare» del
// progetto (ckpProgetto). AI = Impostazioni › AI › «AI Slide Kick-Off» (settings.valore2).
// «Genera»: il browser manda il template .pptx scelto dal PC; il server ne estrae i testi
// (config/kickoffPptx.js), chiede all'AI le modifiche con il prompt KICKOFF (app_prompts),
// le applica e restituisce il nuovo .pptx. Il file vive solo in memoria per la durata della
// richiesta: niente viene salvato sulla VM né nel database.
const KO_TABELLA = 'proj_componenti';
const KO_MAX_TEMPLATE = 40 * 1024 * 1024;
const KO_MAX_TESTO_AI = 120000;
const koNorm = (s) => String(s || '').trim().toLowerCase();

// Formato della risposta: sempre aggiunto dal server, così un prompt personalizzato non può
// romperlo.
const KO_FORMATO = `FORMATO DELLA RISPOSTA (obbligatorio)
Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, in questa forma:
{"modifiche": [
  {"id": "S1.2", "testo": "nuovo testo della casella (\\n per andare a capo)"},
  {"id": "S4.T1", "righe": [["cella 1", "cella 2"], ["cella 1", "cella 2"]]},
  {"id": "S4.9", "elimina": true},
  {"id": "S8.3", "sposta_in": "S7"},
  {"id": "S8", "elimina_slide": true}
]}
- "id" è il codice tra parentesi quadre del template qui sotto: S<slide>.<n> per caselle di testo, forme e immagini, S<slide>.T<n> per le tabelle, S<slide> per l'intera slide.
- "testo" sostituisce tutto il testo della casella: riscrivi anche le righe che restano uguali, una riga per ogni riga della casella originale e nello stesso ordine (lo stile di ogni riga resta quello del template). "" svuota la casella.
- "righe" sostituisce tutte le righe della tabella, compresa l'intestazione se c'è: le righe in più copiano lo stile dell'ultima riga.
- "elimina": true toglie dalla slide la casella, la forma, l'immagine o la tabella.
- "elimina_slide": true toglie l'intera slide (non tutte le slide).
- "sposta_in": "S<n>" sposta in un'altra slide l'intero blocco di cui fa parte l'elemento (forma con le sue caselle collegate, icona e descrizione: basta indicare uno dei suoi codici, es. il titolo). Serve per riunire in una sola slide elementi che nel template sono su più slide (es. una licenza che si trova nella slide 8 quando si tiene solo la slide 7): sposta prima i blocchi che servono, poi elimina la slide rimasta inutile. Nella slide di destinazione i blocchi vengono ridisposti e centrati in automatico.
- Ogni forma e icona indica a quali caselle appartiene ("insieme a: …", "dentro …"): una forma "senza testo" con caselle collegate fa parte di quell'elemento (es. il riquadro colorato di una licenza con titolo e descrizione in caselle a parte) e NON va eliminata se quelle caselle restano piene.
- Quando svuoti ("") o elimini tutte le caselle collegate a una forma (es. il cerchio di una persona, il riquadro di una licenza), il sistema toglie da solo la forma e le icone che contiene: non serve eliminarle. Elimina esplicitamente solo le forme con "nessun testo collegato" che non servono.
- Le posizioni (x, y, larg, alt in % della slide) servono a capire quali elementi stanno insieme.
- Foto: per le persone del team segnate "[foto disponibile]" il sistema inserisce da solo la foto nella forma (es. il cerchio) del blocco in cui compare la loro email. Per questo ogni persona deve stare in un blocco suo, con la sua email scritta nella casella del blocco; non serve nessuna modifica per la foto.
- Includi solo gli elementi da cambiare. Non usare markdown nei testi.`;

// AI scelta in Impostazioni › AI: il primo dei campi indicati che ha un valore (settings.valore2).
async function koProviderName(req, campi = ['AI Slide Kick-Off']) {
  for (const campo of campi) {
    const c = String(campo).trim().toLowerCase();
    const r = (await db.query(
      `SELECT valore2 FROM settings
        WHERE tenant_id = $1 AND user_id = $2
          AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        ORDER BY id LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, c]
    )).rows[0];
    if (r && r.valore2 && String(r.valore2).trim()) return String(r.valore2).trim();
  }
  return '';
}

// Colonna del ruolo della persona in rubrica: la prima presente tra questi nomi, null se
// la tabella non ce l'ha.
const KO_COLONNE_RUOLO = ['ruolo', 'role', 'ruolo_progetto', 'qualifica', 'funzione'];
async function koColRuolo(tabella, pool = db) {
  const cols = await getTableColumns(tabella, pool);
  return KO_COLONNE_RUOLO.find((c) => cols.has(c)) || null;
}

// Contatti della rubrica (tenant + utente), con il ruolo. tutte = anche quelli scaduti.
async function koRubrica(req, { tutte = false, pool = db } = {}) {
  const col = await koColRuolo('rubrica', pool);
  const r = await pool.query(
    `SELECT id::text AS id, nominativo, email, scadenza${col ? `, "${col}" AS ruolo` : ''} FROM rubrica
      WHERE tenant_id = $1 AND user_id = $2
        ${tutte ? '' : 'AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)'}
      LIMIT 5000`,
    [req.user.tenant_id, req.user.user_id]
  );
  return r.rows.map((x) => ({ ...x, ruolo: x.ruolo == null ? '' : String(x.ruolo).trim() }));
}

// Righe del team; tutte = true include quelle chiuse (per riaprirle invece di duplicarle).
// In proj_componenti si salvano solo nominativo ed email: il ruolo si legge sempre dal
// contatto di rubrica con la stessa email (e va nel prompt dell'AI).
async function koTeam(req, prog, { tutte = false, pool = db } = {}) {
  const r = await pool.query(
    `SELECT id::text AS id, nominativo, email, id_roles_write, scadenza
       FROM "${KO_TABELLA}"
      WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3
        ${tutte ? '' : 'AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)'}
      ORDER BY id`,
    [req.user.tenant_id, req.user.user_id, prog.projectId]
  );
  if (!r.rows.length) return r.rows;
  const ruoloRubrica = new Map((await koRubrica(req, { tutte: true, pool }))
    .filter((c) => c.ruolo).map((c) => [koNorm(c.email), c.ruolo]));
  return r.rows.map((x) => ({ ...x, ruolo: ruoloRubrica.get(koNorm(x.email)) || '' }));
}
const koTeamOut = (req, rows) => rows
  .map((x) => ({ id: x.id, nominativo: x.nominativo || '', email: x.email || '', ruolo: x.ruolo || '', __can_write: canWriteRow(req, x.id_roles_write, KO_TABELLA) }))
  .sort((a, b) => a.nominativo.localeCompare(b.nominativo, 'it', { sensitivity: 'base' }));

// Apertura della finestra: progetto, team, licenze e AI scelta (con lo stato della chiave).
app.get('/api/projects/kickoff', requireAuth, async (req, res) => {
  try {
    const prog = await ckpProgetto(req, req.query && req.query.projectId);
    const nome = await koProviderName(req);
    const cfg = AI_PROVIDERS[koNorm(nome)];
    let connessa = false;
    if (cfg) {
      const el = await getIntegration(req.user.user_id, cfg.provider);
      connessa = !!el[`${cfg.prefix}_api_key`];
    }
    res.json({
      licenze: prog.licenze,
      team: koTeamOut(req, await koTeam(req, prog)),
      ai: { nome, supportata: !!cfg, connessa }
    });
  } catch (error) {
    res.status(error.statusCode || error.status || 500).json({ error: error.message });
  }
});

// Ricerca nella rubrica (tenant + utente, contatti non scaduti). Il filtro si fa dopo la
// lettura perché nominativo ed email possono essere cifrati.
app.get('/api/projects/kickoff/rubrica', requireAuth, async (req, res) => {
  try {
    const q = koNorm(req.query && req.query.q);
    if (!q) await sincronizzaRubricaTenant(req.user.tenant_id); // all'apertura dell'elenco
    const out = (await koRubrica(req))
      .filter((x) => !q || koNorm(x.nominativo).includes(q) || koNorm(x.email).includes(q) || koNorm(x.ruolo).includes(q))
      .sort((a, b) => String(a.nominativo || '').localeCompare(String(b.nominativo || ''), 'it', { sensitivity: 'base' }))
      .slice(0, 30)
      .map((x) => ({ id: x.id, nominativo: x.nominativo || '', email: x.email || '', ruolo: x.ruolo }));
    res.json({ contatti: out });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Aggiunge al team un contatto della rubrica: { projectId, rubricaId }. Stessa email già
// nel team: errore; riga chiusa in passato (stessa email): si riapre.
app.post('/api/projects/kickoff/team', requireAuth, async (req, res) => {
  let client;
  try {
    const rubricaId = String((req.body && req.body.rubricaId) || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(rubricaId)) return res.status(400).json({ error: 'Contatto non valido' });
    client = await db.connect();
    await client.query('BEGIN');
    const prog = await ckpProgetto(req, req.body && req.body.projectId, client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kickoff_team|${prog.projectId}`]);
    const contatto = (await koRubrica(req, { tutte: true, pool: client })).find((x) => x.id === rubricaId.toLowerCase());
    if (!contatto) throw Object.assign(new Error('Contatto non trovato in rubrica'), { statusCode: 404 });
    const email = String(contatto.email || '').trim();
    const nominativo = String(contatto.nominativo || '').trim();
    if (!email || !nominativo) throw Object.assign(new Error('Il contatto in rubrica non ha nominativo o email'), { statusCode: 400 });
    // Nel team (proj_componenti) passano solo nominativo ed email; il ruolo resta in rubrica.
    const righe = await koTeam(req, prog, { tutte: true, pool: client });
    const stessa = righe.filter((x) => koNorm(x.email) === koNorm(email));
    const attiva = stessa.find((x) => !x.scadenza || new Date(x.scadenza) >= new Date(new Date().toDateString()));
    if (attiva) throw Object.assign(new Error(`${nominativo} è già nel team`), { statusCode: 409 });
    if (stessa.length) {
      const r = stessa[stessa.length - 1];
      if (!canWriteRow(req, r.id_roles_write, KO_TABELLA)) throw Object.assign(new Error(READ_ONLY_ERROR), { statusCode: 403 });
      const dati = await cryptoWrite(client, 'main', KO_TABELLA, { nominativo }, r.id);
      const cols = Object.keys(dati).map(assertValidIdentifier);
      await client.query(
        `UPDATE "${KO_TABELLA}" SET scadenza = NULL, ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE id::text = $1`,
        [r.id, ...cols.map((c) => dati[c])]
      );
    } else {
      const riga = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, client_id: prog.clientId,
        project_id: prog.projectId, email, nominativo };
      stampRoleWrite(req, riga, await getTableColumns(KO_TABELLA));
      await insertRowEncrypted(client, 'main', KO_TABELLA, riga);
    }
    const team = koTeamOut(req, await koTeam(req, prog, { pool: client }));
    await client.query('COMMIT');
    res.json({ team });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// Toglie una persona dal team: la riga si chiude (scadenza = ieri), ore e dati Qlik restano.
app.delete('/api/projects/kickoff/team/:id', requireAuth, async (req, res) => {
  try {
    const prog = await ckpProgetto(req, req.query && req.query.projectId);
    const r = (await db.query(
      `SELECT id, id_roles_write FROM "${KO_TABELLA}"
        WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3 AND project_id = $4 LIMIT 1`,
      [String(req.params.id || ''), req.user.tenant_id, req.user.user_id, prog.projectId]
    )).rows[0];
    if (!r) return res.status(404).json({ error: 'Persona non trovata nel team' });
    if (!canWriteRow(req, r.id_roles_write, KO_TABELLA)) return res.status(403).json({ error: READ_ONLY_ERROR });
    await db.query(`UPDATE "${KO_TABELLA}" SET scadenza = CURRENT_DATE - 1 WHERE id = $1`, [r.id]);
    res.json({ team: koTeamOut(req, await koTeam(req, prog)) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// «Genera»: corpo = il file .pptx (application/octet-stream), projectId e nome in query.
// Risposta: il .pptx modificato da scaricare.
app.post('/api/projects/kickoff/genera', requireAuth,
  express.raw({ type: 'application/octet-stream', limit: KO_MAX_TEMPLATE }),
  async (req, res) => {
    const t0 = Date.now();
    try {
      const prog = await ckpProgetto(req, req.query && req.query.projectId);
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Scegli il file Template (.pptx)' });
      const nomeAi = await koProviderName(req);
      if (!nomeAi) return res.status(400).json({ error: 'Scegli l\'AI in Impostazioni › AI › «AI Slide Kick-Off»' });
      if (!AI_PROVIDERS[koNorm(nomeAi)]) return res.status(400).json({ error: `L'AI «${nomeAi}» non può generare le slide: scegli ChatGPT, Claude, Gemini o Mistral in Impostazioni › AI › «AI Slide Kick-Off»` });

      const template = await leggiTemplate(req.body);
      const descrizione = descriviTemplate(template);
      if (descrizione.length > KO_MAX_TESTO_AI) {
        return res.status(413).json({ error: 'Il template contiene troppo testo per l\'AI: usa un template più corto' });
      }

      // Dati del progetto per i segnaposto del prompt.
      const nomi = (await db.query(
        `SELECT (SELECT valore2 FROM projects WHERE id::text = $1 LIMIT 1) AS progetto,
                (SELECT valore2 FROM clients WHERE id = $2 LIMIT 1) AS cliente,
                (SELECT concat_ws(' ', name, cognome) FROM users WHERE id = $3) AS utente`,
        [prog.projectId, prog.clientId, req.user.user_id]
      )).rows[0] || {};
      const team = koTeamOut(req, await koTeam(req, prog));
      // Foto del profilo (rubrica.foto, vedi Supporto/CreaDB/rubrica_foto.sql) delle persone
      // del team: le mette il server nel cerchio del blocco dove compare la loro email.
      const fotoTeam = new Map();
      if ((await getTableColumns('rubrica')).has('foto')) {
        const emailTeam = new Set(team.map((p) => koNorm(p.email)).filter(Boolean));
        const rf = await db.query(
          'SELECT email, foto, foto_mime FROM rubrica WHERE tenant_id = $1 AND user_id = $2 AND foto IS NOT NULL',
          [req.user.tenant_id, req.user.user_id]
        );
        for (const x of rf.rows) {
          const k = koNorm(x.email);
          if (emailTeam.has(k) && Buffer.isBuffer(x.foto) && !fotoTeam.has(k)) fotoTeam.set(k, { data: x.foto, mime: x.foto_mime || 'image/jpeg' });
        }
      }
      const vars = {
        PROGETTO: nomi.progetto || '',
        CLIENTE: nomi.cliente || '',
        TEAM: team.length ? team.map((p) => `- ${p.nominativo}${p.ruolo ? ` — ruolo: ${p.ruolo}` : ''}${p.email ? ` (${p.email})` : ''}${fotoTeam.has(koNorm(p.email)) ? ' [foto disponibile]' : ''}`).join('\n') : '(nessuna persona indicata)',
        LICENZE: prog.licenze.length ? prog.licenze.map((l) => `- ${l}`).join('\n') : '(nessuna licenza indicata)',
        DATA: new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        UTENTE: String(nomi.utente || '').trim() || req.user.email || ''
      };
      const testoPrompt = (await getPromptFor('KICKOFF', req.user)).testo;
      const istruzioni = testoPrompt.replace(/\{\{(PROGETTO|CLIENTE|TEAM|LICENZE|DATA|UTENTE)\}\}/g, (m, k) => vars[k]);
      const prompt = `${istruzioni}\n\n${KO_FORMATO}\n\nTEMPLATE (testi attuali con i codici):\n${descrizione}`;

      // Controllo prima di creare il file: se il prompt usa {{LICENZE}} / {{TEAM}}, ogni
      // licenza e l'email di ogni persona devono comparire nelle slide. Se l'AI ne ha perso
      // qualcuno (es. ha riusato il riquadro di una licenza per un'altra), si chiede una
      // correzione una volta, indicando cosa manca.
      const normTesto = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
      const attesi = [
        ...(testoPrompt.includes('{{LICENZE}}') ? prog.licenze.map((l) => ({ cosa: `la licenza «${l}»`, testo: l })) : []),
        ...(testoPrompt.includes('{{TEAM}}') ? team.filter((p) => p.email).map((p) => ({ cosa: `${p.nominativo} (${p.email})`, testo: p.email })) : [])
      ];
      const mancanti = (mods) => {
        const finale = normTesto(testoRisultante(template, mods));
        return attesi.filter((a) => !finale.includes(normTesto(a.testo)));
      };
      let risposta = await askAiProvider(req.user.user_id, nomeAi, prompt, { json: true });
      let modifiche = leggiRispostaAi(risposta.text);
      let persi = mancanti(modifiche);
      if (persi.length) {
        console.warn(`[KICKOFF] progetto ${prog.projectId}: mancano ${persi.map((a) => a.cosa).join(', ')}: chiedo la correzione all'AI`);
        const correzione = `${prompt}\n\nATTENZIONE: una tua risposta precedente era sbagliata perché nelle slide risultanti mancavano: ${persi.map((a) => a.cosa).join('; ')}.
Ogni licenza deve avere il suo riquadro con il suo nome come titolo (non riusare il riquadro di una licenza per un'altra: se il template ha già un riquadro con quel nome, usa proprio quello, anche se è in un'altra slide: in quel caso spostalo con "sposta_in" prima di eliminare la sua slide) e ogni persona del team deve comparire con la sua email.
Risposta precedente da correggere:\n${String(risposta.text || '').slice(0, 30000)}\n\nRiscrivi l'elenco COMPLETO delle modifiche corretto, nello stesso formato.`;
        try {
          const r2 = await askAiProvider(req.user.user_id, nomeAi, correzione, { json: true });
          const m2 = leggiRispostaAi(r2.text);
          const p2 = mancanti(m2);
          if (p2.length < persi.length) { risposta = r2; modifiche = m2; persi = p2; }
        } catch (e) {
          console.warn(`[KICKOFF] correzione non riuscita: ${e.message}`);
        }
      }
      // Spostamenti di blocchi che non sono licenze del progetto (es. l'AI porta nella slide 7
      // anche moduli non acquistati della slide 8): scartati, quei blocchi restano dove sono
      // (e spariscono con la loro slide se l'AI la elimina).
      const filtraSpostamenti = (mods) => {
        if (!testoPrompt.includes('{{LICENZE}}') || !prog.licenze.length) return mods;
        const licenze = prog.licenze.map(normTesto);
        const scartati = spostamentiRichiesti(template, mods).filter((sp) => {
          const t = normTesto(sp.titolo);
          return !t || !licenze.some((l) => t === l || t.includes(l) || l.includes(t));
        });
        if (!scartati.length) return mods;
        const ids = new Set(scartati.map((sp) => sp.id));
        console.warn(`[KICKOFF] progetto ${prog.projectId}: scartati gli spostamenti di blocchi che non sono licenze del progetto: ${scartati.map((sp) => sp.titolo || sp.id).join(', ')}`);
        return mods.filter((m) => !(m && m.sposta_in && ids.has(String(m.id || '').trim().toUpperCase())));
      };
      modifiche = filtraSpostamenti(modifiche);

      // Le modifiche si applicano sempre a una copia nuova del template (applicaModifiche la
      // modifica): `template` resta l'originale, usato per i controlli.
      const applicaAlTemplate = async (mods) => applicaModifiche(await leggiTemplate(req.body), mods, { foto: fotoTeam });
      let esito = await applicaAlTemplate(modifiche);
      if (!esito.applicate) return res.status(502).json({ error: `${risposta.label} non ha indicato modifiche applicabili al template: controlla il prompt e riprova` });

      // REVISIONE: l'AI riceve istruzioni, template originale, le sue modifiche e la bozza
      // risultante (descritta come testo). Se la bozza va bene la conferma, altrimenti
      // restituisce l'elenco completo corretto, che si applica al template originale.
      // Tutto in memoria: la bozza non viene salvata da nessuna parte.
      let revisione = 'non eseguita';
      const descrizioneBozza = descriviTemplate(await leggiTemplate(esito.buffer));
      const promptRevisione = `${istruzioni}

SEI IL REVISORE della presentazione di Kick-off. Un primo passaggio ha prodotto le MODIFICHE qui sotto, già applicate al TEMPLATE ORIGINALE: il RISULTATO è la presentazione ottenuta. Confronta il RISULTATO con le istruzioni e con i dati del progetto.
Controlla in particolare:
- ogni dato richiesto è presente e corretto (licenze, persone del team con nominativo, ruolo ed email, cliente, progetto, data);
- non restano testi segnaposto o dati del template che dovevano essere sostituiti o tolti;
- nessun testo è finito nel posto sbagliato (es. il nome di una licenza nel riquadro con l'icona o la descrizione di un'altra);
- le slide e i blocchi da togliere sono stati tolti, quelli da tenere ci sono ancora.
Non sono problemi (li fa il sistema): forme rimaste senza testo tolte automaticamente, blocchi ricentrati o spostati di posizione, foto delle persone (le inserisce il sistema nel cerchio e non compaiono nella descrizione del RISULTATO).

Rispondi SOLO con un oggetto JSON:
- se il RISULTATO rispetta le istruzioni: {"ok": true}
- altrimenti: {"ok": false, "problemi": ["descrizione breve di ogni problema"], "modifiche": [...]}, dove "modifiche" è l'elenco COMPLETO e corretto da applicare al TEMPLATE ORIGINALE (non al risultato), con i codici del TEMPLATE ORIGINALE e gli stessi tipi di modifica descritti qui sotto.

${KO_FORMATO}

TEMPLATE ORIGINALE (codici e testi):
${descrizione}

MODIFICHE DEL PRIMO PASSAGGIO:
${JSON.stringify(modifiche).slice(0, 60000)}

RISULTATO (presentazione dopo le modifiche; qui i codici sono rinumerati e servono solo a leggerla):
${descrizioneBozza}`;
      if (promptRevisione.length <= 3 * KO_MAX_TESTO_AI) {
        try {
          const r3 = await askAiProvider(req.user.user_id, nomeAi, promptRevisione, { json: true });
          const rev = leggiRevisioneAi(r3.text);
          if (rev.ok) {
            revisione = 'confermata';
          } else if (rev.modifiche && rev.modifiche.length) {
            const mods2 = filtraSpostamenti(rev.modifiche);
            const persi2 = mancanti(mods2);
            const esito2 = persi2.length <= persi.length ? await applicaAlTemplate(mods2) : null;
            if (esito2 && esito2.applicate) {
              esito = esito2; modifiche = mods2; persi = persi2; risposta = r3;
              revisione = `corretta${rev.problemi.length ? `: ${rev.problemi.join('; ')}` : ''}`;
            } else {
              revisione = 'correzione scartata (peggiorava il risultato): tenuta la prima stesura';
            }
          } else {
            revisione = `problemi segnalati senza correzione: ${rev.problemi.join('; ')}`;
          }
        } catch (e) {
          console.warn(`[KICKOFF] revisione non riuscita: ${e.message}`);
          revisione = 'non riuscita: tenuta la prima stesura';
        }
      }
      console.log(`[KICKOFF] progetto ${prog.projectId}: revisione ${revisione.slice(0, 300)}`);

      const nomeFile = `Kick-off ${vars.PROGETTO || 'progetto'}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) + '.pptx';
      console.log(`[KICKOFF] progetto ${prog.projectId}: ${esito.applicate} modifiche applicate, ${esito.ignorate} ignorate, ${esito.elementiTolti} elementi e ${esito.slideTolte} slide tolti, ${esito.slideRiallineate} slide riallineate, ${esito.blocchiSpostati} blocchi spostati, ${esito.fotoMesse} foto (${risposta.label} ${risposta.model}, ${Math.round((Date.now() - t0) / 1000)}s)`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('Content-Disposition', `attachment; filename="kick-off.pptx"; filename*=UTF-8''${encodeURIComponent(nomeFile)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Kickoff-Modifiche', String(esito.applicate));
      // Dati ancora mancanti dopo la correzione: la finestra li segnala.
      if (persi.length) res.setHeader('X-Kickoff-Mancanti', encodeURIComponent(persi.map((a) => a.cosa).join('; ')));
      res.setHeader('X-Kickoff-Ai', encodeURIComponent(`${risposta.label} (${risposta.model})`));
      res.setHeader('X-Kickoff-Revisione', encodeURIComponent(revisione.slice(0, 1500)));
      res.send(esito.buffer);
    } catch (error) {
      console.error('❌ KICKOFF:', error.message);
      res.status(error.statusCode || error.status || 500).json({ error: error.message });
    }
  });

// ==========================================
// OFFERTA ECONOMICA DEL PROGETTO (pulsante accanto a Kick-off nella scheda progetto)
// ==========================================
// Come il Kick-off, ma su un template Word (.docx, config/offertaDocx.js). Dati passati
// all'AI: i campi del progetto Importo, Sconto Applicato, Importo non scontato, Effort Totale,
// Preventivo (cercati in tutto il progetto, anche dentro le sezioni) e le righe della griglia
// «Invoice» del progetto. Prompt: funzione OFFERTA_ECONOMICA di app_prompts. AI: Impostazioni ›
// AI › «AI Offerta Economica» se c'è, altrimenti «AI Slide Kick-Off». Prima stesura, revisione
// dell'AI sulla bozza, file finale: tutto in memoria, nulla salvato sul server.
const OF_CAMPI = { importo: 'Importo', sconto: 'Sconto Applicato', importoNonScontato: 'Importo non scontato', effort: 'Effort Totale', preventivo: 'Preventivo' };
const OF_CAMPI_CLIENTE = { ragioneSociale: 'Ragione Sociale', codiceFiscale: 'Cod fiscale', partitaIva: 'P.iva' };
const OF_CAMPI_AI = ['AI Offerta Economica', 'AI Slide Kick-Off'];
const ofNormCampo = (c) => String(c || '').replace(/^\(\*\)\s*/, '').trim().toLowerCase();

const OF_FORMATO = `FORMATO DELLA RISPOSTA (obbligatorio)
Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, in questa forma:
{"modifiche": [
  {"id": "P3", "testo": "nuovo testo del paragrafo (\\n per più paragrafi con lo stesso stile)"},
  {"id": "T1", "righe": [["Intestazione 1", "Intestazione 2"], ["cella", "cella"]]},
  {"id": "P9", "elimina": true}
]}
- "id" è il codice tra parentesi quadre del documento qui sotto: P<n> paragrafo del corpo, T<n> tabella, H<n> paragrafo di intestazione o piè di pagina. Tra graffe c'è lo stile del paragrafo (es. {Heading1} = titolo).
- "testo" sostituisce tutto il testo del paragrafo (stile e carattere del template restano): riscrivi anche le parti che restano uguali.
- "righe" sostituisce tutte le righe della tabella, compresa l'intestazione se c'è: le righe in più copiano lo stile dell'ultima riga.
- "elimina": true toglie il paragrafo o la tabella.
- Barrato: il testo racchiuso tra ~~ e ~~ viene scritto barrato (es. "~~42.000,00 €~~ importo scontato a: 35.000,00 €"); vale nei paragrafi e nelle celle delle tabelle.
- Includi solo gli elementi da cambiare. Non usare altro markdown nei testi.`;

// Id del progetto e di tutte le sue sezioni (nodi padre annidati), per cercare i campi ovunque.
async function ofAlbero(req, prog) {
  const r = await db.query(
    `WITH RECURSIVE albero(id, livello) AS (
       SELECT id, 0 FROM projects WHERE id::text = $1
       UNION ALL
       SELECT p.id, a.livello + 1 FROM projects p JOIN albero a ON p.argument = a.id::text
        WHERE p.tenant_id = $2 AND p.user_id = $3 AND a.livello < 6 AND p.tipo_valore::text = '0'
     )
     SELECT id::text AS id FROM albero`,
    [prog.projectId, req.user.tenant_id, req.user.user_id]
  );
  return r.rows.map((x) => x.id);
}

// Valore di un campo: dalla colonna del suo tipo (sì/no valore1, numeri valore3, resto valore2);
// se quella è vuota, la prima non vuota.
function ofValore(row) {
  const t = String(row.tipo_valore ?? '').trim();
  const col = ['1', '14', '22'].includes(t) ? 'valore1' : (['3', '8'].includes(t) ? 'valore3' : 'valore2');
  const pieno = (v) => v != null && String(v).trim() !== '';
  const v = pieno(row[col]) ? row[col] : [row.valore3, row.valore2, row.valore1].find(pieno);
  return v == null ? '' : String(v).trim();
}
const ofNumero = (v, decimali = 2) => {
  const n = Number(String(v).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return v !== '' && Number.isFinite(n) ? n.toLocaleString('it-IT', { minimumFractionDigits: decimali, maximumFractionDigits: decimali }) : String(v);
};

async function ofDati(req, prog) {
  const ids = await ofAlbero(req, prog);
  const r = await db.query(
    `SELECT campo, tipo_valore::text AS tipo_valore, valore1::text AS valore1, valore2::text AS valore2, valore3::text AS valore3, tabella, colonna
       FROM projects
      WHERE tenant_id = $1 AND user_id = $2 AND argument = ANY($3::text[])
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id`,
    [req.user.tenant_id, req.user.user_id, ids]
  );
  const perCampo = new Map();
  for (const x of r.rows) { const k = ofNormCampo(x.campo); if (!perCampo.has(k)) perCampo.set(k, x); }
  // Gestione a ore o a giorni (campo «Gestione a HH», come la griglia del progetto): i campi
  // che esistono solo in versione _hh/_gg (es. «Sconto Applicato_gg») si leggono da quella giusta.
  const gestione = perCampo.get('gestione a hh');
  const aOre = !!gestione && ['true', 't', '1'].includes(String(gestione.valore1 || '').trim().toLowerCase());
  const dati = { aOre };
  for (const [k, nome] of Object.entries(OF_CAMPI)) {
    const n = nome.toLowerCase();
    const giusto = aOre ? '_hh' : '_gg', altro = aOre ? '_gg' : '_hh';
    const candidati = [perCampo.get(n), perCampo.get(n + giusto), perCampo.get(n + altro)].filter(Boolean);
    const row = candidati.find((r) => ofValore(r) !== '') || candidati[0];
    dati[k] = row ? ofValore(row) : '';
  }
  const invoice = perCampo.get('invoice');
  // Dati del cliente del progetto (campi di clients con master_id = cliente, come le condizioni
  // della Check List). Nomi confrontati senza maiuscole, spazi e punti ("P.iva" = "P. IVA").
  const chiave = (c) => ofNormCampo(c).replace(/[^a-z0-9]/g, '');
  if (prog.clientId) {
    const rc = await db.query(
      `SELECT campo, tipo_valore::text AS tipo_valore, valore1::text AS valore1, valore2::text AS valore2, valore3::text AS valore3
         FROM clients
        WHERE tenant_id = $1 AND user_id = $2 AND master_id = $3
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
        ORDER BY id`,
      [req.user.tenant_id, req.user.user_id, prog.clientId]
    );
    const perCampoCliente = new Map();
    for (const x of rc.rows) { const k = chiave(x.campo); if (!perCampoCliente.has(k)) perCampoCliente.set(k, x); }
    for (const [k, nome] of Object.entries(OF_CAMPI_CLIENTE)) {
      const row = perCampoCliente.get(chiave(nome));
      dati[k] = row ? ofValore(row) : '';
    }
    // P.iva salvata in un campo numerico (es. 164430043.00): via i decimali e zeri iniziali
    // ripristinati (la partita IVA italiana ha 11 cifre). Stessa cosa per un codice fiscale
    // numerico (società: 11 cifre).
    for (const k of ['partitaIva', 'codiceFiscale']) {
      const m = /^(\d+)(\.0+)?$/.exec(String(dati[k] || '').trim());
      if (m) dati[k] = m[1].length < 11 ? m[1].padStart(11, '0') : m[1];
    }
  }
  return { dati, invoiceCfg: invoice && String(invoice.tipo_valore) === '11' ? invoice : null };
}

// Righe della griglia Invoice del progetto (stesse regole della griglia: tenant, utente,
// progetto, righe non scadute; per le chiavi esterne la descrizione al posto dell'id).
async function ofInvoice(req, prog, cfg, aOre = false) {
  if (!cfg || !cfg.tabella) return { colonne: [], righe: [] };
  const tabella = assertValidIdentifier(String(cfg.tabella).trim());
  // Come la griglia del progetto: con gestione a ore si nascondono le colonne _gg, altrimenti le _hh.
  const nascoste = aOre ? '_gg' : '_hh';
  const colonne = parseGridColumnsSpec(cfg.colonna).columns.filter((c) => !String(c).toLowerCase().endsWith(nascoste));
  const cols = await getTableColumns(tabella);
  const usate = colonne.filter((c) => cols.has(c) && !['tenant_id', 'user_id', 'id'].includes(c));
  if (!usate.length || !cols.has('tenant_id') || !cols.has('user_id')) return { colonne: [], righe: [] };
  const fk = new Map((await db.query(
    `SELECT kcu.column_name, ccu.table_name AS ft, ccu.column_name AS fc
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`,
    [tabella]
  )).rows.map((x) => [x.column_name, x]));
  const select = [], joins = [];
  let j = 0;
  for (const c of usate) {
    const f = fk.get(c);
    if (f && c !== 'project_id' && c !== 'client_id') {
      const fcols = await getTableColumns(assertValidIdentifier(f.ft));
      const disp = [...fcols].find((n) => /^desc_/i.test(n)) || ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'label', 'valore2', 'commessa'].find((n) => fcols.has(n));
      if (disp) {
        const a = `fk${j++}`;
        joins.push(`LEFT JOIN "${f.ft}" ${a} ON ${a}."${assertValidIdentifier(f.fc)}" = s."${c}"`);
        select.push(`COALESCE(${a}."${disp}"::text, s."${c}"::text) AS "${c}"`);
        continue;
      }
    }
    select.push(`s."${c}"`);
  }
  const params = [req.user.tenant_id, req.user.user_id];
  let where = 's.tenant_id = $1 AND s.user_id = $2';
  if (cols.has('project_id')) { params.push(prog.projectId); where += ` AND s.project_id = $${params.length}`; }
  if (cols.has('scadenza')) where += ' AND (s.scadenza IS NULL OR s.scadenza >= CURRENT_DATE)';
  const ordine = ordineGriglia(tabella) || (cols.has('id') ? 's.id' : '1');
  const r = await db.query(`SELECT ${select.join(', ')} FROM "${tabella}" s ${joins.join(' ')} WHERE ${where} ORDER BY ${ordine.replace(/\bsrc\./g, 's.')}`, params);
  const etichette = etichetteColonne(tabella);
  const fmt = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return v.toLocaleDateString('it-IT');
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10).split('-').reverse().join('/');
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s).toLocaleString('it-IT', { maximumFractionDigits: 2 });
    return s;
  };
  const nomeColonna = (c) => etichette[c] || (c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' '));
  return { colonne: usate.map(nomeColonna), righe: r.rows.map((x) => usate.map((c) => fmt(etichetteValori(tabella, { ...x })[c]))) };
}

async function ofAiInfo(req) {
  const nome = await koProviderName(req, OF_CAMPI_AI);
  const cfg = AI_PROVIDERS[koNorm(nome)];
  let connessa = false;
  if (cfg) {
    const el = await getIntegration(req.user.user_id, cfg.provider);
    connessa = !!el[`${cfg.prefix}_api_key`];
  }
  return { nome, supportata: !!cfg, connessa };
}

app.get('/api/projects/offerta', requireAuth, async (req, res) => {
  try {
    const prog = await ckpProgetto(req, req.query && req.query.projectId);
    const { dati, invoiceCfg } = await ofDati(req, prog);
    res.json({ dati, invoice: await ofInvoice(req, prog, invoiceCfg, dati.aOre), ai: await ofAiInfo(req) });
  } catch (error) {
    res.status(error.statusCode || error.status || 500).json({ error: error.message });
  }
});

app.post('/api/projects/offerta/genera', requireAuth,
  express.raw({ type: 'application/octet-stream', limit: KO_MAX_TEMPLATE }),
  async (req, res) => {
    const t0 = Date.now();
    try {
      const prog = await ckpProgetto(req, req.query && req.query.projectId);
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Scegli il file Template (.docx)' });
      const ai = await ofAiInfo(req);
      if (!ai.nome) return res.status(400).json({ error: 'Scegli l\'AI in Impostazioni › AI («AI Offerta Economica» oppure «AI Slide Kick-Off»)' });
      if (!ai.supportata) return res.status(400).json({ error: `L'AI «${ai.nome}» non può generare l'offerta: scegli ChatGPT, Claude, Gemini o Mistral` });

      const template = await OffertaDocx.leggiTemplate(req.body);
      const descrizione = OffertaDocx.descriviTemplate(template);
      if (descrizione.length > KO_MAX_TESTO_AI) return res.status(413).json({ error: 'Il template contiene troppo testo per l\'AI: usa un template più corto' });

      const { dati, invoiceCfg } = await ofDati(req, prog);
      const invoice = await ofInvoice(req, prog, invoiceCfg, dati.aOre);
      const nomi = (await db.query(
        `SELECT (SELECT valore2 FROM projects WHERE id::text = $1 LIMIT 1) AS progetto,
                (SELECT valore2 FROM clients WHERE id = $2 LIMIT 1) AS cliente,
                (SELECT concat_ws(' ', name, cognome) FROM users WHERE id = $3) AS utente`,
        [prog.projectId, prog.clientId, req.user.user_id]
      )).rows[0] || {};
      const euro = (v) => (v === '' ? '(non indicato)' : `${ofNumero(v)} €`);
      const vars = {
        PROGETTO: nomi.progetto || '',
        CLIENTE: nomi.cliente || '',
        IMPORTO: euro(dati.importo),
        SCONTO: dati.sconto === '' ? '(non indicato)' : ofNumero(dati.sconto),
        IMPORTO_NON_SCONTATO: euro(dati.importoNonScontato),
        EFFORT: dati.effort === '' ? '(non indicato)' : `${ofNumero(dati.effort)} ${dati.aOre ? 'ore' : 'giorni'}`,
        PREVENTIVO: dati.preventivo || '(non indicato)',
        RAGIONE_SOCIALE: dati.ragioneSociale || '(non indicata)',
        CODICE_FISCALE: dati.codiceFiscale || '(non indicato)',
        PARTITA_IVA: dati.partitaIva || '(non indicata)',
        INVOICE: invoice.righe.length
          ? [invoice.colonne.join(' | '), ...invoice.righe.map((r) => r.join(' | '))].join('\n')
          : '(nessuna riga nella griglia Invoice)',
        DATA: new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        UTENTE: String(nomi.utente || '').trim() || req.user.email || ''
      };
      const istruzioni = (await getPromptFor('OFFERTA_ECONOMICA', req.user)).testo
        .replace(/\{\{(PROGETTO|CLIENTE|RAGIONE_SOCIALE|CODICE_FISCALE|PARTITA_IVA|IMPORTO_NON_SCONTATO|IMPORTO|SCONTO|EFFORT|PREVENTIVO|INVOICE|DATA|UTENTE)\}\}/g, (m, k) => vars[k]);
      const prompt = `${istruzioni}\n\n${OF_FORMATO}\n\nDOCUMENTO (testi attuali con i codici):\n${descrizione}`;

      // Prima stesura, applicata a una copia nuova del template (l'originale resta per la revisione).
      let risposta = await askAiProvider(req.user.user_id, ai.nome, prompt, { json: true });
      let modifiche = leggiRispostaAi(risposta.text);
      const applica = async (mods) => OffertaDocx.applicaModifiche(await OffertaDocx.leggiTemplate(req.body), mods);
      let esito = await applica(modifiche);
      if (!esito.applicate) return res.status(502).json({ error: `${risposta.label} non ha indicato modifiche applicabili al template: controlla il prompt e riprova` });

      // Revisione: istruzioni, documento originale, modifiche e bozza risultante.
      let revisione = 'non eseguita';
      const bozza = OffertaDocx.descriviTemplate(await OffertaDocx.leggiTemplate(esito.buffer));
      const promptRevisione = `${istruzioni}

SEI IL REVISORE dell'offerta economica. Un primo passaggio ha prodotto le MODIFICHE qui sotto, già applicate al DOCUMENTO ORIGINALE: il RISULTATO è il documento ottenuto. Confronta il RISULTATO con le istruzioni e con i dati del progetto.
Controlla in particolare: dati del cliente (ragione sociale, codice fiscale, partita IVA), importi, sconto, effort, preventivo e piano di fatturazione presenti e uguali ai dati (nessun importo inventato o sbagliato); nessun segnaposto o dato del template rimasto da sostituire; testi al posto giusto.

Rispondi SOLO con un oggetto JSON:
- se il RISULTATO rispetta le istruzioni: {"ok": true}
- altrimenti: {"ok": false, "problemi": ["descrizione breve di ogni problema"], "modifiche": [...]}, dove "modifiche" è l'elenco COMPLETO e corretto da applicare al DOCUMENTO ORIGINALE (non al risultato), con i codici del DOCUMENTO ORIGINALE.

${OF_FORMATO}

DOCUMENTO ORIGINALE (codici e testi):
${descrizione}

MODIFICHE DEL PRIMO PASSAGGIO:
${JSON.stringify(modifiche).slice(0, 60000)}

RISULTATO (documento dopo le modifiche; qui i codici sono rinumerati e servono solo a leggerlo):
${bozza}`;
      if (promptRevisione.length <= 3 * KO_MAX_TESTO_AI) {
        try {
          const r2 = await askAiProvider(req.user.user_id, ai.nome, promptRevisione, { json: true });
          const rev = leggiRevisioneAi(r2.text);
          if (rev.ok) revisione = 'confermata';
          else if (rev.modifiche && rev.modifiche.length) {
            const esito2 = await applica(rev.modifiche);
            if (esito2.applicate) {
              esito = esito2; modifiche = rev.modifiche; risposta = r2;
              revisione = `corretta${rev.problemi.length ? `: ${rev.problemi.join('; ')}` : ''}`;
            } else revisione = 'correzione non applicabile: tenuta la prima stesura';
          } else revisione = `problemi segnalati senza correzione: ${rev.problemi.join('; ')}`;
        } catch (e) {
          console.warn(`[OFFERTA] revisione non riuscita: ${e.message}`);
          revisione = 'non riuscita: tenuta la prima stesura';
        }
      }

      const nomeFile = `Offerta economica ${vars.PROGETTO || 'progetto'}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) + '.docx';
      console.log(`[OFFERTA] progetto ${prog.projectId}: ${esito.applicate} modifiche applicate, ${esito.ignorate} ignorate, revisione ${revisione.slice(0, 200)} (${risposta.label} ${risposta.model}, ${Math.round((Date.now() - t0) / 1000)}s)`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="offerta.docx"; filename*=UTF-8''${encodeURIComponent(nomeFile)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Kickoff-Modifiche', String(esito.applicate));
      res.setHeader('X-Kickoff-Ai', encodeURIComponent(`${risposta.label} (${risposta.model})`));
      res.setHeader('X-Kickoff-Revisione', encodeURIComponent(revisione.slice(0, 1500)));
      res.send(esito.buffer);
    } catch (error) {
      console.error('❌ OFFERTA:', error.message);
      res.status(error.statusCode || error.status || 500).json({ error: error.message });
    }
  });

// Contatori nella testata del progetto: righe non scadute (scadenza vuota o >= oggi) del
// progetto, per tenant e utente del contesto. Task = Tkt Jira (task_app), Quotazioni
// (cl_quotazioni), Meeting (rec_meeting), To Do (tasks).
const PROJ_CONTATORI = { task: 'task_app', quotazioni: 'cl_quotazioni', meeting: 'rec_meeting', todo: 'tasks' };
app.get('/api/projects/contatori', requireAuth, async (req, res) => {
  try {
    const prog = await ckpProgetto(req, req.query && req.query.projectId);
    const out = {};
    await Promise.all(Object.entries(PROJ_CONTATORI).map(async ([k, t]) => {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM "${t}"
          WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3
            AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
        [req.user.tenant_id, req.user.user_id, prog.projectId]
      );
      out[k] = r.rows[0].n;
    }));
    res.json(out);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Pulsante «Elimina» della finestra (dopo la doppia conferma nel browser): cancella tutte le
// righe della check list del progetto, anche quelle già chiuse. Se una sola riga non è
// modificabile dal ruolo del contesto non si cancella nulla. Riaprendo la Check List il
// progetto la ricrea da zero dalla configurazione.
app.delete('/api/projects/checklist', requireAuth, async (req, res) => {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const prog = await ckpProgetto(req, req.query && req.query.projectId, client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chek_list|${prog.projectId}`]);
    const ids = (await client.query(
      `SELECT id::text AS id FROM "${CKP_TABELLA}"
        WHERE tenant_id = $1 AND user_id = $2 AND client_id IS NOT DISTINCT FROM $3 AND project_id = $4`,
      [req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId]
    )).rows.map((r) => r.id);
    if (ids.length) await assertRowsWritable(req, client, CKP_TABELLA, ids);
    const x = await client.query(
      `DELETE FROM "${CKP_TABELLA}"
        WHERE tenant_id = $1 AND user_id = $2 AND client_id IS NOT DISTINCT FROM $3 AND project_id = $4`,
      [req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId]
    );
    await client.query('COMMIT');
    res.json({ eliminate: x.rowCount });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// Spunta di una voce: { projectId, check_ok, data_check? }. data_check: la data scelta
// (AAAA-MM-GG) oppure oggi se spuntata senza data; vuota se la spunta si toglie.
app.put('/api/projects/checklist/:id', requireAuth, async (req, res) => {
  try {
    const prog = await ckpProgetto(req, req.body && req.body.projectId);
    const id = String(req.params.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Voce non valida' });
    const ok = req.body && (req.body.check_ok === true || req.body.check_ok === 'true');
    const dataScelta = String((req.body && req.body.data_check) || '').trim();
    if (dataScelta && (!/^\d{4}-\d{2}-\d{2}$/.test(dataScelta) || Number.isNaN(Date.parse(dataScelta)))) {
      return res.status(400).json({ error: 'Data non valida' });
    }
    await assertRowsWritable(req, db, CKP_TABELLA, [id]);
    const conFigli = (await db.query(
      `SELECT 1 FROM "${CKP_TABELLA}" p JOIN "${CKP_TABELLA}" c
          ON c.tenant_id = p.tenant_id AND c.user_id = p.user_id AND c.project_id = p.project_id
         AND c.padre IS NOT DISTINCT FROM p.padre AND c.licenza IS NOT DISTINCT FROM p.licenza
         AND c.figlio > 0 AND (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE)
        WHERE p.id::text = $1 AND COALESCE(p.figlio, 0) = 0 AND p.tenant_id = $2 AND p.user_id = $3 LIMIT 1`,
      [id, req.user.tenant_id, req.user.user_id]
    )).rows.length > 0;
    if (conFigli) return res.status(400).json({ error: 'La fase si completa da sola quando tutte le sue attività sono fatte' });
    const r = await db.query(
      `UPDATE "${CKP_TABELLA}"
          SET check_ok = $1, data_check = CASE WHEN $1 THEN COALESCE($7::date, CURRENT_DATE) ELSE NULL END
        WHERE id::text = $2 AND tenant_id = $3 AND user_id = $4 AND client_id IS NOT DISTINCT FROM $5 AND project_id = $6
        RETURNING id, check_ok, data_check::text AS data_check`,
      [ok, id, req.user.tenant_id, req.user.user_id, prog.clientId, prog.projectId, dataScelta || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Voce non trovata' });
    await ckpRicalcolaFasi(db, req, prog);
    res.json({ ...r.rows[0], rows: await ckpRighe(req, prog) });
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

    // FK verso clients (es. rec_correzioni.client_id sotto Impostazioni): clients è EAV (una riga per ogni
    // campo del cliente), quindi le opzioni si leggono dalla vista ele_clienti, che contiene
    // solo le righe identità (client_id + description = nome del cliente) di tenant e utente.
    // I nomi sono cifrati sul DB: l'ordine alfabetico si fa DOPO la decifratura del pool.
    if (foreignTable === 'clients' && foreignColumn === 'id') {
      const result = await db.query(
        `SELECT client_id AS id, description AS display
           FROM ele_clienti
          WHERE tenant_id = $1 AND user_id = $2 AND description IS NOT NULL
          LIMIT 500`,
        [req.user.tenant_id, effectiveUserId]
      );
      const rows = stripSensitive(result.rows)
        .sort((a, b) => String(a.display || '').localeCompare(String(b.display || ''), 'it', { sensitivity: 'base' }));
      return res.json(rows);
    }

    // Rilegge le colonne della tabella referenziata per riconoscere anche modifiche
    // appena effettuate allo schema (stessa cautela usata per la griglia principale).
    tableColumnsCache.delete('main:' + foreignTable);
    const foreignColumns = await getTableColumns(foreignTable);
    const preferredNames = ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'label', 'valore2', 'commessa'];
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

    // Valori usati dal browser per compilare altre colonne alla scelta dell'opzione
    // (griglia Costi Progetto: worker_cost_id -> tariffa_gg = cost_worker, tariffa_hh = /8).
    const extraColumns = ['cost_worker'].filter((c) => foreignColumns.has(c));
    const extraSelect = extraColumns.map((c) => `, "${c}"`).join('');
    const result = await db.query(
      `SELECT "${foreignColumn}" AS id, "${displayColumn}" AS display${extraSelect}
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
  // Campi tipo 4 del progetto: valore2 riallineato dopo il salvataggio della griglia.
  if (req.params.source === 'projects') tipo4AFineRisposta(req, res, String((req.body && req.body.fieldId) || (req.query && req.query.fieldId) || '').trim());
  try {
    const source = req.params.source;
    const fieldId = ((req.body && req.body.fieldId) || '').trim();
    const values = (req.body && req.body.values) || {};

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId } = ctx;
    // Griglia con colonne tra parentesi: solo modifica delle righe esistenti.
    if (ctx.editOnly) {
      return res.status(403).json({ error: 'Griglia in sola modifica: inserimento non consentito' });
    }
    // Il cliente serve solo dove il contesto lo prevede (Clienti/Progetti) e la tabella
    // ha la colonna: una griglia sotto le Impostazioni non è legata a un cliente.
    if (tableColumns.has('client_id') && !clientId && source !== 'settings') {
      return res.status(400).json({ error: 'Contesto client_id non disponibile' });
    }

    let data = {};
    for (const [k, v] of Object.entries(values)) {
      if (tableColumns.has(k) && !generatedColumns.has(k)
          && !['id', 'tenant_id', 'user_id', 'client_id', 'project_id'].includes(k)) {
        data[k] = v === '' ? null : v;
      }
    }
    if (tableColumns.has('tenant_id')) data.tenant_id = req.user.tenant_id;
    if (tableColumns.has('user_id')) data.user_id = effectiveUserId;
    if (tableColumns.has('client_id') && clientId) data.client_id = clientId;
    const chosenClient = await gridChosenClientId(db, source, ctx, req, values);
    if (chosenClient !== undefined) data.client_id = chosenClient;
    if (tableColumns.has('project_id') && source === 'projects') data.project_id = config.argument;
    // Valori predefiniti, elenchi e colonne calcolate della tabella (gridColumnRules.js).
    await applicaRegoleScrittura(db, tableName, data, { tenantId: req.user.tenant_id, userId: effectiveUserId });
    // Nuova riga: modificabile dal ruolo di chi la crea.
    stampRoleWrite(req, data, tableColumns);

    data = await cryptoWrite(db, 'main', tableName, data);

    const columns = Object.keys(data).map(assertValidIdentifier);
    if (columns.length === 0) return res.status(400).json({ error: 'Nessun dato da inserire' });
    const paramsArr = columns.map((c) => data[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quoted = columns.map((c) => `"${c}"`).join(', ');
    const result = await db.query(
      `INSERT INTO "${tableName}" (${quoted}) VALUES (${placeholders}) RETURNING *`,
      paramsArr
    );
    // Rubrica condivisa: il nuovo contatto va anche agli altri utenti del tenant.
    if (tableName === 'rubrica') sincronizzaRubricaTenant(req.user.tenant_id);
    res.status(201).json(stripSensitive(result.rows)[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Salvataggio multiplo della griglia tipo 11. Tutte le righe modificate nel browser
// vengono validate e aggiornate nella stessa transazione; se una sola riga non appartiene
// al contesto autorizzato, l'intera operazione viene annullata.
async function validateGridProjectSelection(pool, projectId, reqUser, clientId) {
  if (projectId == null || String(projectId).trim() === '') return;
  const params = [String(projectId).trim(), reqUser.tenant_id, reqUser.user_id];
  const conditions = [
    'id::text = $1',
    'tenant_id = $2',
    'user_id = $3',
    "argument = 'Progetto'",
    "campo = 'Progetto'",
    '(scadenza IS NULL OR scadenza >= CURRENT_DATE)'
  ];
  if (clientId) {
    params.push(clientId);
    conditions.push(`client_id = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT 1 FROM projects WHERE ${conditions.join(' AND ')} LIMIT 1`,
    params
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('Il progetto selezionato non è valido per questo cliente'), { statusCode: 400 });
  }
}

// Griglie tipo 11 sotto Impostazioni: non c'è un cliente aperto, quindi client_id (se la
// tabella lo ha, es. rec_correzioni) è una normale colonna scelta dall'utente con la tendina
// clienti (fk-options -> ele_clienti). Restituisce undefined se la regola non si applica o il
// browser non ha inviato client_id, null se l'utente l'ha svuotato, altrimenti l'id, dopo
// aver verificato che sia un cliente del tenant/utente della griglia.
async function gridChosenClientId(pool, source, ctx, req, values) {
  if (source !== 'settings' || ctx.clientId || !ctx.tableColumns.has('client_id')) return undefined;
  if (!values || !Object.prototype.hasOwnProperty.call(values, 'client_id')) return undefined;
  const v = values.client_id == null ? '' : String(values.client_id).trim();
  if (!v) return null;
  const r = await pool.query(
    'SELECT 1 FROM ele_clienti WHERE client_id::text = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1',
    [v, req.user.tenant_id, ctx.effectiveUserId]
  );
  if (r.rows.length === 0) throw Object.assign(new Error('Il cliente selezionato non è valido'), { statusCode: 400 });
  return v;
}

app.put('/api/:source(settings|clients|projects)/grid-widget/rows', requireAuth, async (req, res) => {
  // Campi tipo 4 del progetto: valore2 riallineato dopo il salvataggio della griglia.
  if (req.params.source === 'projects') tipo4AFineRisposta(req, res, String((req.body && req.body.fieldId) || (req.query && req.query.fieldId) || '').trim());
  let client;
  try {
    const source = req.params.source;
    const fieldId = String((req.body && req.body.fieldId) || '').trim();
    const changes = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    const expireRowIds = [...new Set(
      (Array.isArray(req.body && req.body.expireRowIds) ? req.body.expireRowIds : [])
        .map(id => String(id || '').trim()).filter(Boolean)
    )];
    if (changes.length > 100 || expireRowIds.length > 100) {
      return res.status(400).json({ error: 'È possibile aggiornare al massimo 100 righe per volta' });
    }
    if (changes.length === 0 && expireRowIds.length === 0) {
      return res.status(400).json({ error: 'Nessuna modifica da salvare' });
    }

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId } = ctx;
    if (String(config.tipo_valore) !== '11') {
      return res.status(400).json({ error: 'Operazione disponibile solo per le griglie tipo 11' });
    }
    if (!tableColumns.has('id')) {
      return res.status(400).json({ error: `La tabella ${tableName} non contiene la colonna id` });
    }
    if (expireRowIds.length && !tableColumns.has('scadenza')) {
      return res.status(400).json({ error: `La tabella ${tableName} non contiene la colonna scadenza` });
    }

    const contextConditions = (paramsArr) => {
      const conditions = [];
      if (tableColumns.has('tenant_id')) {
        paramsArr.push(req.user.tenant_id);
        conditions.push(`tenant_id = $${paramsArr.length}`);
      }
      if (tableColumns.has('user_id')) {
        paramsArr.push(effectiveUserId);
        conditions.push(`user_id = $${paramsArr.length}`);
      }
      if (tableColumns.has('client_id') && clientId) {
        paramsArr.push(clientId);
        conditions.push(`client_id = $${paramsArr.length}`);
      }
      if (tableColumns.has('project_id') && source === 'projects') {
        paramsArr.push(config.argument);
        conditions.push(`project_id = $${paramsArr.length}`);
      }
      return conditions;
    };

    // Permesso per riga: tutte le righe modificate o da chiudere devono essere modificabili.
    await assertRowsWritable(req, db, tableName,
      [...changes.map((c) => c && c.rowId), ...expireRowIds], tableColumns);

    client = await db.connect();
    await client.query('BEGIN');
    let updated = 0;
    const seenRowIds = new Set();

    for (const change of changes) {
      const rowId = String((change && change.rowId) || '').trim();
      if (!rowId || seenRowIds.has(rowId)) {
        throw Object.assign(new Error('Identificativo riga mancante o duplicato'), { statusCode: 400 });
      }
      seenRowIds.add(rowId);
      const inputValues = change && typeof change.values === 'object' && !Array.isArray(change.values)
        ? change.values : {};
      let data = {};
      for (const [key, value] of Object.entries(inputValues)) {
        if (tableColumns.has(key) && !generatedColumns.has(key) && !ctx.lockedColumns.has(key)
            && !['id', 'tenant_id', 'user_id', 'client_id'].includes(key)) {
          data[key] = value === '' ? null : value;
        }
      }
      // project_id arriva dal value della <option> (UUID), mentre il testo mostrato
      // nel menu resta la descrizione. Prima di scriverlo verifichiamo sempre che il
      // progetto appartenga al contesto autenticato e, quando presente, al cliente.
      if (Object.prototype.hasOwnProperty.call(data, 'project_id')) {
        await validateGridProjectSelection(client, data.project_id, req.user, clientId);
      }
      const chosenClient = await gridChosenClientId(client, source, ctx, req, inputValues);
      if (chosenClient !== undefined) data.client_id = chosenClient;
      if (regoleColonne(tableName)) {
        const attuale = (await client.query(
          `SELECT * FROM "${tableName}" WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
          [rowId, req.user.tenant_id, effectiveUserId]
        )).rows[0];
        if (!attuale) throw Object.assign(new Error('Riga non trovata o non autorizzata'), { statusCode: 404 });
        await applicaRegoleScrittura(client, tableName, data, { tenantId: req.user.tenant_id, userId: effectiveUserId }, attuale);
      }
      stripRoleWrite(req, data);
      data = await cryptoWrite(client, 'main', tableName, data, rowId);
      const columns = Object.keys(data).map(assertValidIdentifier);
      if (!columns.length) continue;

      const paramsArr = columns.map(column => data[column]);
      paramsArr.push(rowId);
      const conditions = [`id::text = $${paramsArr.length}`].concat(contextConditions(paramsArr));
      const setClause = columns.map((column, index) => `"${column}" = $${index + 1}`).join(', ');
      const updatedAtClause = tableColumns.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
      const result = await client.query(
        `UPDATE "${tableName}" SET ${setClause}${updatedAtClause}
         WHERE ${conditions.join(' AND ')} RETURNING id`,
        paramsArr
      );
      if (result.rowCount !== 1) {
        throw Object.assign(new Error('Riga non trovata o non autorizzata'), { statusCode: 404 });
      }
      updated += 1;
    }

    let expired = 0;
    if (expireRowIds.length) {
      const paramsArr = [expireRowIds];
      const conditions = ['id::text = ANY($1::text[])'].concat(contextConditions(paramsArr));
      const updatedAtClause = tableColumns.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
      const result = await client.query(
        `UPDATE "${tableName}" SET scadenza = CURRENT_DATE - 1${updatedAtClause}
         WHERE ${conditions.join(' AND ')} RETURNING id`,
        paramsArr
      );
      if (result.rowCount !== expireRowIds.length) {
        throw Object.assign(new Error('Una o più righe da chiudere non sono state trovate'), { statusCode: 404 });
      }
      expired = result.rowCount;
    }

    await client.query('COMMIT');
    res.json({ updated, expired });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { /* ignore */ }
    }
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// Chiusura multipla delle righe di una griglia tipo_valore=11: imposta scadenza
// a ieri usando la data del database. Gli id ricevuti vengono sempre limitati al
// contesto autorizzato della griglia (tenant, utente, cliente e progetto).
app.put('/api/:source(settings|clients|projects)/grid-widget/expire', requireAuth, async (req, res) => {
  // Campi tipo 4 del progetto: valore2 riallineato dopo il salvataggio della griglia.
  if (req.params.source === 'projects') tipo4AFineRisposta(req, res, String((req.body && req.body.fieldId) || (req.query && req.query.fieldId) || '').trim());
  try {
    const source = req.params.source;
    const fieldId = String((req.body && req.body.fieldId) || '').trim();
    const rawRowIds = Array.isArray(req.body && req.body.rowIds) ? req.body.rowIds : [];
    const rowIds = [...new Set(rawRowIds.map(id => String(id || '').trim()).filter(Boolean))];

    if (rowIds.length === 0) return res.status(400).json({ error: 'Selezionare almeno una riga' });
    if (rowIds.length > 100) return res.status(400).json({ error: 'È possibile aggiornare al massimo 100 righe per volta' });

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, effectiveUserId, clientId } = ctx;
    if (String(config.tipo_valore) !== '11') {
      return res.status(400).json({ error: 'Operazione disponibile solo per le griglie tipo 11' });
    }
    if (!tableColumns.has('id') || !tableColumns.has('scadenza')) {
      return res.status(400).json({ error: `La tabella ${tableName} deve contenere le colonne id e scadenza` });
    }
    await assertRowsWritable(req, db, tableName, rowIds, tableColumns);

    const paramsArr = [rowIds];
    const conditions = ['id::text = ANY($1::text[])'];
    if (tableColumns.has('tenant_id')) {
      paramsArr.push(req.user.tenant_id);
      conditions.push(`tenant_id = $${paramsArr.length}`);
    }
    if (tableColumns.has('user_id')) {
      paramsArr.push(effectiveUserId);
      conditions.push(`user_id = $${paramsArr.length}`);
    }
    if (tableColumns.has('client_id') && clientId) {
      paramsArr.push(clientId);
      conditions.push(`client_id = $${paramsArr.length}`);
    }
    if (tableColumns.has('project_id') && source === 'projects') {
      paramsArr.push(config.argument);
      conditions.push(`project_id = $${paramsArr.length}`);
    }

    const updatedAtClause = tableColumns.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
    const result = await db.query(
      `UPDATE "${tableName}"
       SET scadenza = CURRENT_DATE - 1${updatedAtClause}
       WHERE ${conditions.join(' AND ')}
       RETURNING id`,
      paramsArr
    );
    res.json({ updated: result.rowCount });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Modifica una riga esistente della griglia (tipo_valore = 11), filtrando sempre per il
// contesto (tenant/utente/cliente/progetto), mai per valori inviati dal browser.
app.put('/api/:source(settings|clients|projects)/grid-widget/row', requireAuth, async (req, res) => {
  // Campi tipo 4 del progetto: valore2 riallineato dopo il salvataggio della griglia.
  if (req.params.source === 'projects') tipo4AFineRisposta(req, res, String((req.body && req.body.fieldId) || (req.query && req.query.fieldId) || '').trim());
  try {
    const source = req.params.source;
    const fieldId = ((req.body && req.body.fieldId) || '').trim();
    const rowId = ((req.body && req.body.rowId) || '').trim();
    const values = (req.body && req.body.values) || {};
    if (!rowId) return res.status(400).json({ error: 'rowId richiesto' });

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, generatedColumns, effectiveUserId, clientId } = ctx;

    let data = {};
    for (const [k, v] of Object.entries(values)) {
      // Le colonne tra parentesi sono in sola lettura: scartate come le generate,
      // anche se il browser le inviasse comunque.
      if (tableColumns.has(k) && !generatedColumns.has(k) && !ctx.lockedColumns.has(k)
          && !['id', 'tenant_id', 'user_id', 'client_id'].includes(k)) {
        data[k] = v === '' ? null : v;
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'project_id')) {
      await validateGridProjectSelection(db, data.project_id, req.user, clientId);
    }
    const chosenClient = await gridChosenClientId(db, source, ctx, req, values);
    if (chosenClient !== undefined) data.client_id = chosenClient;
    if (regoleColonne(tableName)) {
      const attuale = (await db.query(
        `SELECT * FROM "${tableName}" WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
        [rowId, req.user.tenant_id, effectiveUserId]
      )).rows[0];
      if (!attuale) return res.status(404).json({ error: 'Riga non trovata' });
      await applicaRegoleScrittura(db, tableName, data, { tenantId: req.user.tenant_id, userId: effectiveUserId }, attuale);
    }
    stripRoleWrite(req, data);
    await assertRowsWritable(req, db, tableName, [rowId], tableColumns);
    data = await cryptoWrite(db, 'main', tableName, data, rowId);

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
  // Campi tipo 4 del progetto: valore2 riallineato dopo il salvataggio della griglia.
  if (req.params.source === 'projects') tipo4AFineRisposta(req, res, String((req.body && req.body.fieldId) || (req.query && req.query.fieldId) || '').trim());
  try {
    const source = req.params.source;
    const fieldId = ((req.query && req.query.fieldId) || '').trim();
    const rowId = ((req.query && req.query.rowId) || '').trim();
    if (!rowId) return res.status(400).json({ error: 'rowId richiesto' });

    const ctx = await resolveGridWidgetContext(source, fieldId, req, true);
    const { config, tableName, tableColumns, effectiveUserId, clientId } = ctx;
    // Griglia con colonne tra parentesi: solo modifica delle righe esistenti.
    if (ctx.editOnly) {
      return res.status(403).json({ error: 'Griglia in sola modifica: eliminazione non consentita' });
    }
    await assertRowsWritable(req, db, tableName, [rowId], tableColumns);

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

// ============================================================================
// GANTT (tipo_valore = 13): la pagina gantt.html si appoggia SEMPRE alla tabella
// proj_activity. Il contesto (tenant/utente/cliente/progetto) e l'autorizzazione
// derivano dal campo tipo 13 (fieldId) esattamente come per la griglia tipo 11;
// la tabella però è fissa e non viene mai letta dal browser.
// ============================================================================
const GANTT_TABLE = 'proj_activity';
const GANTT_COLUMNS = ['argomento1', 'ordinamento1', 'argomento2', 'ordinamento2',
  'argomento3', 'ordinamento3', 'argomento4', 'ordinamento4',
  'data_inizio', 'data_fine', 'dipendenza', 'colore',
  'nr_mesi', 'nr_giorni', 'stato', 'avanzamento', 'rischio',
  'owner', 'nominativo', 'note_interne', 'mostra_cliente',
  'name_arg1', 'name_arg2', 'name_arg3', 'name_arg4'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveGanttContext(fieldId, req, needWrite) {
  const ctx = await resolveGridWidgetContext('projects', fieldId, req, needWrite);
  if (String(ctx.config.tipo_valore) !== '13') {
    throw Object.assign(new Error('Il campo non è di tipo 13 (Gantt)'), { statusCode: 400 });
  }
  if (!ctx.clientId) {
    throw Object.assign(new Error('Contesto client_id non disponibile'), { statusCode: 400 });
  }
  return {
    tenantId: req.user.tenant_id,
    userId: ctx.effectiveUserId,
    clientId: ctx.clientId,
    projectId: ctx.config.argument
  };
}

// Filtra i valori ricevuti dal browser sulle sole colonne del Gantt ('' -> NULL).
function ganttCleanValues(values) {
  const data = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (GANTT_COLUMNS.includes(k)) data[k] = (v === '' || v === undefined) ? null : v;
  }
  return data;
}

// Lettura delle attività del progetto corrente, in ordine gerarchico
// (ordinamento1..4: i NULLS FIRST fanno comparire il padre prima dei figli).
app.get('/api/projects/gantt-activity', requireAuth, async (req, res) => {
  try {
    const fieldId = String(req.query.fieldId || '').trim();
    const ctx = await resolveGanttContext(fieldId, req, false);
    const result = await db.query(
      `SELECT *
       FROM ${GANTT_TABLE}
       WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3 AND project_id = $4
       ORDER BY ordinamento1 NULLS LAST, ordinamento2 NULLS FIRST,
                ordinamento3 NULLS FIRST, ordinamento4 NULLS FIRST, created_at`,
      [ctx.tenantId, ctx.userId, ctx.clientId, ctx.projectId]
    );
    // Il Gantt si modifica come un unico albero: se anche una sola attività non è
    // modificabile dal ruolo del contesto (id_roles_write), la pagina va in sola lettura.
    const canWrite = result.rows.every((r) => !('id_roles_write' in r) || canWriteRow(req, r.id_roles_write));
    const rows = result.rows.map((r) => {
      const out = { id: r.id };
      for (const c of GANTT_COLUMNS) out[c] = r[c];
      return out;
    });
    res.json({ rows, canWrite, context: { clientId: ctx.clientId, projectId: ctx.projectId } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Salvataggio (usato sia dal salvataggio automatico sia dal pulsante Salva):
// un'unica transazione con eliminazioni, inserimenti e modifiche. Gli inserimenti
// possono usare id temporanei ("tmp-..."); le dipendenze che puntano a un id
// temporaneo vengono risolte qui e la mappa tempId -> id reale torna al browser.
app.post('/api/projects/gantt-activity/batch', requireAuth, async (req, res) => {
  try {
    const fieldId = String((req.body && req.body.fieldId) || '').trim();
    const inserts = Array.isArray(req.body?.inserts) ? req.body.inserts : [];
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const deletes = Array.isArray(req.body?.deletes) ? req.body.deletes : [];
    const ctx = await resolveGanttContext(fieldId, req, true);

    for (const id of deletes) {
      if (!UUID_RE.test(String(id))) return res.status(400).json({ error: 'Id da eliminare non valido' });
    }
    // Permesso per riga: le righe esistenti da modificare/eliminare devono essere modificabili.
    const ganttColumns = await getTableColumns(GANTT_TABLE);
    await assertRowsWritable(req, db, GANTT_TABLE,
      [...deletes, ...updates.map((u) => String(u?.id || '')).filter((x) => UUID_RE.test(x))], ganttColumns);

    const idMap = {};
    // Dipendenza verso una riga nuova: se l'id temporaneo non è ancora stato
    // inserito, la dipendenza viene applicata in un secondo passaggio.
    const pendingDeps = []; // { rowId, depTempId }
    const resolveDep = (value, ownerTempIdOrId) => {
      const v = String(value || '').trim();
      if (!v) return null;
      if (UUID_RE.test(v)) return v;
      if (idMap[v]) return idMap[v];
      pendingDeps.push({ owner: ownerTempIdOrId, depTempId: v });
      return null;
    };

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (deletes.length) {
        await client.query(
          `DELETE FROM ${GANTT_TABLE}
           WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND user_id = $3
             AND client_id = $4 AND project_id = $5`,
          [deletes, ctx.tenantId, ctx.userId, ctx.clientId, ctx.projectId]
        );
      }

      for (const ins of inserts) {
        const tempId = String(ins?.tempId || '').trim();
        let data = ganttCleanValues(ins?.values);
        if (Object.prototype.hasOwnProperty.call(data, 'dipendenza')) {
          data.dipendenza = resolveDep(data.dipendenza, tempId);
        }
        data.tenant_id = ctx.tenantId;
        data.user_id = ctx.userId;
        data.client_id = ctx.clientId;
        data.project_id = ctx.projectId;
        stampRoleWrite(req, data, ganttColumns);
        data = await cryptoWrite(client, 'main', GANTT_TABLE, data);
        const columns = Object.keys(data);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const quoted = columns.map(c => `"${assertValidIdentifier(c)}"`).join(', ');
        const result = await client.query(
          `INSERT INTO ${GANTT_TABLE} (${quoted}) VALUES (${placeholders}) RETURNING id`,
          columns.map(c => data[c])
        );
        if (tempId) idMap[tempId] = result.rows[0].id;
      }

      for (const upd of updates) {
        const rawId = String(upd?.id || '').trim();
        const rowId = UUID_RE.test(rawId) ? rawId : idMap[rawId];
        if (!rowId) {
          throw Object.assign(new Error('Id da aggiornare non valido'), { statusCode: 400 });
        }
        let data = ganttCleanValues(upd?.values);
        if (Object.prototype.hasOwnProperty.call(data, 'dipendenza')) {
          data.dipendenza = resolveDep(data.dipendenza, rowId);
        }
        stripRoleWrite(req, data);
        data = await cryptoWrite(client, 'main', GANTT_TABLE, data, rowId);
        const columns = Object.keys(data);
        if (columns.length === 0) continue;
        const setClause = columns.map((c, i) => `"${assertValidIdentifier(c)}" = $${i + 1}`).join(', ');
        const params = columns.map(c => data[c]);
        params.push(rowId, ctx.tenantId, ctx.userId, ctx.clientId, ctx.projectId);
        await client.query(
          `UPDATE ${GANTT_TABLE} SET ${setClause}, updated_at = CURRENT_TIMESTAMP
           WHERE id = $${columns.length + 1} AND tenant_id = $${columns.length + 2}
             AND user_id = $${columns.length + 3} AND client_id = $${columns.length + 4}
             AND project_id = $${columns.length + 5}`,
          params
        );
      }

      // Secondo passaggio: dipendenze che puntavano a righe inserite dopo.
      for (const dep of pendingDeps) {
        const rowId = UUID_RE.test(String(dep.owner)) ? dep.owner : idMap[dep.owner];
        const depId = idMap[dep.depTempId];
        if (!rowId || !depId) continue;
        await client.query(
          `UPDATE ${GANTT_TABLE} SET dipendenza = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3 AND user_id = $4 AND client_id = $5 AND project_id = $6`,
          [depId, rowId, ctx.tenantId, ctx.userId, ctx.clientId, ctx.projectId]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, idMap });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Elenco cliente/progetto da cui è possibile copiare (progetti dello stesso
// tenant+utente che hanno già attività in proj_activity, escluso quello corrente).
app.get('/api/projects/gantt-activity/copy-sources', requireAuth, async (req, res) => {
  try {
    const fieldId = String(req.query.fieldId || '').trim();
    const ctx = await resolveGanttContext(fieldId, req, false);
    const result = await db.query(
      `SELECT DISTINCT pa.client_id AS "clientId", pa.project_id AS "projectId",
              c.valore2 AS "clientName", p.valore2 AS "projectName"
       FROM ${GANTT_TABLE} pa
       LEFT JOIN clients c ON c.id = pa.client_id
       LEFT JOIN projects p ON p.id = pa.project_id
       WHERE pa.tenant_id = $1 AND pa.user_id = $2 AND pa.project_id <> $3
       ORDER BY "clientName" NULLS LAST, "projectName" NULLS LAST`,
      [ctx.tenantId, ctx.userId, ctx.projectId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// "Copia progetto da": copia nel progetto corrente (che deve essere vuoto) SOLO
// argomento1..4 e ordinamento1..4 del progetto sorgente (stesso tenant+utente).
app.post('/api/projects/gantt-activity/copy', requireAuth, async (req, res) => {
  try {
    const fieldId = String((req.body && req.body.fieldId) || '').trim();
    const sourceProjectId = String((req.body && req.body.sourceProjectId) || '').trim();
    if (!UUID_RE.test(sourceProjectId)) {
      return res.status(400).json({ error: 'Progetto sorgente non valido' });
    }
    const ctx = await resolveGanttContext(fieldId, req, true);
    const existing = await db.query(
      `SELECT 1 FROM ${GANTT_TABLE}
       WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3 AND project_id = $4 LIMIT 1`,
      [ctx.tenantId, ctx.userId, ctx.clientId, ctx.projectId]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Il progetto contiene già delle attività' });
    }
    const result = await db.query(
      `INSERT INTO ${GANTT_TABLE} (tenant_id, user_id, client_id, project_id,
         argomento1, ordinamento1, argomento2, ordinamento2,
         argomento3, ordinamento3, argomento4, ordinamento4)
       SELECT $1, $2, $3, $4,
         argomento1, ordinamento1, argomento2, ordinamento2,
         argomento3, ordinamento3, argomento4, ordinamento4
       FROM ${GANTT_TABLE}
       WHERE tenant_id = $1 AND user_id = $2 AND project_id = $5
       RETURNING id`,
      [ctx.tenantId, ctx.userId, ctx.clientId, ctx.projectId, sourceProjectId]
    );
    // Righe copiate: modificabili dal ruolo di chi copia.
    if (result.rows.length && (await getTableColumns(GANTT_TABLE)).has('id_roles_write')) {
      await db.query(`UPDATE ${GANTT_TABLE} SET id_roles_write = $1 WHERE id = ANY($2::uuid[])`,
        [roleWriteValue(req), result.rows.map((r) => r.id)]);
    }
    res.json({ copied: result.rows.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Estrae uno o più clientId dalla query string: supporta sia parametri ripetuti
// (?clientId=a&clientId=b) sia valore singolo con lista separata da virgole
// (?clientId=a,b). Ritorna sempre un array (vuoto = nessun filtro cliente).
function parseClientIdsFromQuery(req) {
  const raw = req.query && req.query.clientId;
  if (raw === undefined || raw === null || raw === '') return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

// KPI Fatturato: legge la vista kpi_fatturazione, filtrata SEMPRE per tenant_id e user_id
// del login; anno e client_id sono filtri opzionali (client_id assente = tutti i clienti,
// client_id può essere una lista per la selezione multipla dal filtro cliente).
app.get('/api/kpi-fatturazione', requireAuth, async (req, res) => {
  try {
    const anno = req.query.anno ? Number(req.query.anno) : null;
    const clientIds = parseClientIdsFromQuery(req);
    const conditions = ['tenant_id = $1', 'user_id = $2'];
    const params = [req.user.tenant_id, req.user.user_id];
    if (Number.isFinite(anno)) { params.push(anno); conditions.push(`anno = $${params.length}`); }
    if (clientIds.length) { params.push(clientIds); conditions.push(`client_id = ANY($${params.length})`); }
    const result = await db.query(
      `SELECT tenant_id, client_id, user_id, anno, totale, forecast, da_fatturare
       FROM kpi_fatturazione WHERE ${conditions.join(' AND ')}`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// KPI MBO: obiettivo (mbo.importo) del login (tenant+utente) per l'anno del KPI Fatturato;
// senza anno ("Tutto") somma tutti gli anni. importo null = nessun obiettivo impostato.
app.get('/api/kpi-mbo', requireAuth, async (req, res) => {
  try {
    const anno = req.query.anno ? Number(req.query.anno) : null;
    const conditions = ['tenant_id = $1', 'user_id = $2'];
    const params = [req.user.tenant_id, req.user.user_id];
    if (Number.isFinite(anno)) { params.push(anno); conditions.push(`anno = $${params.length}`); }
    const result = await db.query(
      `SELECT SUM(importo) AS importo FROM mbo WHERE ${conditions.join(' AND ')}`,
      params
    );
    const v = result.rows[0] && result.rows[0].importo;
    res.json({ importo: v == null ? null : Number(v) });
  } catch (error) {
    if (error.code === '42P01') return res.json({ importo: null }); // tabella mbo non ancora creata
    res.status(500).json({ error: error.message });
  }
});

// ===================== TEMPLATE DI CARICAMENTO =====================
// File modello scaricabili dai campi tipo 21 delle impostazioni (Caricamenti), es. "Upload
// Consuntivi". Stanno in Documentazione/Template (copiata anche sulla VM dal deploy). Solo i
// file di questo elenco: il nome non arriva mai dal browser.
const UPLOAD_TEMPLATES = {
  consuntivi: 'Consuntivi.xlsx'
};
const templatesDir = path.join(__dirname, '../Documentazione/Template');

app.get('/api/templates/:key', requireAuth, (req, res) => {
  const file = UPLOAD_TEMPLATES[String(req.params.key || '').toLowerCase()];
  if (!file) return res.status(404).json({ error: 'Template non previsto' });
  res.download(path.join(templatesDir, file), file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Template non trovato sul server' });
  });
});

// ===================== KPI GESTIONE PROGETTO =====================
// Offerta (100%) contro tempo speso (avanzamento) dei progetti in corso (righe con scadenza >= oggi),
// sempre per tenant_id e user_id del login. Tre livelli:
//   1. per cliente/progetto (filtro facoltativo sui clienti);
//   2. righe di proj_worker di un progetto (voce di costo = proj_worker_cost.desc_worker);
//   3. componenti (proj_componenti) di una voce: team_pro = worker_cost_id.
// Unità: ore se il progetto ha "Gestione a HH" = vero (campo booleano in projects, riga con
// argument = id del progetto), altrimenti giorni. bool_or: una sola risposta anche se il
// campo fosse presente più volte per lo stesso progetto.
const GP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gpHhJoin = (alias) => `LEFT JOIN LATERAL (
    SELECT COALESCE(bool_or(b.valore1), false) AS gestione_hh
      FROM projects b
     WHERE b.campo = 'Gestione a HH' AND b.argument = ${alias}.project_id::text
       AND b.tenant_id = ${alias}.tenant_id AND b.user_id = ${alias}.user_id AND b.client_id = ${alias}.client_id
       AND b.scadenza >= CURRENT_DATE
  ) hh ON true`;
const gpNum = (v) => Number(v) || 0;
// Solo progetti APERTI (riga del progetto con scadenza >= oggi) con almeno una commessa
// attiva con codice (tabella proj_commessa, più commesse per progetto dal 2026-10-06;
// prima era il campo "Cod commessa" di projects, che si chiudeva insieme al progetto).
const gpCommessaCond = (alias) => `EXISTS (
    SELECT 1 FROM projects pa
     WHERE pa.id = ${alias}.project_id
       AND pa.argument = 'Progetto' AND pa.campo = 'Progetto'
       AND pa.tenant_id = ${alias}.tenant_id AND pa.user_id = ${alias}.user_id
       AND pa.scadenza >= CURRENT_DATE
  )
  AND EXISTS (
    SELECT 1 FROM proj_commessa k
     WHERE k.project_id = ${alias}.project_id
       AND k.tenant_id = ${alias}.tenant_id AND k.user_id = ${alias}.user_id
       AND NULLIF(BTRIM(k.cod_commessa), '') IS NOT NULL
       AND (k.scadenza IS NULL OR k.scadenza >= CURRENT_DATE)
  )`;

// Progetti esclusi da Gestione Progetto e Offerte e ordini (campi di projects con argument =
// id del progetto, valori in chiaro):
//   - "Stato Progetto" (valore2) tra GP_STATI_ESCLUSI (minuscolo): per escluderne altri basta
//     aggiungerli all'elenco;
//   - "Anno" (valore3) maggiore dell'anno corrente (progetti dell'anno prossimo o successivi).
const GP_STATI_ESCLUSI = ['annullato', 'in negoziazione'];
const gpStatoEsclusoCond = (idExpr, alias) => `NOT EXISTS (
    SELECT 1 FROM projects sp
     WHERE sp.campo = 'Stato Progetto' AND sp.argument = ${idExpr}::text
       AND sp.tenant_id = ${alias}.tenant_id AND sp.user_id = ${alias}.user_id
       AND sp.scadenza >= CURRENT_DATE
       AND LOWER(BTRIM(sp.valore2)) IN (${GP_STATI_ESCLUSI.map((x) => `'${x}'`).join(', ')})
  )
  AND NOT EXISTS (
    SELECT 1 FROM projects an
     WHERE an.campo = 'Anno' AND an.argument = ${idExpr}::text
       AND an.tenant_id = ${alias}.tenant_id AND an.user_id = ${alias}.user_id
       AND an.scadenza >= CURRENT_DATE
       AND an.valore3 > EXTRACT(YEAR FROM CURRENT_DATE)
  )`;

app.get('/api/kpi-gestione-progetto', requireAuth, async (req, res) => {
  try {
    const clientIds = parseClientIdsFromQuery(req).filter((id) => GP_UUID.test(id));
    const params = [req.user.tenant_id, req.user.user_id];
    let clientCond = '';
    if (clientIds.length) { params.push(clientIds); clientCond = `AND a.client_id = ANY($3::uuid[])`; }
    const r = await db.query(
      `SELECT a.client_id, a.project_id, hh.gestione_hh AS hh, comp.completamento,
              SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END) AS offerta,
              SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END) AS time_spent,
              -- Voce di costo "Fabbrica" (proj_worker_cost.desc_worker): offerta e speso a parte,
              -- per segnalare in dashboard la Fabbrica senza tempo speso registrato.
              BOOL_OR(LOWER(BTRIM(wc.desc_worker)) = 'fabbrica') AS ha_fabbrica,
              SUM(CASE WHEN LOWER(BTRIM(wc.desc_worker)) = 'fabbrica' THEN
                    CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END
                  ELSE 0 END) AS fab_offerta,
              SUM(CASE WHEN LOWER(BTRIM(wc.desc_worker)) = 'fabbrica' THEN
                    CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END
                  ELSE 0 END) AS fab_spent,
              -- Stessa segnalazione per la voce "Project Manager".
              BOOL_OR(LOWER(BTRIM(wc.desc_worker)) = 'project manager') AS ha_pm,
              SUM(CASE WHEN LOWER(BTRIM(wc.desc_worker)) = 'project manager' THEN
                    CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END
                  ELSE 0 END) AS pm_offerta,
              SUM(CASE WHEN LOWER(BTRIM(wc.desc_worker)) = 'project manager' THEN
                    CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END
                  ELSE 0 END) AS pm_spent
         FROM proj_worker a
         LEFT JOIN proj_worker_cost wc ON wc.id = a.worker_cost_id AND wc.scadenza >= CURRENT_DATE
         ${gpHhJoin('a')}
         -- "Completamento" del progetto (projects.valore3), stesse regole di tenant/utente/scadenza
         LEFT JOIN LATERAL (
           SELECT MAX(p.valore3) AS completamento
             FROM projects p
            WHERE p.campo = 'Completamento' AND p.argument = a.project_id::text
              AND p.tenant_id = a.tenant_id AND p.user_id = a.user_id
              AND p.scadenza >= CURRENT_DATE
         ) comp ON true
        WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.scadenza >= CURRENT_DATE
          AND (a.offerta_effort_hh <> 0 OR a.offerta_effort_gg <> 0) ${clientCond}
          AND ${gpCommessaCond('a')}
          AND ${gpStatoEsclusoCond('a.project_id', 'a')}
        GROUP BY a.client_id, a.project_id, hh.gestione_hh, comp.completamento`,
      params
    );
    // Voci di costo di ogni progetto (stessi filtri), mostrate subito sotto il progetto nella
    // prima vista invece che nel drill down: una riga per progetto e voce (worker_cost_id).
    const v = await db.query(
      `SELECT a.project_id, a.worker_cost_id, MAX(wc.desc_worker) AS worker, hh.gestione_hh AS hh,
              SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END) AS offerta,
              SUM(CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END) AS time_spent
         FROM proj_worker a
         LEFT JOIN proj_worker_cost wc ON wc.id = a.worker_cost_id AND wc.scadenza >= CURRENT_DATE
         ${gpHhJoin('a')}
        WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.scadenza >= CURRENT_DATE
          AND (a.offerta_effort_hh <> 0 OR a.offerta_effort_gg <> 0) ${clientCond}
          AND ${gpCommessaCond('a')}
          AND ${gpStatoEsclusoCond('a.project_id', 'a')}
        GROUP BY a.project_id, a.worker_cost_id, hh.gestione_hh`,
      params
    );
    const vociByProject = new Map();
    v.rows.forEach((x) => {
      const k = String(x.project_id);
      if (!vociByProject.has(k)) vociByProject.set(k, []);
      vociByProject.get(k).push({
        worker_cost_id: x.worker_cost_id,
        worker: x.worker || null,
        hh: !!x.hh,
        offerta: gpNum(x.offerta),
        time_spent: gpNum(x.time_spent)
      });
    });
    vociByProject.forEach((list) => list.sort((a, b) => String(a.worker || '').localeCompare(String(b.worker || ''), 'it')));

    const clients = await resolveClientDescriptions(r.rows.map((x) => x.client_id), req.user.tenant_id);
    const projects = await resolveProjectDescriptions(r.rows.map((x) => x.project_id), req.user.tenant_id, req.user.user_id);
    const items = r.rows.map((x) => ({
      voci: vociByProject.get(String(x.project_id)) || [],
      client_id: x.client_id,
      client: clients.get(String(x.client_id)) || null,
      project_id: x.project_id,
      project: (projects.get(String(x.project_id)) || {}).name || null,
      hh: !!x.hh,
      completamento: x.completamento == null ? null : Number(x.completamento),
      offerta: gpNum(x.offerta),
      time_spent: gpNum(x.time_spent),
      fabbrica: x.ha_fabbrica ? { offerta: gpNum(x.fab_offerta), time_spent: gpNum(x.fab_spent) } : null,
      pm: x.ha_pm ? { offerta: gpNum(x.pm_offerta), time_spent: gpNum(x.pm_spent) } : null
    })).sort((a, b) => String(a.client || '').localeCompare(String(b.client || ''), 'it')
      || String(a.project || '').localeCompare(String(b.project || ''), 'it'));
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/kpi-gestione-progetto/project/:projectId', requireAuth, async (req, res) => {
  try {
    const projectId = String(req.params.projectId || '');
    if (!GP_UUID.test(projectId)) return res.status(400).json({ error: 'Progetto non valido' });
    const r = await db.query(
      `SELECT a.id, a.worker_cost_id, hh.gestione_hh AS hh,
              CASE WHEN hh.gestione_hh THEN COALESCE(a.offerta_effort_hh, 0) ELSE COALESCE(a.offerta_effort_gg, 0) END AS offerta,
              CASE WHEN hh.gestione_hh THEN COALESCE(a.time_spent_hh, 0) ELSE COALESCE(a.time_spent_gg, 0) END AS time_spent
         FROM proj_worker a
         ${gpHhJoin('a')}
        WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.project_id = $3 AND a.scadenza >= CURRENT_DATE
          AND (a.offerta_effort_hh <> 0 OR a.offerta_effort_gg <> 0)
          AND ${gpCommessaCond('a')}
          AND ${gpStatoEsclusoCond('a.project_id', 'a')}`,
      [req.user.tenant_id, req.user.user_id, projectId]
    );
    const costIds = [...new Set(r.rows.map((x) => x.worker_cost_id).filter(Boolean))];
    const names = new Map();
    if (costIds.length) {
      const w = await db.query(
        `SELECT id, desc_worker FROM proj_worker_cost WHERE id = ANY($1::uuid[]) AND scadenza >= CURRENT_DATE`,
        [costIds]
      );
      w.rows.forEach((x) => names.set(String(x.id), x.desc_worker));
    }
    const items = r.rows.map((x) => ({
      id: x.id,
      worker_cost_id: x.worker_cost_id,
      worker: names.get(String(x.worker_cost_id)) || null,
      hh: !!x.hh,
      offerta: gpNum(x.offerta),
      time_spent: gpNum(x.time_spent)
    })).sort((a, b) => String(a.worker || '').localeCompare(String(b.worker || ''), 'it'));
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/kpi-gestione-progetto/worker', requireAuth, async (req, res) => {
  try {
    const projectId = String(req.query.projectId || '');
    const workerCostId = String(req.query.workerCostId || '');
    if (!GP_UUID.test(projectId) || !GP_UUID.test(workerCostId)) return res.status(400).json({ error: 'Parametri non validi' });
    const r = await db.query(
      `SELECT c.id, c.nominativo, hh.gestione_hh AS hh,
              CASE WHEN hh.gestione_hh THEN COALESCE(c.time_spent_hh, 0) ELSE COALESCE(c.time_spent_gg, 0) END AS time_spent
         FROM proj_componenti c
         ${gpHhJoin('c')}
        WHERE c.tenant_id = $1 AND c.user_id = $2 AND c.scadenza >= CURRENT_DATE
          AND c.team_pro = $3 AND c.project_id = $4
          AND ${gpCommessaCond('c')}
          AND ${gpStatoEsclusoCond('c.project_id', 'c')}`,
      [req.user.tenant_id, req.user.user_id, workerCostId, projectId]
    );
    const items = r.rows.map((x) => ({ id: x.id, nominativo: x.nominativo, hh: !!x.hh, time_spent: gpNum(x.time_spent) }))
      .sort((a, b) => String(a.nominativo || '').localeCompare(String(b.nominativo || ''), 'it'));
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Scheda "Offerte e ordini" del KPI Gestione Progetto: per ogni progetto in corso (riga
// campo = 'Progetto' con scadenza >= oggi) le date Start / End / "Offerta inviata al Cliente" /
// "Ordine Ricevuto" (campi data di projects, valore2, argument = id del progetto), per capire
// a chi sollecitare l'ordine. Sempre per tenant_id e user_id del login; filtro clienti
// facoltativo come la scheda Avanzamento. MAX(): una sola data anche se un campo fosse doppio.
// Lo stato (da sollecitare, in attesa...) lo calcola la dashboard sulla data di oggi locale.
app.get('/api/kpi-gestione-progetto/ordini', requireAuth, async (req, res) => {
  try {
    const clientIds = parseClientIdsFromQuery(req).filter((id) => GP_UUID.test(id));
    const params = [req.user.tenant_id, req.user.user_id];
    let clientCond = '';
    if (clientIds.length) { params.push(clientIds); clientCond = 'AND a.client_id = ANY($3::uuid[])'; }
    const dataCampo = (campo) => `(SELECT MAX(x.valore2) FROM projects x
        WHERE x.campo = '${campo}' AND x.argument = a.id::text
          AND x.tenant_id = a.tenant_id AND x.user_id = a.user_id AND x.scadenza >= CURRENT_DATE)`;
    const r = await db.query(
      `SELECT a.id AS project_id, a.client_id, a.valore2 AS progetto,
              ${dataCampo('Start')} AS start,
              ${dataCampo('End')} AS "end",
              ${dataCampo('Offerta inviata al Cliente')} AS offerta_inviata,
              ${dataCampo('Ordine Ricevuto')} AS ordine_ricevuto
         FROM projects a
        WHERE a.campo = 'Progetto' AND a.tenant_id = $1 AND a.user_id = $2
          AND a.scadenza >= CURRENT_DATE ${clientCond}
          -- Esclusi i progetti con Tipologia = "Previsione": non hanno ancora offerta/ordine reali.
          AND NOT EXISTS (
            SELECT 1 FROM projects t
             WHERE t.campo = 'Tipologia' AND t.argument = a.id::text
               AND t.tenant_id = a.tenant_id AND t.user_id = a.user_id AND t.scadenza >= CURRENT_DATE
               AND LOWER(BTRIM(t.valore2)) = 'previsione'
          )
          AND ${gpStatoEsclusoCond('a.id', 'a')}`,
      params
    );
    const clients = await resolveClientDescriptions(r.rows.map((x) => x.client_id), req.user.tenant_id);
    const soloData = (v) => {
      if (v == null || String(v).trim() === '') return null;
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    };
    res.json(r.rows.map((x) => ({
      project_id: x.project_id,
      client_id: x.client_id,
      client: clients.get(String(x.client_id)) || null,
      progetto: x.progetto,
      start: soloData(x.start),
      end: soloData(x.end),
      offerta_inviata: soloData(x.offerta_inviata),
      ordine_ricevuto: soloData(x.ordine_ricevuto)
    })));
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

// ==========================================
// KPI DINAMICI DASHBOARD (configurati in kpi_tab)
// ==========================================
//
// Precedenza configurazione:
//   1. tenant + utente del login;
//   2. tenant del login + utente NULL;
//   3. tenant NULL + utente NULL.
// Si usa per intero il primo livello nel quale esiste almeno una riga. Le query
// configurate sono sempre completate server-side con tenant_id e user_id del token.

// Risolve in blocco { clientId -> descrizione } per l'elenco di client_id indicato.
async function resolveClientDescriptions(clientIds, tenantId) {
  const map = new Map();
  const ids = [...new Set(clientIds.filter((v) => v != null))];
  if (!ids.length) return map;
  const cr = await db.query(
    `SELECT id, valore2 FROM clients WHERE id = ANY($1) AND tenant_id = $2 AND argument = 'Cliente' AND campo = 'Cliente'`,
    [ids, tenantId]
  );
  for (const r of cr.rows) map.set(String(r.id), r.valore2);
  return map;
}

// Risolve in blocco il progetto effettivo. Il valore ricevuto può essere sia l'id della
// riga principale del progetto, sia l'id di una riga EAV interna (es. il campo
// "Completamento"): in questo secondo caso projects.argument contiene l'id del progetto.
async function resolveProjectDescriptions(projectIds, tenantId, userId) {
  const map = new Map();
  const ids = [...new Set(projectIds.filter((v) => v != null))];
  if (!ids.length) return map;

  const sourceRows = await db.query(
    `SELECT id, argument
     FROM projects
     WHERE id = ANY($1) AND tenant_id = $2 AND user_id = $3`,
    [ids, tenantId, userId]
  );
  const sourceById = new Map(sourceRows.rows.map((row) => [String(row.id), row]));
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const candidateIds = [...new Set(ids.flatMap((id) => {
    const source = sourceById.get(String(id));
    const candidates = [id];
    if (source && source.argument != null && uuidPattern.test(String(source.argument))) {
      candidates.push(source.argument);
    }
    return candidates;
  }))];

  const projects = await db.query(
    `SELECT id, valore2
     FROM projects
     WHERE id = ANY($1)
       AND tenant_id = $2
       AND user_id = $3
       AND argument = 'Progetto'
       AND campo = 'Progetto'`,
    [candidateIds, tenantId, userId]
  );
  const projectById = new Map(projects.rows.map((row) => [String(row.id), row]));
  for (const requestedId of ids) {
    const source = sourceById.get(String(requestedId));
    const resolved = projectById.get(String(requestedId))
      || (source && source.argument != null ? projectById.get(String(source.argument)) : null);
    if (resolved) {
      map.set(String(requestedId), { id: resolved.id, name: resolved.valore2 });
    }
  }
  return map;
}

const KPI_SQL_FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|union|intersect|except|returning|into)\b/i;

function assertSafeKpiFragment(value, field, mustStartWith = null) {
  // Le query vengono spesso copiate da e-mail o pagine web, che possono inserire
  // NBSP e altri spazi Unicode non riconosciuti dal parser SQL di PostgreSQL.
  const fragment = String(value || '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .trim();
  if (!fragment || fragment.length > 8000 || /;|--|\/\*|\*\//.test(fragment) || KPI_SQL_FORBIDDEN.test(fragment)) {
    const error = new Error(`Configurazione KPI non valida nel campo ${field}`);
    error.statusCode = 400;
    throw error;
  }
  if (mustStartWith && !new RegExp(`^${mustStartWith}\\b`, 'i').test(fragment)) {
    const error = new Error(`Il campo ${field} del KPI deve iniziare con ${mustStartWith.toUpperCase()}`);
    error.statusCode = 400;
    throw error;
  }
  return fragment;
}

function assertSafeKpiSelectList(fragment, kind) {
  if (/\bselect\b/i.test(fragment)) {
    throw Object.assign(new Error(`Il campo ${kind} del KPI non può contenere sottoquery`), { statusCode: 400 });
  }
  const identifier = '(?:[a-zA-Z_][a-zA-Z0-9_]*\\.)?[a-zA-Z_][a-zA-Z0-9_]*';
  const alias = '(?:\\s+as\\s+(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?';
  const detailPattern = new RegExp(`^${identifier}${alias}(?:\\s*,\\s*${identifier}${alias})*$`, 'i');
  const aggregatePattern = new RegExp(`^(?:count\\(\\s*(?:\\*|(?:distinct\\s+)?${identifier})\\s*\\)|(?:sum|avg|min|max)\\(\\s*${identifier}\\s*\\))${alias}$`, 'i');
  const valid = kind === 'conteggio' ? aggregatePattern.test(fragment) : detailPattern.test(fragment);
  if (!valid) {
    throw Object.assign(new Error(`Sintassi non valida nel campo ${kind} del KPI`), { statusCode: 400 });
  }
}

function getKpiBaseTable(tabella) {
  const match = String(tabella).match(/^\s*from\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/i);
  if (!match) throw Object.assign(new Error('Tabella KPI non valida'), { statusCode: 400 });
  const reserved = new Set(['where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on']);
  const table = assertValidIdentifier(match[1]);
  const alias = match[2] && !reserved.has(match[2].toLowerCase()) ? assertValidIdentifier(match[2]) : table;
  return { table, qualifier: alias };
}

function bindKpiContextPlaceholders(tabella, params, req) {
  const indexes = {};
  const bind = (name, value) => {
    if (!indexes[name]) indexes[name] = params.push(value);
    return `$${indexes[name]}`;
  };
  let sql = tabella
    .replace(/\[\s*tenant_id\s*\]/gi, () => bind('tenant_id', req.user.tenant_id))
    .replace(/\[\s*user_id\s*\]/gi, () => bind('user_id', req.user.user_id));
  if (/[\[\]]/.test(sql)) {
    throw Object.assign(new Error('Segnaposto non riconosciuto nella configurazione KPI'), { statusCode: 400 });
  }
  return {
    sql,
    hasTenantPlaceholder: Boolean(indexes.tenant_id),
    hasUserPlaceholder: Boolean(indexes.user_id)
  };
}

function appendKpiContext(tabella, qualifier, params, clientIds, hasClientId, boundContext) {
  const hasWhere = /\bwhere\b/i.test(tabella);
  const conditions = [];
  if (!boundContext.hasTenantPlaceholder) conditions.push(`${qualifier}.tenant_id = $${params.push(boundContext.tenantId)}`);
  if (!boundContext.hasUserPlaceholder) conditions.push(`${qualifier}.user_id = $${params.push(boundContext.userId)}`);
  if (clientIds.length && hasClientId) conditions.push(`${qualifier}.client_id = ANY($${params.push(clientIds)})`);
  return conditions.length ? `${tabella} ${hasWhere ? 'AND' : 'WHERE'} ${conditions.join(' AND ')}` : tabella;
}

async function getDashboardKpiRows(req, pagina = 'DASHBOARD') {
  const roleLevel = Number.isFinite(Number(req.user.id_roles)) ? Number(req.user.id_roles) : 9999;
  const result = await db.query(
    `WITH scoped AS (
       SELECT id, pagina, descrizione, conteggio, dettaglio, tabella, riga, colonna,
              -- evidenzia (Supporto/CreaDB/kpi_tab_evidenzia.sql): letta via jsonb, così se la
              -- colonna non esiste ancora vale NULL invece di far fallire tutti i KPI.
              (to_jsonb(kpi_tab) ->> 'evidenzia') AS evidenzia,
              CASE
                WHEN tenant_id = $1 AND user_id = $2 THEN 1
                WHEN tenant_id = $1 AND user_id IS NULL THEN 2
                WHEN tenant_id IS NULL AND user_id IS NULL THEN 3
                ELSE 99
              END AS scope_rank
       FROM kpi_tab
       WHERE UPPER(pagina) = UPPER($3)
         AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
         AND (id_roles IS NULL OR id_roles >= $4)
         AND ((tenant_id = $1 AND (user_id = $2 OR user_id IS NULL))
              OR (tenant_id IS NULL AND user_id IS NULL))
     )
     SELECT id, pagina, descrizione, conteggio, dettaglio, tabella, riga, colonna, evidenzia
     FROM scoped
     WHERE scope_rank = (SELECT MIN(scope_rank) FROM scoped)
     ORDER BY riga NULLS LAST, colonna NULLS LAST, id`,
    [req.user.tenant_id, req.user.user_id, pagina, roleLevel]
  );
  return result.rows;
}

function deriveKpiTitle(row) {
  const description = String(row.descrizione || '').trim();
  return description || `KPI ${Number(row.riga) || 1}.${Number(row.colonna) || 1}`;
}

async function buildKpiQuery(row, selectFragment, req, kind) {
  const selectPart = assertSafeKpiFragment(selectFragment, kind);
  assertSafeKpiSelectList(selectPart, kind);
  const fromPart = assertSafeKpiFragment(row.tabella, 'tabella', 'from');
  if (/\bselect\b/i.test(fromPart)) throw Object.assign(new Error('La configurazione KPI non può contenere sottoquery'), { statusCode: 400 });
  if (/\b(group\s+by|order\s+by|limit|offset|fetch)\b/i.test(fromPart)) {
    throw Object.assign(new Error('Ordinamento, raggruppamento e limite non vanno inseriti in kpi_tab.tabella'), { statusCode: 400 });
  }
  const { table, qualifier } = getKpiBaseTable(fromPart);
  const columns = await getTableColumns(table);
  if (!columns.has('tenant_id') || !columns.has('user_id')) {
    throw Object.assign(new Error(`La sorgente KPI ${table} deve contenere tenant_id e user_id`), { statusCode: 400 });
  }
  const params = [];
  const bound = bindKpiContextPlaceholders(fromPart, params, req);
  const scopedFrom = appendKpiContext(
    bound.sql,
    qualifier,
    params,
    parseClientIdsFromQuery(req),
    columns.has('client_id'),
    {
      ...bound,
      tenantId: req.user.tenant_id,
      userId: req.user.user_id
    }
  );
  return { sql: `SELECT ${selectPart} ${scopedFrom}`, params: [...params] };
}

// Restituisce configurazione, posizione e solo il conteggio dei KPI della pagina.
app.get('/api/dashboard/kpis', requireAuth, async (req, res) => {
  try {
    const rows = await getDashboardKpiRows(req, 'DASHBOARD');
    const kpis = await Promise.all(rows.map(async (row) => {
      const query = await buildKpiQuery(row, row.conteggio, req, 'conteggio');
      const result = await db.query(query.sql, query.params);
      const rawTotal = result.rows[0] ? Object.values(result.rows[0])[0] : 0;
      return {
        id: row.id,
        title: deriveKpiTitle(row),
        riga: Number(row.riga) || 1,
        colonna: Number(row.colonna) || 1,
        total: Number(rawTotal) || 0,
        // kpi_tab.evidenzia = true: la dashboard lo mette in allarme (bordo rosso + zoom) se total > 0
        evidenzia: ['true', 't', '1'].includes(String(row.evidenzia || '').toLowerCase())
      };
    }));
    res.json(kpis);
  } catch (error) {
    console.error('[KPI DINAMICI]', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Il dettaglio viene interrogato soltanto al click della card.
app.get('/api/dashboard/kpis/:id/detail', requireAuth, async (req, res) => {
  try {
    const rows = await getDashboardKpiRows(req, 'DASHBOARD');
    const row = rows.find((item) => String(item.id) === String(req.params.id));
    if (!row) return res.status(404).json({ error: 'KPI non trovato nel contesto corrente' });

    const query = await buildKpiQuery(row, row.dettaglio, req, 'dettaglio');
    const result = await db.query(query.sql, query.params);
    const cleanRows = stripSensitive(result.rows);
    let clientMap = new Map();
    let projectMap = new Map();
    try { clientMap = await resolveClientDescriptions(cleanRows.map((item) => item.client_id), req.user.tenant_id); }
    catch (error) { console.error('[KPI DINAMICI] decodifica clienti:', error.message); }
    try {
      projectMap = await resolveProjectDescriptions(
        cleanRows.map((item) => item.project_id),
        req.user.tenant_id,
        req.user.user_id
      );
    }
    catch (error) { console.error('[KPI DINAMICI] decodifica progetti:', error.message); }

    const items = cleanRows.map((item) => {
      const resolvedProject = item.project_id == null ? null : projectMap.get(String(item.project_id));
      return {
        ...item,
        client: item.client_id == null ? null : (clientMap.get(String(item.client_id)) || null),
        project_id: resolvedProject ? resolvedProject.id : item.project_id,
        project: resolvedProject ? resolvedProject.name : null
      };
    });
    res.json({ id: row.id, title: deriveKpiTitle(row), items });
  } catch (error) {
    console.error('[KPI DINAMICI DETTAGLIO]', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
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
      } else if (tableName === 'users') {
        // "users" non ha tenant_id: solo gli utenti del tenant del login
        params.push(req.user.tenant_id);
        conditions.push(`src.id IN (SELECT user_id FROM user_tenants WHERE tenant_id = $${params.length})`);
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
  // Nuovo campo in un progetto: campi tipo 4 del progetto riallineati (valore2).
  if (req.params.table === 'projects') tipo4AFineRisposta(req, res, String((req.body && req.body.argument) || '').trim());
  try {
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);
    assertCanWriteTable(req, tableName, dbKey);
    let data = { ...req.body };
    // Ambito scelto dall'admin al salvataggio (this-tenant | all-tenants); non è una
    // colonna della tabella, va rimosso prima dell'INSERT.
    const scope = data.__scope;
    delete data.__scope;
    // Editor tabelle (pagina Database, riservata agli admin): salva esattamente i valori
    // del form, senza imporre le chiavi di contesto del login. Ignorato per i non admin.
    const rawColumns = isRawColumnsRequest(req, data);
    delete data.__rawColumns;

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
    if (!rawColumns) {
      if (tableColumns.has('tenant_id')) data.tenant_id = req.user.tenant_id;
      if (tableColumns.has('user_id')) data.user_id = req.user.user_id;
      // Nuova riga: modificabile dal ruolo di chi la crea.
      stampRoleWrite(req, data, tableColumns);
    }

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

    if (rawColumns) {
      // Editor tabelle: nessuna normalizzazione EAV di clients/projects. Le colonne
      // inesistenti vengono comunque scartate dal filtro sulle colonne reali.
      data = Object.fromEntries(Object.entries(data).filter(([c]) => tableColumns.has(c)));
    } else if (tableName === 'clients') {
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

    // Nuovo campo da non admin: vietato nelle impostazioni; in clienti/progetti è custom,
    // nella fascia di ordinamento >= 200 e con id_roles = ruolo di chi lo crea.
    if (FIELD_SOURCES.has(tableName) && !rawColumns && !isAdminUser(req) && dbKey === 'main') {
      assertStructureSourceAllowed(req, tableName);
      if (tableColumns.has('id_roles')) data.id_roles = roleWriteValue(req);
      if (tableColumns.has('ordinamento') && !(Number(data.ordinamento) >= CUSTOM_ORD_BASE)) {
        const m = await pool.query(
          `SELECT MAX(ordinamento) AS m FROM "${tableName}" WHERE argument = $1 AND tenant_id = $2 AND ordinamento >= $3`,
          [data.argument || null, req.user.tenant_id, CUSTOM_ORD_BASE]
        );
        data.ordinamento = m.rows[0].m != null ? Number(m.rows[0].m) + 1 : CUSTOM_ORD_BASE;
      }
    }

    // Configurazione del campo (tipo, tabella, colonna, VariabDB) secondo il ruolo
    await assertFieldConfigAllowed(req, tableName, data, null);

    // Le colonne generate non sono scrivibili: rimuovile dai dati in ingresso.
    const generatedColumns = await getGeneratedColumns(tableName, pool, dbKey);
    for (const g of generatedColumns) delete data[g];

    // Cifratura a riposo (dopo le normalizzazioni, prima di comporre la INSERT).
    data = await cryptoWrite(pool, dbKey, tableName, data);

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
  // Campo di un progetto salvato: campi tipo 4 del progetto riallineati (valore2).
  if (req.params.table === 'projects') tipo4AFineRisposta(req, res, req.params.id);
  try {
    const pool = pickDb(req), dbKey = pickDbKey(req);
    const tableName = assertValidIdentifier(req.params.table);
    assertCanWriteTable(req, tableName, dbKey);
    const id = req.params.id;
    let data = { ...req.body };
    // Ambito scelto dall'admin al salvataggio; non è una colonna della tabella.
    const scope = data.__scope;
    const tenantScope = data.__tenantScope || 'this-tenant';
    delete data.__scope;
    delete data.__tenantScope;
    // Editor tabelle (pagina Database, riservata agli admin): aggiorna esattamente le
    // colonne del form, comprese tenant_id/user_id/client_id. Ignorato per i non admin.
    const rawColumns = isRawColumnsRequest(req, data);
    delete data.__rawColumns;

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

    // Struttura del campo (nome, tipo, ordinamento, ...): per i non admin nessuna modifica
    // nelle impostazioni e, in clienti/progetti, solo sui campi custom nella fascia >= 200.
    // Le colonne di struttura invariate vengono tolte da data.
    if (!rawColumns && dbKey === 'main') await assertStructureUpdateAllowed(req, pool, tableName, id, data);

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
      const original = await pool.query(`SELECT id, argument, campo, tipo_valore, valore1, valore2, tenant_id, user_id, tabella, colonna, "VariabDB" FROM "${tableName}" WHERE ${where.join(' AND ')} LIMIT 1`, params);
      originalFieldRow = original.rows[0] || null;
      if (originalFieldRow && ['clients', 'projects'].includes(tableName) && originalFieldRow.argument) {
        const container = await pool.query(`SELECT campo, valore2 FROM "${tableName}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [originalFieldRow.argument, originalFieldRow.tenant_id]);
        originalFieldRow.containerCampo = container.rows[0]?.campo || null;
        originalFieldRow.containerValue = container.rows[0]?.valore2 ?? null;
      }
    }

    if (!rawColumns) {
      delete data.tenant_id;
      delete data.user_id;
      delete data.client_id;
    }
    // Permesso per riga: la riga deve essere modificabile dal ruolo del contesto, e solo
    // l'admin può cambiare id_roles_write.
    stripRoleWrite(req, data);
    await assertRowsWritable(req, pool, tableName, [id], tableColumns);

    // Configurazione del campo: si controllano solo i valori cambiati rispetto alla riga.
    // Per il confronto basta la riga del tenant (es. cliente condiviso da un collega).
    if (FIELD_SOURCES.has(tableName) && !admin) {
      let cfgOriginal = originalFieldRow;
      if (!cfgOriginal) {
        const o = await pool.query(
          `SELECT tipo_valore, tabella, colonna, "VariabDB" FROM "${tableName}" WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [id, req.user.tenant_id]
        );
        cfgOriginal = o.rows[0] || null;
      }
      await assertFieldConfigAllowed(req, tableName, data, cfgOriginal);
    }

    // Difesa ulteriore: accetta soltanto colonne realmente presenti nella tabella.
    // Così eventuali campi aggiunti dal frontend non possono diventare identificatori
    // SQL e provocare errori come "column client_id of relation clients does not exist".
    data = Object.fromEntries(
      Object.entries(data).filter(([column]) => tableColumns.has(column))
    );

    // tipo_valore=14: valore2 è valido soltanto quando il booleano valore1 è true.
    // La regola è applicata anche lato server per evitare valori residui nel database
    // in caso di chiamate API dirette o salvataggi parziali dal browser.
    if (originalFieldRow && String(originalFieldRow.tipo_valore) === '14') {
      const effectiveBoolean = Object.prototype.hasOwnProperty.call(data, 'valore1')
        ? data.valore1
        : originalFieldRow.valore1;
      const isEnabled = effectiveBoolean === true
        || effectiveBoolean === 'true'
        || effectiveBoolean === 't'
        || effectiveBoolean === 1
        || effectiveBoolean === '1';
      if (!isEnabled && tableColumns.has('valore2')) data.valore2 = null;
    }

    // Isolamento clienti (ACL): un non-admin può modificare una riga di "clients" solo se
    // proprietario del cliente o con condivisione in scrittura. Enforce del permesso 'read'.
    if (tableName === 'clients' && !admin && dbKey === 'main') {
      const acc = await clientAccessByArgument(id, req, true);
      if (!acc) return res.status(403).json({ error: 'Non autorizzato a modificare questo cliente' });
    }

    // Le colonne generate non sono scrivibili: rimuovile dai dati in ingresso.
    const generatedColumns = await getGeneratedColumns(tableName, pool, dbKey);
    for (const g of generatedColumns) delete data[g];

    // Cifratura a riposo: il flag crypto viene letto dalla riga che si sta aggiornando.
    data = await cryptoWrite(pool, dbKey, tableName, data, id);

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
    // - Settings: 'all-tenants' resta riservato all'admin e propaga a tutti i tenant,
    //   'this-tenant' limita al tenant corrente. L'ambito arriva in due dialetti
    //   equivalenti (__scope, usato dai popup settings, oppure __tenantScope).
    const settingsAllTenants = tableName === 'settings' && admin
      && (scope === 'all-tenants' || tenantScope === 'all-tenants');
    const shouldPropagateField = ['clients', 'projects'].includes(tableName)
      ? (scope === 'all' || tenantScope === 'all-tenants')
      : settingsAllTenants;
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
          const allTenants = settingsAllTenants || (tenantScope === 'all-tenants' && admin);
          if (allTenants && ['clients', 'projects'].includes(tableName)) {
            // Per all-tenants il contenitore viene individuato logicamente tramite
            // la riga identità (campo Cliente/Progetto + valore2), non tramite UUID.
            if (scope === 'this' && originalFieldRow.containerValue != null) {
              pParams.push(originalFieldRow.containerCampo || (tableName === 'projects' ? 'Progetto' : 'Cliente'));
              where += ` AND argument IN (SELECT id::text FROM "${tableName}" roots WHERE roots.campo = $${pParams.length} AND roots.valore2 = $${pParams.length + 1})`;
              pParams.push(originalFieldRow.containerValue);
            }
            // scope='all' non aggiunge filtro tenant/user: tutti i tenant.
          } else if (allTenants) {
            // Impostazioni su tutti i tenant: nessun filtro tenant/utente. La riga
            // resta individuata da campo + argument (il filtro argument è aggiunto
            // subito sotto), quindi la modifica raggiunge lo stesso campo in ogni tenant.
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
          // La propagazione tocca solo le righe modificabili dal ruolo del contesto.
          where += roleWriteSql(req, pParams, '', tableColumns, tableName);
          await pool.query(`UPDATE "${tableName}" SET ${setClause} WHERE ${where}`, pParams);
        }
      } catch (e) {
        // La propagazione non deve far fallire il salvataggio principale, ma un errore
        // silenzioso rendeva indistinguibile "applicato a tutti" da "applicato solo qui".
        console.error('[propagazione campo]', tableName, e.message);
      }
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
    assertCanWriteTable(req, tableName, dbKey);
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
    await assertRowsWritable(req, pool, tableName, [id], tableColumns);
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
    assertCanWriteTable(req, tableName, dbKey);

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

          // Permesso per riga (non admin): una riga esistente deve essere modificabile; una
          // riga nuova prende il ruolo di chi importa. id_roles_write non è importabile.
          if (!admin && tableColumns.has('id_roles_write')) {
            const existing = hasId
              ? (await client.query(`SELECT id_roles_write FROM "${tableName}" WHERE id::text = $1 LIMIT 1`, [String(data.id)])).rows[0]
              : null;
            if (existing && !canWriteRow(req, existing.id_roles_write, tableName)) {
              errors.push({ row: i + 1, error: READ_ONLY_ERROR });
              continue;
            }
            if (existing) delete data.id_roles_write;
            else data.id_roles_write = roleWriteValue(req);
          }

          // Configurazione dei campi settings/clients/projects secondo il ruolo (non admin):
          // confronto con la riga esistente del tenant, se l'id c'è già.
          if (FIELD_SOURCES.has(tableName) && !admin) {
            const o = hasId
              ? (await client.query(
                  `SELECT tipo_valore, tabella, colonna, "VariabDB" FROM "${tableName}" WHERE id::text = $1 AND tenant_id = $2 LIMIT 1`,
                  [String(data.id), req.user.tenant_id]
                )).rows[0] || null
              : null;
            await assertFieldConfigAllowed(req, tableName, data, o);
          }

          // Cifratura a riposo, coerente con quanto scrive il resto dell'applicazione.
          data = await cryptoWrite(client, dbKey, tableName, data, hasId ? data.id : null);

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
  let dbKey;
  try { dbKey = pickDbKey(req); } catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
  const userKey = (req.user.user_id || req.user.email) + ':' + dbKey;
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
  let dbKey;
  try { dbKey = pickDbKey(req); } catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
  const userKey = (req.user.user_id || req.user.email) + ':' + dbKey;
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

// ==========================================================================
// QLIK VOUCHER — importazione ore attività da file Excel (voce sidebar "Qlik",
// gestita dal frontend in js/Qlik_voucher.js).
//
// Il file Excel viene letto ed elaborato interamente nel browser: qui arriva
// solo il riepilogo già raggruppato per (Codice Commessa, Email Dipendente),
// con il totale ore di ciascun gruppo. L'endpoint:
//  1) risolve ogni Codice Commessa (+ Titolo Commessa) nella COMMESSA corrispondente
//     (proj_commessa: commessa_id + project_id; più commesse per progetto dal
//     2026-10-06), leggendo TUTTO il tenant del login. Se proj_commessa non esiste
//     si usa la vecchia ele_commesse (una commessa per progetto, commessa_id vuoto);
//  2) per ciascun gruppo risolto, aggiorna la riga di proj_componenti con la
//     stessa email, lo stesso project_id e la stessa commessa_id:
//       time_spent_hh = totale ore del gruppo (sovrascrive il valore precedente)
//       time_spent_gg = time_spent_hh / 8
//     Una riga della persona sul progetto ancora senza commessa viene assegnata alla
//     commessa (niente doppioni); altrimenti si inserisce una riga nuova con commessa_id;
//  3) ricalcola time_spent di proj_worker: per le righe con commessa_id la somma dei
//     componenti di quella commessa, per quelle senza commessa la somma del progetto.
// Tutto in un'unica transazione: se il salvataggio di una riga fallisce per un
// errore imprevisto, nessuna modifica del blocco viene applicata.
//
// PERIMETRO: l'import vale per l'intero TENANT. Qualunque utente carichi il file,
// aggiorna le commesse e i componenti di tutti gli utenti del tenant. Le righe
// nuove sono intestate al PROPRIETARIO del progetto (projects.user_id), perché la
// griglia del progetto mostra solo le righe del suo proprietario.
// ==========================================================================
app.post('/api/qlik-voucher/import', requireAuth, async (req, res) => {
  try {
    const groupsIn = Array.isArray(req.body?.groups) ? req.body.groups : [];
    const scope = req.body?.scope === 'history' ? 'history' : 'active';
    if (groupsIn.length === 0) {
      return res.status(400).json({ error: 'Nessun dato da importare' });
    }
    if (groupsIn.length > 5000) {
      return res.status(400).json({ error: 'Troppi gruppi in una sola richiesta (massimo 5000): suddividere l\'invio' });
    }

    // Normalizza e valida ogni gruppo ricevuto dal browser.
    const groups = [];
    for (const g of groupsIn) {
      const cod = String((g && g.codiceCommessa) || '').trim();
      const titolo = String((g && g.titoloCommessa) || '').trim();
      const email = String((g && g.email) || '').trim().toLowerCase();
      const nominativo = String((g && g.nominativo) || '').trim();
      const codiceArticolo = String((g && g.codiceArticolo) || '').trim();
      const ore = Number(g && g.oreTotali);
      if (!cod || !titolo || !email || !Number.isFinite(ore)) continue;
      groups.push({ cod, titolo, email, nominativo, codiceArticolo, ore });
    }
    if (groups.length === 0) {
      return res.status(400).json({ error: 'Nessuna riga valida da importare (Codice Commessa / Titolo Commessa / Email / Ore mancanti)' });
    }

    // Verifica la struttura minima delle due tabelle coinvolte, con un errore
    // esplicito se non sono ancora predisposte come richiesto.
    // Dal 2026-10-06 le commesse stanno in proj_commessa (più commesse per progetto,
    // Supporto/CreaDB/proj_commessa.sql): il codice Qlik individua la COMMESSA, non solo il
    // progetto, e proj_componenti / proj_worker ricevono commessa_id. Se proj_commessa non
    // esiste ancora (DB non migrato) si usa la vecchia ele_commesse, una commessa per progetto.
    let commesseCols, componentiCols, projCommessaCols;
    try {
      projCommessaCols = await getTableColumns('proj_commessa');
      commesseCols = projCommessaCols.size ? projCommessaCols : await getTableColumns('ele_commesse');
      componentiCols = await getTableColumns('proj_componenti');
    } catch (schemaErr) {
      console.error('[QLIK VOUCHER IMPORT] lettura schema fallita', schemaErr);
      return res.status(500).json({ error: 'Impossibile leggere la struttura di proj_commessa/ele_commesse/proj_componenti: ' + schemaErr.message });
    }
    const useProjCommessa = projCommessaCols.size > 0;
    const tabellaCommesse = useProjCommessa ? 'proj_commessa' : 'ele_commesse';
    if (commesseCols.size === 0) {
      return res.status(400).json({ error: 'Tabella proj_commessa (o ele_commesse) non trovata' });
    }
    if (!['tenant_id', 'user_id', 'cod_commessa', 'project_id'].every((c) => commesseCols.has(c))) {
      return res.status(400).json({ error: `La tabella ${tabellaCommesse} deve contenere tenant_id, user_id, cod_commessa e project_id` });
    }
    // commessa_id su proj_componenti: le ore si tengono per progetto + commessa + persona.
    const componentiHasCommessa = useProjCommessa && componentiCols.has('commessa_id');
    if (componentiCols.size === 0) {
      return res.status(400).json({ error: 'Tabella proj_componenti non trovata' });
    }
    if (!['tenant_id', 'user_id', 'client_id', 'email', 'nominativo', 'project_id', 'time_spent_hh', 'time_spent_gg'].every((c) => componentiCols.has(c))) {
      return res.status(400).json({ error: 'La tabella proj_componenti deve contenere tenant_id, user_id, client_id, project_id, email, nominativo, time_spent_hh e time_spent_gg' });
    }
    const hasUpdatedAt = componentiCols.has('updated_at');

    // 1) Risolve tutti i codici commessa coinvolti in un'unica query.
    const codes = [...new Set(groups.map((g) => g.cod))];
    // Ambito richiesto dall'utente:
    // - active: considera esclusivamente i progetti la cui riga identita ha
    //   scadenza esattamente al 31/12/2099;
    // - history: nessun filtro sulla scadenza del progetto.
    // Il controllo e' lato server per evitare che un payload alterato possa
    // aggiornare involontariamente lo storico.
    // Con proj_commessa, in "active" anche la commessa deve essere ancora valida.
    const activeProjectFilter = scope === 'active'
      ? ` AND p.scadenza = DATE '2099-12-31'${useProjCommessa && commesseCols.has('scadenza') ? ' AND (ec.scadenza IS NULL OR ec.scadenza >= CURRENT_DATE)' : ''}`
      : '';
    // Titolo con cui confrontare il "Titolo Commessa" del file: proj_commessa.commessa,
    // in mancanza il nome del progetto (come prima).
    const commessaTitleExpression = useProjCommessa
      ? 'COALESCE(NULLIF(BTRIM(ec.commessa), \'\'), p.valore2)'
      : (commesseCols.has('titolo_commessa') ? 'COALESCE(ec.titolo_commessa, p.valore2)' : 'p.valore2');
    const commesseResult = await db.query(
      `SELECT ec.cod_commessa, ec.project_id, p.client_id, p.user_id AS owner_user_id,
              ${useProjCommessa ? 'ec.id' : 'NULL::uuid'} AS commessa_id,
              ${commessaTitleExpression} AS titolo_commessa
       FROM ${tabellaCommesse} ec
       JOIN projects p
         ON p.id::text = ec.project_id::text
        AND p.tenant_id = ec.tenant_id
        AND p.user_id = ec.user_id
        AND p.argument = 'Progetto'
        AND p.campo = 'Progetto'
       WHERE ec.tenant_id = $1
         AND ec.cod_commessa = ANY($2::text[])${activeProjectFilter}`,
      [req.user.tenant_id, codes]
    );
    const normalizeCommessaTitle = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('it-IT')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    const projectKey = (cod, titolo) => String(cod).trim() + '\u0001'
      + normalizeCommessaTitle(titolo);
    // Ogni corrispondenza è una coppia progetto + commessa (commessaId null con ele_commesse).
    const projectsByCommessa = new Map();
    const projectsByCode = new Map();
    const sameMatch = (a, row) => String(a.projectId) === String(row.project_id)
      && String(a.commessaId || '') === String(row.commessa_id || '');
    for (const row of commesseResult.rows) {
      const match = {
        projectId: row.project_id,
        commessaId: row.commessa_id || null,
        clientId: row.client_id,
        ownerUserId: row.owner_user_id,
        titolo: row.titolo_commessa
      };
      const key = projectKey(row.cod_commessa, row.titolo_commessa);
      const matches = projectsByCommessa.get(key) || [];
      if (!matches.some((m) => sameMatch(m, row))) matches.push(match);
      projectsByCommessa.set(key, matches);

      const codeKey = String(row.cod_commessa).trim();
      const codeMatches = projectsByCode.get(codeKey) || [];
      if (!codeMatches.some((m) => sameMatch(m, row))) codeMatches.push(match);
      projectsByCode.set(codeKey, codeMatches);
    }

    function resolveCommessaProjects(cod, titolo) {
      const exactMatches = projectsByCommessa.get(projectKey(cod, titolo)) || [];
      if (exactMatches.length > 0) return exactMatches;

      const codeMatches = projectsByCode.get(String(cod).trim()) || [];
      if (codeMatches.length <= 1) return codeMatches;

      // Se nello storico lo stesso codice compare su più progetti, prova un
      // confronto tollerante del titolo (maiuscole, accenti, trattini e spazi).
      const wantedTitle = normalizeCommessaTitle(titolo);
      const fuzzyMatches = codeMatches.filter((project) => {
        const storedTitle = normalizeCommessaTitle(project.titolo);
        return storedTitle && wantedTitle
          && (storedTitle.includes(wantedTitle) || wantedTitle.includes(storedTitle));
      });
      return fuzzyMatches;
    }

    // 1b) Risolve l'id di proj_componenti per (project_id, email) leggendo le righe
    // (così passano dal pool che decifra in lettura) e confrontando l'email in
    // JavaScript, MAI in una WHERE SQL: se la colonna è cifrata a riposo, un confronto
    // diretto in SQL tra il valore in chiaro del file e il ciphertext in colonna non
    // potrà mai corrispondere. L'aggiornamento successivo avviene sempre per id.
    const projectIds = [...new Set(
      [...projectsByCommessa.values()].flatMap((matches) => matches)
        .map((p) => p.projectId).filter(Boolean).map(String)
    )];
    // Chiave: "projectId\u0001commessaId\u0001email" -> id (commessaId vuoto = riga senza
    // commessa, cioè precedente a proj_commessa o con ele_commesse).
    const componentKeyOf = (projectId, commessaId, email) =>
      String(projectId) + '\u0001' + String(commessaId || '') + '\u0001' + String(email || '').trim().toLowerCase();
    const componentIdByKey = new Map();
    // Proprietario di ogni progetto: fra righe doppie (stesso progetto ed email,
    // utenti diversi) vince quella del proprietario, l'unica visibile in griglia.
    const ownerByProject = new Map(
      [...projectsByCode.values()].flatMap((matches) => matches)
        .map((p) => [String(p.projectId), String(p.ownerUserId || '')])
    );
    if (projectIds.length) {
      const componentiResult = await db.query(
        `SELECT id, project_id, email, user_id${componentiHasCommessa ? ', commessa_id' : ''} FROM proj_componenti
         WHERE tenant_id = $1 AND project_id::text = ANY($2::text[])`,
        [req.user.tenant_id, projectIds]
      );
      for (const row of componentiResult.rows) {
        const key = componentKeyOf(row.project_id, componentiHasCommessa ? row.commessa_id : null, row.email);
        const isOwner = String(row.user_id) === ownerByProject.get(String(row.project_id));
        if (!componentIdByKey.has(key) || isOwner) componentIdByKey.set(key, row.id);
      }
    }

    // Risolve Codice Articolo -> UUID proj_worker_cost.id nel contesto del
    // cliente del progetto. Se una corrispondenza non esiste, il team_pro della
    // nuova riga restera' NULL.
    // Chiavi: "userId\u0001clientId\u0001codBilling" (costo del proprietario del progetto,
    // preferito) e "clientId\u0001codBilling" (qualunque utente del tenant).
    const workerCostIdByKey = new Map();
    if (componentiCols.has('team_pro')) {
      const workerCostCols = await getTableColumns('proj_worker_cost');
      const requiredWorkerCostCols = ['id', 'tenant_id', 'user_id', 'client_id', 'cod_billing'];
      if (requiredWorkerCostCols.every((column) => workerCostCols.has(column))) {
        const clientIds = [...new Set(
          [...projectsByCode.values()].flatMap((matches) => matches)
            .map((project) => project.clientId).filter(Boolean).map(String)
        )];
        const billingCodes = [...new Set(groups.map((group) => group.codiceArticolo).filter(Boolean))];
        if (clientIds.length > 0 && billingCodes.length > 0) {
          const workerCostsResult = await db.query(
            `SELECT id, user_id, client_id, cod_billing
             FROM proj_worker_cost
             WHERE tenant_id = $1
               AND client_id::text = ANY($2::text[])
               AND BTRIM(cod_billing::text) = ANY($3::text[])`,
            [req.user.tenant_id, clientIds, billingCodes]
          );
          for (const row of workerCostsResult.rows) {
            const key = String(row.client_id) + '\u0001' + String(row.cod_billing || '').trim();
            if (!workerCostIdByKey.has(key)) workerCostIdByKey.set(key, row.id);
            workerCostIdByKey.set(String(row.user_id) + '\u0001' + key, row.id);
          }
        }
      } else {
        console.error('[QLIK VOUCHER IMPORT] Struttura proj_worker_cost non compatibile: team_pro lasciato vuoto sulle nuove righe');
      }
    }

    // 2) Aggiorna, per ciascun gruppo risolto, la riga proj_componenti corrispondente
    // (per id, mai per email in WHERE: vedi nota sulla cifratura sopra).
    let updated = 0;
    let unchanged = 0;
    let inserted = 0;
    let workerUpdated = 0;
    const notFoundCommessa = [];
    const notFoundComponente = [];
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const g of groups) {
        const projects = resolveCommessaProjects(g.cod, g.titolo);
        if (projects.length === 0) {
          notFoundCommessa.push(`${g.cod} — ${g.titolo}`);
          continue;
        }
        for (const project of projects) {
          const projectId = project.projectId;
          const commessaId = componentiHasCommessa ? project.commessaId : null;
          const componentKey = componentKeyOf(projectId, commessaId, g.email);
          let componentId = componentIdByKey.get(componentKey);
          // Riga della stessa persona sullo stesso progetto ma ancora senza commessa
          // (precedente a proj_commessa): la si assegna a questa commessa invece di
          // crearne un doppione. Una volta assegnata non vale più per altre commesse.
          let assegnaCommessa = false;
          if (!componentId && commessaId) {
            const legacyKey = componentKeyOf(projectId, null, g.email);
            componentId = componentIdByKey.get(legacyKey);
            if (componentId) {
              componentIdByKey.delete(legacyKey);
              componentIdByKey.set(componentKey, componentId);
              assegnaCommessa = true;
            }
          }
          if (!componentId) {
            const newComponentData = {
              tenant_id: req.user.tenant_id,
              // Intestata al proprietario del progetto: è lui che la vede in griglia.
              user_id: project.ownerUserId || req.user.user_id,
              client_id: project.clientId,
              project_id: projectId,
              email: g.email,
              // proj_componenti.nominativo e' NOT NULL: se il file non riporta
              // "Nome Dipendente" per quel gruppo si usa l'email come fallback,
              // altrimenti l'INSERT fallisce (violazione NOT NULL) e l'intera
              // transazione va in rollback, annullando anche gli aggiornamenti
              // delle righe gia' esistenti nello stesso blocco.
              nominativo: g.nominativo || g.email,
              time_spent_hh: g.ore,
              time_spent_gg: g.ore / 8
            };
            if (commessaId) newComponentData.commessa_id = commessaId;
            if (componentiCols.has('team_pro')) {
              const workerCostKey = String(project.clientId) + '\u0001' + g.codiceArticolo;
              const workerCostId = workerCostIdByKey.get(String(project.ownerUserId) + '\u0001' + workerCostKey)
                || workerCostIdByKey.get(workerCostKey);
              // Non valorizzare esplicitamente team_pro con NULL quando non è stata
              // trovata una corrispondenza: in questo modo eventuali DEFAULT/trigger
              // della tabella possono valorizzare il campo e l'INSERT non viene
              // bloccato inutilmente da un NULL esplicito.
              if (workerCostId) newComponentData.team_pro = workerCostId;
            }
            // Le nuove righe Qlik restano attive e visibili nella griglia.
            if (componentiCols.has('scadenza')) {
              newComponentData.scadenza = '2099-12-31';
            }
            stampRoleWrite(req, newComponentData, componentiCols); // modificabile dal ruolo di chi importa
            const insertResult = await insertRowEncrypted(client, 'main', 'proj_componenti', newComponentData);
            const newComponent = insertResult.rows[0];
            inserted += insertResult.rowCount;
            if (newComponent?.id) componentIdByKey.set(componentKey, newComponent.id);
            continue;
          }
          const updatedAtClause = hasUpdatedAt ? ', updated_at = CURRENT_TIMESTAMP' : '';
          const updateParams = [g.ore, componentId, req.user.tenant_id];
          let scadenzaRepairClause = '';
          let scadenzaChanged = '';
          if (assegnaCommessa) {
            updateParams.push(commessaId);
            scadenzaRepairClause += `,
                 commessa_id = $${updateParams.length}::uuid`;
            scadenzaChanged += ` OR commessa_id IS DISTINCT FROM $${updateParams.length}::uuid`;
          }
          if (componentiCols.has('scadenza')) {
            // Ogni componente interessato dall'import Qlik viene mantenuto attivo,
            // anche se esisteva già con una scadenza precedente o nulla.
            scadenzaRepairClause += `,
                 scadenza = DATE '2099-12-31'`;
            scadenzaChanged += " OR scadenza IS DISTINCT FROM DATE '2099-12-31'";
          }
          // Cast esplicito a numeric: se time_spent_hh/time_spent_gg non sono già di
          // tipo numerico (es. varchar, o una precisione che non accetta il valore
          // grezzo) Postgres rifiuta l'operazione con un errore esplicito.
          const result = await client.query(
            `UPDATE proj_componenti
             SET time_spent_hh = $1::numeric,
                 time_spent_gg = ($1::numeric) / 8.0${scadenzaRepairClause}${updatedAtClause}
             WHERE id = $2 AND tenant_id = $3
               AND (time_spent_hh IS DISTINCT FROM $1::numeric${scadenzaChanged})
             RETURNING id`,
            updateParams
          );
          // Riga già con le stesse ore (e già attiva): non si riscrive, così updated_at
          // resta quello dell'ultima modifica vera e il log non riceve righe inutili.
          // L'id viene dalla lettura per tenant fatta sopra, quindi la riga esiste.
          if (result.rowCount > 0) updated += result.rowCount;
          else unchanged += 1;
        }
      }

      // 3) Propagazione a proj_worker: per ciascun progetto toccato dall'import,
      // ricalcola il totale ore per (project_id, team_pro) sommando TUTTE le righe
      // di proj_componenti di quel progetto (non solo quelle appena importate, come
      // richiesto) e aggiorna la riga di proj_worker corrispondente, individuata da
      // worker_cost_id = team_pro. Stessa transazione dell'update sopra: se qualcosa
      // fallisce qui, viene annullato anche l'aggiornamento di proj_componenti.
      const componentiHasTeamPro = componentiCols.has('team_pro');
      if (projectIds.length && !componentiHasTeamPro) {
        console.error('[QLIK VOUCHER IMPORT] Colonna proj_componenti.team_pro non trovata: aggiornamento proj_worker saltato');
      } else if (projectIds.length) {
        const projWorkerCols = await getTableColumns('proj_worker');
        if (projWorkerCols.size === 0) {
          console.error('[QLIK VOUCHER IMPORT] Tabella proj_worker non trovata: aggiornamento proj_worker saltato');
        } else if (!['tenant_id', 'user_id', 'project_id', 'worker_cost_id', 'time_spent_hh', 'time_spent_gg'].every((c) => projWorkerCols.has(c))) {
          console.error('[QLIK VOUCHER IMPORT] La tabella proj_worker deve contenere project_id, worker_cost_id, time_spent_hh e time_spent_gg: aggiornamento saltato');
        } else {
          const workerUpdatedAtClause = projWorkerCols.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
          // Con le commesse (commessa_id su proj_worker e proj_componenti):
          //  - riga di proj_worker CON commessa: somma dei componenti della stessa commessa;
          //  - riga SENZA commessa: somma di tutti i componenti del progetto (come prima).
          const perCommessa = componentiHasCommessa && projWorkerCols.has('commessa_id');
          const aggResult = await client.query(
            `UPDATE proj_worker pw
             SET time_spent_hh = agg.total_hh,
                 time_spent_gg = agg.total_hh / 8.0${workerUpdatedAtClause}
             FROM (
               SELECT project_id, team_pro, ${perCommessa ? 'commessa_id' : 'NULL::uuid AS commessa_id'}, SUM(time_spent_hh) AS total_hh
               FROM proj_componenti
               WHERE tenant_id = $1 AND project_id::text = ANY($2::text[])
                 AND team_pro IS NOT NULL${perCommessa ? ' AND commessa_id IS NOT NULL' : ''}
               GROUP BY project_id, team_pro${perCommessa ? `, commessa_id
               UNION ALL
               SELECT project_id, team_pro, NULL::uuid, SUM(time_spent_hh)
               FROM proj_componenti
               WHERE tenant_id = $1 AND project_id::text = ANY($2::text[])
                 AND team_pro IS NOT NULL
               GROUP BY project_id, team_pro` : ''}
             ) agg
             WHERE pw.tenant_id = $1
               AND pw.project_id::text = agg.project_id::text
               AND pw.worker_cost_id::text = agg.team_pro::text
               ${perCommessa
                 ? `AND pw.commessa_id IS NOT DISTINCT FROM agg.commessa_id`
                 : ''}
               AND pw.time_spent_hh IS DISTINCT FROM agg.total_hh
             RETURNING pw.id`,
            [req.user.tenant_id, projectIds]
          );
          workerUpdated = aggResult.rowCount;
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({
      updated,
      unchanged,
      inserted,
      workerUpdated,
      totalGroups: groups.length,
      scope,
      notFoundCommessa: [...new Set(notFoundCommessa)],
      notFoundComponente
    });
  } catch (error) {
    console.error('[QLIK VOUCHER IMPORT]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
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
         -- I campi figli di un Nodo Padre (tipo_valore = 0) hanno argument = id della
         -- riga padre: appartengono al form di quel nodo, non sono argomenti di primo
         -- livello e non devono comparire come voci dell'elenco Impostazioni.
         AND argument !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
    assertStructureSourceAllowed(req, 'settings'); // struttura delle impostazioni: solo admin
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
    await assertFieldConfigAllowed(req, 'settings', { tipo_valore: tipoValore, tabella, colonna, VariabDB: variabDb }, null);
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
    // id_roles_write = ruolo di chi crea l'argomento (permesso di modifica per riga).
    if (scope === 'all-tenants') {
      query = `INSERT INTO settings (argument, tenant_id, user_id, ordinamento, id_roles, tipo_valore, tabella, colonna, "VariabDB", id_roles_write)
               SELECT $1, ut.tenant_id, ut.user_id, $2, $3::smallint, $4, $5, $6, $7, $8 FROM user_tenants ut`;
      params = [argName, newOrd, idRoles, tipoValore, tabella, colonna, variabDb, roleWriteValue(req)];
    } else {
      query = `INSERT INTO settings (argument, tenant_id, user_id, ordinamento, id_roles, tipo_valore, tabella, colonna, "VariabDB", id_roles_write)
               SELECT $1, ut.tenant_id, ut.user_id, $2, $4::smallint, $5, $6, $7, $8, $9
               FROM user_tenants ut WHERE ut.tenant_id = $3`;
      params = [argName, newOrd, req.user.tenant_id, idRoles, tipoValore, tabella, colonna, variabDb, roleWriteValue(req)];
    }
    const result = await db.query(query, params);
    res.status(201).json({ inserted: result.rowCount });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ===================== PROVISIONING NUOVO UTENTE =====================
// Routine per il campo tipo_valore=50 con valore2='Nuovo_utente': un super user crea un
// nuovo utente della propria azienda. Scrive in cascata: Projexa-Auth.users (genera l'id) ->
// Projexa.users (stesso id) -> user_tenants (associa al tenant del creatore).
// Colonne mai mostrate/gestite dal form (auto o sensibili).
// crypto = marcatore di cifratura a riposo della riga, gestito dal sistema.
const NEW_USER_HIDDEN = new Set(['id', 'created_at', 'updated_at', 'updated_by', 'password_hash', 'crypto']);
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
    // Ruolo mancante o non numerico nel token = livello minimo (prima il controllo veniva
    // saltato e si poteva creare un utente admin). Il ruolo admin (1) resta solo all'admin.
    const rawLevel = req.user.id_roles;
    const myLevel = (rawLevel == null || String(rawLevel).trim() === '' || !Number.isFinite(Number(rawLevel)))
      ? 9999 : Number(rawLevel);
    if (!Number.isFinite(idRoles) || idRoles < myLevel || (idRoles === 1 && !isAdminUser(req))) {
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
    assertStructureSourceAllowed(req, 'settings'); // struttura delle impostazioni: solo admin
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
    // Argomento con righe in sola lettura per il ruolo del contesto: non si elimina.
    if (!isAdminUser(req)) {
      const lockParams = [name, req.user.tenant_id];
      const writable = roleWriteSql(req, lockParams, '', null, 'settings').replace(/^ AND /, '');
      const locked = await db.query(
        `SELECT 1 FROM settings WHERE argument = $1 AND tenant_id = $2 AND NOT (${writable}) LIMIT 1`,
        lockParams
      );
      if (locked.rows.length) return res.status(403).json({ error: READ_ONLY_ERROR });
    }
    const result = await db.query(query, params);
    res.json({ deleted: result.rowCount });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Rinomina un intero argomento (settings): aggiorna la colonna argument su tutte le
// righe con quel nome, su questo tenant ('this-tenant') o su tutti ('all-tenants', solo admin).
// Conserva la natura custom: se l'argomento originale inizia con "(*)", il nuovo mantiene il prefisso.
app.put('/api/settings/argument/rename', requireAuth, async (req, res) => {
  try {
    assertStructureSourceAllowed(req, 'settings'); // struttura delle impostazioni: solo admin
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
    // Argomento con righe in sola lettura per il ruolo del contesto: non si rinomina.
    if (!isAdminUser(req)) {
      const lockParams = [oldName, req.user.tenant_id];
      const writable = roleWriteSql(req, lockParams, '', null, 'settings').replace(/^ AND /, '');
      const locked = await db.query(
        `SELECT 1 FROM settings WHERE argument = $1 AND tenant_id = $2 AND NOT (${writable}) LIMIT 1`,
        lockParams
      );
      if (locked.rows.length) return res.status(403).json({ error: READ_ONLY_ERROR });
    }
    const result = await db.query(query, params);
    res.json({ updated: result.rowCount, argument: finalNew });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
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
    res.json(sortByName(result.rows)); // [{ id, name, shared }, ...]
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logo cliente: il tenant e l'utente non arrivano mai dal browser, ma dal token.
// Un solo logo per (tenant_id, user_id, client_id), come previsto dal vincolo UNIQUE.
const CLIENT_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const clientLogoBody = express.raw({
  type: ['image/png', 'image/jpeg', 'image/webp'],
  limit: '1mb'
});

function detectClientLogoMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function assertOwnedClientLogoContext(clientId, req) {
  if (!UUID_RE.test(String(clientId || ''))) {
    const error = new Error('Cliente non valido');
    error.statusCode = 400;
    throw error;
  }
  const result = await db.query(
    `SELECT 1 FROM clients
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
       AND argument = 'Cliente' AND campo = 'Cliente'
     LIMIT 1`,
    [clientId, req.user.tenant_id, req.user.user_id]
  );
  if (result.rows.length === 0) {
    const error = new Error('Cliente non accessibile nel contesto corrente');
    error.statusCode = 403;
    throw error;
  }
}

app.get('/api/client-logos/:clientId', requireAuth, async (req, res) => {
  try {
    const clientId = req.params.clientId;
    await assertOwnedClientLogoContext(clientId, req);
    const result = await db.query(
      `SELECT logo, mime_type, filename
       FROM client_logos
       WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3
       LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, clientId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Logo non presente' });
    const row = result.rows[0];
    res.set('Content-Type', row.mime_type);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Logo-Filename', encodeURIComponent(row.filename || 'logo'));
    return res.send(row.logo);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.put('/api/client-logos/:clientId', requireAuth, clientLogoBody, async (req, res) => {
  try {
    const clientId = req.params.clientId;
    await assertOwnedClientLogoContext(clientId, req);
    const mimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!CLIENT_LOGO_MIME_TYPES.has(mimeType)) {
      return res.status(415).json({ error: 'Formato non supportato. Usa PNG, JPEG o WebP.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'File immagine mancante' });
    }
    if (req.body.length > 1024 * 1024) {
      return res.status(413).json({ error: 'Il logo non può superare 1 MB' });
    }
    if (detectClientLogoMime(req.body) !== mimeType) {
      return res.status(415).json({ error: 'Il contenuto del file non corrisponde a un’immagine valida.' });
    }
    let filename = 'logo';
    try { filename = decodeURIComponent(String(req.get('x-file-name') || 'logo')); } catch (e) { /* usa fallback */ }
    filename = path.basename(filename).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'logo';

    const result = await db.query(
      `INSERT INTO client_logos (tenant_id, user_id, client_id, logo, mime_type, filename)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, user_id, client_id)
       DO UPDATE SET logo = EXCLUDED.logo,
                     mime_type = EXCLUDED.mime_type,
                     filename = EXCLUDED.filename
       RETURNING id, client_id, mime_type, filename`,
      [req.user.tenant_id, req.user.user_id, clientId, req.body, mimeType, filename]
    );
    return res.json({ ...result.rows[0], size: req.body.length });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Logo dell'organizzazione: una sola riga per tenant. Tutti gli utenti del tenant
// possono leggerlo; soltanto gli amministratori possono caricarlo o sostituirlo.
app.get('/api/tenant-logo', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT logo, mime_type, filename
       FROM tenant_logos
       WHERE tenant_id = $1
       LIMIT 1`,
      [req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Logo organizzazione non presente' });
    const row = result.rows[0];
    res.set('Content-Type', row.mime_type);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Logo-Filename', encodeURIComponent(row.filename || 'logo'));
    return res.send(row.logo);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.put('/api/tenant-logo', requireAuth, requireAdmin, clientLogoBody, async (req, res) => {
  try {
    const mimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!CLIENT_LOGO_MIME_TYPES.has(mimeType)) {
      return res.status(415).json({ error: 'Formato non supportato. Usa PNG, JPEG o WebP.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'File immagine mancante' });
    }
    if (req.body.length > 1024 * 1024) {
      return res.status(413).json({ error: 'Il logo non può superare 1 MB' });
    }
    if (detectClientLogoMime(req.body) !== mimeType) {
      return res.status(415).json({ error: 'Il contenuto del file non corrisponde a un’immagine valida.' });
    }
    let filename = 'logo';
    try { filename = decodeURIComponent(String(req.get('x-file-name') || 'logo')); } catch (e) { /* usa fallback */ }
    filename = path.basename(filename).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'logo';

    const result = await db.query(
      `INSERT INTO tenant_logos (tenant_id, logo, mime_type, filename)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id)
       DO UPDATE SET logo = EXCLUDED.logo,
                     mime_type = EXCLUDED.mime_type,
                     filename = EXCLUDED.filename
       RETURNING tenant_id, mime_type, filename`,
      [req.user.tenant_id, req.body, mimeType, filename]
    );
    return res.json({ ...result.rows[0], size: req.body.length });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Foto del profilo di un contatto della rubrica (colonne foto, foto_mime, foto_nome: vedi
// Supporto/CreaDB/rubrica_foto.sql). Solo i contatti del tenant e utente del login; per
// caricare o togliere la foto serve il permesso di scrittura sulla riga (id_roles_write).
// Solo PNG e JPEG: sono i formati che PowerPoint legge sempre (la foto va nel Kick-off).
const FOTO_MIME = new Set(['image/png', 'image/jpeg']);
const fotoBody = express.raw({ type: ['image/png', 'image/jpeg'], limit: '1mb' });

async function rigaRubrica(req, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw Object.assign(new Error('Contatto non valido'), { statusCode: 400 });
  const r = (await db.query(
    'SELECT id, id_roles_write FROM rubrica WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1',
    [String(id), req.user.tenant_id, req.user.user_id]
  )).rows[0];
  if (!r) throw Object.assign(new Error('Contatto non trovato in rubrica'), { statusCode: 404 });
  return r;
}

app.get('/api/rubrica/:id/foto', requireAuth, async (req, res) => {
  try {
    await rigaRubrica(req, req.params.id);
    const r = (await db.query('SELECT foto, foto_mime, foto_nome FROM rubrica WHERE id::text = $1', [String(req.params.id)])).rows[0];
    if (!r || !r.foto) return res.status(404).json({ error: 'Foto non presente' });
    res.set('Content-Type', r.foto_mime || 'image/jpeg');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Foto-Nome', encodeURIComponent(r.foto_nome || 'foto'));
    return res.send(r.foto);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.put('/api/rubrica/:id/foto', requireAuth, fotoBody, async (req, res) => {
  try {
    const r = await rigaRubrica(req, req.params.id);
    if (!canWriteRow(req, r.id_roles_write, 'rubrica')) return res.status(403).json({ error: READ_ONLY_ERROR });
    const mimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!FOTO_MIME.has(mimeType)) return res.status(415).json({ error: 'Formato non supportato. Usa PNG o JPEG.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'File immagine mancante' });
    if (detectClientLogoMime(req.body) !== mimeType) {
      return res.status(415).json({ error: 'Il contenuto del file non corrisponde a un’immagine valida.' });
    }
    let nome = 'foto';
    try { nome = decodeURIComponent(String(req.get('x-file-name') || 'foto')); } catch (e) { /* usa il nome di riserva */ }
    nome = path.basename(nome).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'foto';
    await db.query('UPDATE rubrica SET foto = $1, foto_mime = $2, foto_nome = $3 WHERE id = $4', [req.body, mimeType, nome, r.id]);
    return res.json({ success: true, size: req.body.length });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/api/rubrica/:id/foto', requireAuth, async (req, res) => {
  try {
    const r = await rigaRubrica(req, req.params.id);
    if (!canWriteRow(req, r.id_roles_write, 'rubrica')) return res.status(403).json({ error: READ_ONLY_ERROR });
    await db.query('UPDATE rubrica SET foto = NULL, foto_mime = NULL, foto_nome = NULL WHERE id = $1', [r.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Cliente/progetto "Modello standard": quando la creazione di un nuovo cliente o
// progetto non specifica un modello proprio dell'utente, la struttura viene copiata da
// questo cliente/progetto di riferimento, che vive sempre sullo stesso tenant dedicato
// ai modelli standard — indipendentemente dal tenant/cliente da cui parte la richiesta.
const STANDARD_TEMPLATE_TENANT_ID = '22e0984d-3a07-4cdc-9497-c9b2e7986842';
const STANDARD_TEMPLATE_CLIENT_ID = '212e87c1-1589-40fb-8256-623010277f9d';
const STANDARD_TEMPLATE_PROJECT_ID = '1b13f99a-55b8-47ea-9f49-de9f691c9b5b';

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

// Copia le righe di proj_worker_cost del cliente sorgente sul nuovo cliente (copia cliente).
// Le colonne sono lette dalla tabella: si copiano tutte tranne id, contesto e date tecniche;
// tenant_id/user_id/client_id sono quelli del nuovo cliente, id_roles_write il ruolo di chi crea.
async function copyClientWorkerCosts(dbClient, req, srcClientId, newClientId) {
  const cols = await getTableColumns('proj_worker_cost');
  if (!cols.size || !cols.has('client_id')) return 0;
  const generated = await getGeneratedColumns('proj_worker_cost');
  const skip = new Set(['id', 'tenant_id', 'user_id', 'client_id', 'id_roles_write', 'created_at', 'updated_at']);
  const copyCols = [...cols].filter((c) => !skip.has(c) && !generated.has(c)).map(assertValidIdentifier);
  const insertCols = ['tenant_id', 'user_id', 'client_id', ...copyCols];
  const selectCols = ['$1::uuid', '$2::uuid', '$3::uuid', ...copyCols.map((c) => `src."${c}"`)];
  const r = await dbClient.query(
    `INSERT INTO proj_worker_cost (${insertCols.map((c) => `"${c}"`).join(', ')})
     SELECT ${selectCols.join(', ')} FROM proj_worker_cost src WHERE src.client_id = $4::uuid
     RETURNING id`,
    [req.user.tenant_id, req.user.user_id, newClientId, srcClientId]
  );
  if (r.rowCount && cols.has('id_roles_write')) {
    await dbClient.query('UPDATE proj_worker_cost SET id_roles_write = $1 WHERE id = ANY($2::uuid[])',
      [roleWriteValue(req), r.rows.map((x) => x.id)]);
  }
  return r.rowCount;
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
    const ins = await insertRowEncrypted(client, 'main', 'clients', {
      argument: 'Cliente',
      campo: 'Cliente',
      valore2: name,
      tenant_id: req.user.tenant_id,
      user_id: req.user.user_id
    });
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
        `SELECT id FROM clients WHERE id = $1 AND tenant_id = $2
           AND argument='Cliente' AND campo='Cliente' LIMIT 1`,
        [STANDARD_TEMPLATE_CLIENT_ID, STANDARD_TEMPLATE_TENANT_ID]
      );
      if (m.rows.length) srcId = m.rows[0].id;
    }
    if (srcId) {
      await deepCopyClientTree(client, req.user.tenant_id, req.user.user_id, srcId, newClient.id);
      // Costi delle risorse (proj_worker_cost) del cliente copiato: stesse righe sul nuovo
      // cliente, con tenant/utente di chi crea e id_roles_write = suo ruolo.
      await copyClientWorkerCosts(client, req, srcId, newClient.id);
    }
    // Tutte le righe del nuovo cliente (master_id = id cliente, compilato dal trigger) e gli
    // eventuali progetti copiati: modificabili dal ruolo di chi crea il cliente.
    await client.query('UPDATE clients SET id_roles_write = $1 WHERE master_id = $2', [roleWriteValue(req), newClient.id]);
    await client.query('UPDATE projects SET id_roles_write = $1 WHERE client_id = $2 AND tenant_id = $3',
      [roleWriteValue(req), newClient.id, req.user.tenant_id]);
    newClient.id_roles_write = roleWriteValue(req);

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
app.get('/api/projects/search', requireAuth, async (req, res) => {
  try {
    const term = String((req.query && req.query.q) || '').trim();
    if (!term) return res.json([]);

    const rawClientIds = req.query && req.query.clientId;
    const clientIds = (Array.isArray(rawClientIds) ? rawClientIds : rawClientIds ? [rawClientIds] : [])
      .map(value => String(value).trim())
      .filter(Boolean);

    const params = [req.user.tenant_id, req.user.user_id];
    let clientFilter = '';
    if (clientIds.length > 0) {
      params.push(clientIds);
      clientFilter = ` AND p.client_id::text = ANY($${params.length}::text[])`;
    }

    // valore2 di projects/clients può essere cifrato a riposo: il LIKE viene quindi
    // applicato dopo la lettura, sui valori già decifrati dal pool.
    const result = await db.query(
      `SELECT p.id, p.valore2 AS name, p.client_id, c.valore2 AS client_name,
              (p.scadenza IS NOT NULL AND p.scadenza < CURRENT_DATE) AS is_closed
       FROM projects p
       JOIN clients c
         ON c.id = p.client_id
        AND c.tenant_id = p.tenant_id
        AND c.argument = 'Cliente'
        AND c.campo = 'Cliente'
       WHERE p.argument = 'Progetto'
         AND p.campo = 'Progetto'
         AND p.tenant_id = $1
         AND p.user_id = $2
         AND p.valore2 IS NOT NULL${clientFilter}
       ORDER BY c.valore2, p.valore2`,
      params
    );

    const needle = term.toLocaleLowerCase('it-IT');
    const matches = result.rows
      .filter(row => String(row.name || '').toLocaleLowerCase('it-IT').includes(needle))
      .slice(0, 30);
    res.json(matches);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

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
    res.json(sortByName(r.rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crea un nuovo progetto per un cliente: riga identità (argument='Progetto', campo='Progetto',
// valore2=nome, client_id) + copia della struttura da un progetto modello scelto
// (sourceProjectId) o, in mancanza, dal master 'PROGETTO_COPIA' del tenant PROJEXA.
// Rinomina un progetto (pulsante matita nell'elenco "Progetti clienti"): aggiorna valore2 della
// riga identità (argument = 'Progetto', campo = 'Progetto', id = id del progetto) del login.
// La scrittura passa da cryptoWrite: se la riga è cifrata (crypto = 1) il nome resta cifrato.
app.put('/api/projects/:id/name', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!GP_UUID.test(id)) return res.status(400).json({ error: 'Progetto non valido' });
    const name = String((req.body && req.body.name) || '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: 'Nome obbligatorio' });
    if (name.length > 255) return res.status(400).json({ error: 'Nome troppo lungo (max 255 caratteri)' });
    const data = await cryptoWrite(db, 'main', 'projects', { valore2: name }, id);
    const r = await db.query(
      `UPDATE projects SET valore2 = $1${data.crypto != null ? ', crypto = $5' : ''}
        WHERE id = $2 AND tenant_id = $3 AND user_id = $4 AND argument = 'Progetto' AND campo = 'Progetto'`,
      data.crypto != null ? [data.valore2, id, req.user.tenant_id, req.user.user_id, data.crypto]
        : [data.valore2, id, req.user.tenant_id, req.user.user_id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Progetto non trovato' });
    res.json({ ok: true, name });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

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
    const ins = await insertRowEncrypted(client, 'main', 'projects', {
      argument: 'Progetto',
      campo: 'Progetto',
      valore2: name,
      tenant_id: req.user.tenant_id,
      user_id: req.user.user_id,
      client_id: clientId
    });
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
        `SELECT id FROM projects WHERE id = $1 AND tenant_id = $2 AND client_id = $3
           AND argument='Progetto' AND campo='Progetto' LIMIT 1`,
        [STANDARD_TEMPLATE_PROJECT_ID, STANDARD_TEMPLATE_TENANT_ID, STANDARD_TEMPLATE_CLIENT_ID]
      );
      if (m.rows.length) srcId = m.rows[0].id;
    }
    if (srcId) {
      await deepCopyProjectTree(client, req.user.tenant_id, req.user.user_id, clientId, srcId, newProject.id);
    }
    // Tutte le righe del nuovo progetto (master_id = id progetto, compilato dal trigger):
    // modificabili dal ruolo di chi crea il progetto.
    await client.query('UPDATE projects SET id_roles_write = $1 WHERE master_id = $2', [roleWriteValue(req), newProject.id]);
    newProject.id_roles_write = roleWriteValue(req);

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
    res.json(sortByName(r.rows));
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
    res.json(sortByName(r.rows));
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
// Controllo feature della sidebar. A differenza dell'endpoint generico /api/data/settings,
// questo filtro viene applicato SEMPRE anche agli admin: durante l'impersonificazione
// tenant_id e user_id devono essere esclusivamente quelli presenti nel token attivo.
app.get('/api/settings/feature-flag', requireAuth, async (req, res) => {
  try {
    const argument = String((req.query && req.query.argument) || 'Integrazioni').trim();
    const campo = String((req.query && req.query.campo) || '').trim();
    if (!campo) return res.status(400).json({ error: 'campo richiesto' });
    const result = await db.query(
      `SELECT EXISTS (
         SELECT 1
         FROM settings
         WHERE tenant_id = $1
           AND user_id = $2
           AND LOWER(BTRIM(argument)) = LOWER(BTRIM($3))
           AND LOWER(BTRIM(campo)) IN (
             LOWER(BTRIM($4)),
             LOWER(BTRIM('(*) ' || $4))
           )
           AND LOWER(BTRIM(COALESCE(valore1::text, ''))) IN ('true', 't', '1', 'yes', 'on')
       ) AS enabled`,
      [req.user.tenant_id, req.user.user_id, argument, campo]
    );
    const enabled = result.rows[0]?.enabled === true
      || ['true', 't', '1'].includes(String(result.rows[0]?.enabled).toLowerCase());
    res.json({ enabled });
  } catch (error) {
    console.error('[SETTINGS FEATURE FLAG]', {
      argument: req.query?.argument || 'Integrazioni',
      campo: req.query?.campo,
      tenant_id: req.user?.tenant_id,
      user_id: req.user?.user_id,
      error: error.message
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Visibilità delle sezioni della dashboard: campi settings booleani (valore1) del
// tenant/utente del token, in qualunque argument (nome campo senza maiuscole e senza "(*) ").
// Se la riga non esiste la sezione resta visibile (comportamento precedente).
// Chiave restituita → nome del campo.
const DASHBOARD_FLAGS = {
  chatbot: 'chat-bot projexa',
  kpiFatturato: 'mostra kpi fatturato',
  calendario: 'mostra calendario',
  todo: 'mostra todolist',
  issue: 'mostra funzione issue',
  reporting: 'mostra reporting',
  registra: 'mostra registra'
};
// Flag che senza riga in settings valgono false (moduli nuovi, da attivare esplicitamente).
const DASHBOARD_FLAGS_DEFAULT_OFF = new Set(['reporting']);
async function readDashboardFlags(user) {
  const r = await db.query(
    `SELECT LOWER(REGEXP_REPLACE(BTRIM(campo), '^\\(\\*\\)\\s*', '')) AS campo, valore1
       FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND LOWER(REGEXP_REPLACE(BTRIM(campo), '^\\(\\*\\)\\s*', '')) = ANY($3)`,
    [user.tenant_id, user.user_id, Object.values(DASHBOARD_FLAGS)]
  );
  const flags = {};
  for (const [key, campo] of Object.entries(DASHBOARD_FLAGS)) {
    const row = r.rows.find(x => x.campo === campo);
    flags[key] = row
      ? ['true', 't', '1', 'yes', 'on'].includes(String(row.valore1 ?? '').trim().toLowerCase())
      : !DASHBOARD_FLAGS_DEFAULT_OFF.has(key);
  }
  return flags;
}
app.get('/api/settings/dashboard-flags', requireAuth, async (req, res) => {
  try {
    res.json(await readDashboardFlags(req.user));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// === MODULO REPORTING (sito/reporting.html) ===
// Aree del reporting: tabella EAV e riga identità (radice) di ogni elemento.
//   clients  -> un cliente per riga   (argument = campo = 'Cliente')
//   projects -> un progetto per riga  (argument = campo = 'Progetto', con client_id)
// Tutto disponibile solo con "Mostra Reporting" attivo, per tenant + utente del contesto.
const REPORTING_AREAS = {
  clients: { root: 'Cliente', firstFields: [{ campo: 'Nome Cliente', key: 'Cliente' }] },
  // Il nome del cliente si prende dall'area Clienti ("Nome Cliente"): la griglia unisce le
  // due aree per client_id.
  projects: { root: 'Progetto', firstFields: [{ campo: 'Nome Progetto', key: 'Progetto' }] }
};
// Esclusi i tipi che non sono dati da riportare: griglie/Gantt (11, 13), espressioni (12),
// Nodo Padre (0, resta solo come intestazione dei suoi campi), collegamenti (20), accesso
// DB/funzioni (15, 16), password (40), riferimento a tabella (4), flag+testo (14), routine (50).
const REPORTING_EXCLUDED_TYPES = new Set(['11', '13', '12', '0', '20', '15', '16', '40', '4', '14', '50']);

// Tabelle "dettaglio" del reporting: tabelle normali (una riga per record) legate al cliente
// da tenant_id + user_id + client_id e, se hanno project_id, anche al progetto.
const REPORTING_TABLES = {
  quotazioni: { table: 'cl_quotazioni', label: 'Quotazioni' },
  contatti: { table: 'contacts', label: 'Contatti' },
  issue: { table: 'issue', label: 'Issue' },
  licenze: { table: 'licenze_app', label: 'Licenze' },
  fatturazione: { table: 'proj_anno_fatt', label: 'Fatturazione Anno/mese' },
  costi: { table: 'proj_worker', label: 'Costi Progetto' },
  tktjira: { table: 'task_app', label: 'Tkt Jira' },
  todo: { table: 'tasks', label: 'To do List' },
  // View delle commesse (Supporto/CreaDB/ele_commesse.sql): una riga per commessa e
  // componente. commessa_id è un UUID senza foreign key (view): non lo si propone.
  commesse: { table: 'ele_commesse', label: 'Commesse', hidden: ['commessa_id'] }
};
// Colonne tecniche mai mostrate come campi.
const REPORTING_HIDDEN_COLUMNS = new Set(['id', 'tenant_id', 'user_id', 'client_id', 'project_id', 'id_roles',
  'id_roles_write', 'crypto', 'master_id', 'created_at', 'updated_at', 'update_by', 'updated_by', 'created_by',
  // validità della riga: usate solo per filtrare i record attivi, non come dati del report
  'scadenza', 'data_inizio']);
// Campi/colonne di appoggio ("appo…", anche "apppo…", maiuscole o minuscole): mai mostrati.
const isReportingAppoName = (name) => /^app+o/i.test(String(name || '').replace(/^\(\*\)\s*/, '').trim());
// Colonna descrittiva di una tabella collegata (FK): stessa scelta delle griglie tipo 11.
const REPORTING_FK_DISPLAY = ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'label', 'valore2', 'commessa'];

// Colonne utilizzabili di una tabella dettaglio: [{ name, type, fk: { table, column, display } }].
async function reportingTableColumns(area) {
  const t = REPORTING_TABLES[area].table;
  const cols = (await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [t]
  )).rows;
  const fks = (await db.query(
    `SELECT kcu.column_name, ccu.table_name AS ft, ccu.column_name AS fc
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`,
    [t]
  )).rows;
  const out = [];
  for (const c of cols) {
    if (REPORTING_HIDDEN_COLUMNS.has(c.column_name) || isReportingAppoName(c.column_name)) continue;
    if ((REPORTING_TABLES[area].hidden || []).includes(c.column_name)) continue;
    const fk = fks.find((x) => x.column_name === c.column_name);
    let fkInfo = null;
    if (fk) {
      const fcols = await getTableColumns(fk.ft);
      const display = [...fcols].find((n) => /^desc_/i.test(n)) || REPORTING_FK_DISPLAY.find((n) => fcols.has(n));
      if (display) fkInfo = { table: fk.ft, column: fk.fc, display };
    }
    out.push({ name: c.column_name, type: c.data_type, fk: fkInfo });
  }
  return { table: t, columns: out, all: new Set(cols.map((c) => c.column_name)) };
}
// Etichetta leggibile dal nome tecnico: "data_richiesta" -> "Data richiesta".
const reportingColumnLabel = (name) => {
  const comune = etichettaComune(String(name)); // es. commessa_id -> "Commessa"
  if (comune) return comune;
  const s = String(name).replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// Campi (colonne) di una tabella dettaglio.
app.get('/api/reporting/table-fields/:area', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    if (!REPORTING_TABLES[req.params.area]) return res.status(404).json({ error: 'Area non trovata' });
    const { columns } = await reportingTableColumns(req.params.area);
    res.json(columns.map((c) => ({ campo: reportingColumnLabel(c.name), key: c.name, custom: false, group: false, parent: null, parentKey: null })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

async function assertReportingEnabled(req) {
  if (!(await readDashboardFlags(req.user)).reporting) {
    throw Object.assign(new Error('Modulo Reporting non attivo'), { statusCode: 403 });
  }
}
function reportingRoleLevel(req) {
  const role = Number(req.user.id_roles);
  return Number.isFinite(role) ? role : 9999;
}

// Campi disponibili (standard e custom "(*)") dell'area, con la stessa visibilità per ruolo
// del dettaglio (id_roles NULL o >= ruolo, anche per il Nodo Padre che li contiene). Un campo
// compare una volta sola anche se esiste in più elementi. parent = nome del Nodo Padre.
app.get('/api/reporting/fields/:source(clients|projects)', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    const source = req.params.source;
    const area = REPORTING_AREAS[source];
    const r = await db.query(
      `SELECT CASE WHEN p.argument = $4 THEN NULL ELSE p.campo END AS parent,
              f.campo, f.tipo_valore, MIN(f.ordinamento) AS ordinamento
         FROM "${source}" f
         JOIN "${source}" p ON p.id::text = f.argument
        WHERE f.tenant_id = $1 AND f.user_id = $2
          AND f.campo IS NOT NULL AND BTRIM(f.campo) <> '' AND f.argument <> $4
          -- Visibilità per ruolo (id_roles più basso = più privilegi): es. ruolo 70 vede
          -- i campi 70/80/90 e quelli senza id_roles, non i 69. Vale anche per il Nodo Padre.
          AND (f.id_roles IS NULL OR f.id_roles >= $3)
          AND (p.argument = $4 OR p.id_roles IS NULL OR p.id_roles >= $3)
        GROUP BY 1, 2, 3
        ORDER BY MIN(f.ordinamento) NULLS LAST, 2`,
      [req.user.tenant_id, req.user.user_id, reportingRoleLevel(req), area.root]
    );
    const first = area.firstFields.map((f) => ({ ...f, custom: false, tipo_valore: '2', group: false, parent: null, parentKey: null }));
    res.json(first.concat(r.rows
      .filter((x) => String(x.tipo_valore).trim() === '0' || !REPORTING_EXCLUDED_TYPES.has(String(x.tipo_valore).trim()))
      .filter((x) => !isReportingAppoName(x.campo)) // campi di appoggio "appo…"
      .map((x) => ({
        campo: String(x.campo).replace(/^\(\*\)\s*/, ''),
        custom: isCustomCampo(x.campo),
        tipo_valore: x.tipo_valore,
        // group = Nodo Padre: il browser lo mostra solo come intestazione, se ha campi visibili
        group: String(x.tipo_valore).trim() === '0',
        parent: x.parent ? String(x.parent).replace(/^\(\*\)\s*/, '') : null,
        // Chiave tecnica per leggere i dati: nome reale del campo e del suo Nodo Padre.
        key: String(x.campo),
        parentKey: x.parent ? String(x.parent) : null
      }))));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Valori dei campi scelti per gli elementi indicati (clienti o progetti): Map
// "<id elemento>\u0001<nodo padre>\u0001<campo>" -> valore da mostrare. Stessa visibilità per
// ruolo dell'elenco campi. Valore per tipo: 1 = valore1 (Sì/No); 3/30/31 = valore3 (numero);
// 8 = valore3 (%); altri = valore2. I numeri interi senza ".00", i decimali in formato italiano.
const reportingCellKey = (itemId, parent, campo) => `${itemId}\u0001${parent || ''}\u0001${campo}`;
async function reportingValues(req, source, ids, keys) {
  const values = new Map();
  if (!ids.length || !keys.length) return values;
  const root = REPORTING_AREAS[source].root;
  const r = await db.query(
    `SELECT f.master_id, f.campo, CASE WHEN p.argument = $6 THEN NULL ELSE p.campo END AS parent,
            f.tipo_valore, f.valore1, f.valore2, f.valore3
       FROM "${source}" f
       JOIN "${source}" p ON p.id::text = f.argument
      WHERE f.tenant_id = $1 AND f.user_id = $2 AND f.master_id = ANY($3::uuid[])
        AND f.argument <> $6 AND f.campo = ANY($4::text[])
        AND (f.id_roles IS NULL OR f.id_roles >= $5)
        AND (p.argument = $6 OR p.id_roles IS NULL OR p.id_roles >= $5)`,
    [req.user.tenant_id, req.user.user_id, ids, keys, reportingRoleLevel(req), root]
  );
  const fmtNumber = (n) => {
    if (n == null || n === '') return '';
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    return Number.isInteger(x) ? String(x) : x.toLocaleString('it-IT', { maximumFractionDigits: 2 });
  };
  for (const v of r.rows) {
    const t = String(v.tipo_valore).trim();
    let val;
    if (t === '1') val = (v.valore1 === true || v.valore1 === 't' || v.valore1 === 'true') ? 'Sì' : 'No';
    else if (t === '8') val = v.valore3 == null || v.valore3 === '' ? '' : `${fmtNumber(v.valore3)}%`; // percentuale
    else if (t === '3' || t === '30' || t === '31') val = fmtNumber(v.valore3);
    else val = v.valore2;
    values.set(reportingCellKey(v.master_id, v.parent, v.campo), val == null ? '' : val);
  }
  return values;
}

// Dati della griglia unica: colonne di clienti, progetti e tabelle dettaglio insieme, legate
// dalla chiave comune tenant_id + user_id + client_id (e project_id per le tabelle che lo hanno,
// quando nella griglia ci sono colonne dei progetti). fields = JSON [{ area, key, parentKey }].
// Le righe si combinano (prodotto) per cliente/progetto: es. 3 quotazioni × 2 contatti = 6
// righe per quel cliente. Per ogni area si mostrano gli elementi attivi (scadenza vuota o futura), i non
// attivi (scadenza passata) o entrambi, secondo le caselle della pagina (status); sempre visibili
// al ruolo (id_roles); le righe con tutte le celle vuote vengono scartate.
// Chiavi speciali: 'Cliente' / 'Progetto' = nome del cliente / progetto.
const REPORTING_MAX_ROWS = 5000;
app.get('/api/reporting/data', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    let fields = [];
    try { fields = JSON.parse(String(req.query.fields || '[]')); } catch (e) { fields = []; }
    fields = (Array.isArray(fields) ? fields : [])
      .filter((f) => f && (REPORTING_AREAS[f.area] || REPORTING_TABLES[f.area]) && typeof f.key === 'string' && f.key.trim())
      .slice(0, 60)
      .map((f) => ({ area: f.area, key: f.key, parentKey: f.parentKey ? String(f.parentKey) : null }));
    const withProjects = fields.some((f) => f.area === 'projects');
    const role = reportingRoleLevel(req);
    // Stato per area (caselle "Attivi" / "Non attivi"): status = JSON { area: { active, inactive } }.
    // Default: solo attivi (scadenza vuota o da oggi in poi); non attivi = scadenza passata.
    let status = {};
    try { status = JSON.parse(String(req.query.status || '{}')) || {}; } catch (e) { status = {}; }
    const expiryCond = (area, col) => {
      const s = status[area] || {};
      const active = s.active !== false;
      const inactive = s.inactive === true;
      if (active && inactive) return '';
      if (inactive) return ` AND ${col} < CURRENT_DATE`;
      return ` AND (${col} IS NULL OR ${col} >= CURRENT_DATE)`;
    };

    const clients = sortByName((await db.query(
      `SELECT id, valore2 AS name FROM clients
        WHERE argument = 'Cliente' AND campo = 'Cliente' AND tenant_id = $1 AND user_id = $2
          ${expiryCond('clients', 'scadenza')}`,
      [req.user.tenant_id, req.user.user_id]
    )).rows);
    const clientIds = clients.map((c) => c.id);
    const projects = withProjects
      ? sortByName((await db.query(
        `SELECT id, valore2 AS name, client_id FROM projects
          WHERE argument = 'Progetto' AND campo = 'Progetto' AND tenant_id = $1 AND user_id = $2
            ${expiryCond('projects', 'scadenza')}`,
        [req.user.tenant_id, req.user.user_id]
      )).rows)
      : [];
    const groupBy = (list, key) => {
      const m = new Map();
      list.forEach((x) => { const k = String(x[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
      return m;
    };
    const projectsByClient = groupBy(projects, 'client_id');

    // Valori EAV di clienti e progetti.
    const keysOf = (area) => fields.filter((f) => f.area === area && !['Cliente', 'Progetto'].includes(f.key)).map((f) => f.key);
    const clientValues = await reportingValues(req, 'clients', clientIds, keysOf('clients'));
    const projectValues = await reportingValues(req, 'projects', projects.map((p) => p.id), keysOf('projects'));

    // Tabelle dettaglio scelte: righe attive e visibili, raggruppate per cliente e per progetto.
    const fmtNumber = (n) => {
      if (n == null || n === '') return '';
      const x = Number(n);
      if (!Number.isFinite(x)) return String(n);
      return Number.isInteger(x) ? String(x) : x.toLocaleString('it-IT', { maximumFractionDigits: 2 });
    };
    const fmtCell = (v, type) => {
      if (v == null || v === '') return '';
      if (typeof v === 'boolean' || type === 'boolean') return (v === true || v === 't' || v === 'true') ? 'Sì' : 'No';
      if (v instanceof Date || type === 'date') {
        const d = v instanceof Date ? v : new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        const pad = (x) => String(x).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
      }
      if (['numeric', 'integer', 'smallint', 'bigint', 'double precision', 'real'].includes(type)) return fmtNumber(v);
      return String(v);
    };
    const tables = [];
    for (const area of [...new Set(fields.filter((f) => REPORTING_TABLES[f.area]).map((f) => f.area))]) {
      const info = await reportingTableColumns(area);
      const wanted = fields.filter((f) => f.area === area).map((f) => info.columns.find((c) => c.name === f.key)).filter(Boolean);
      const selects = [];
      const joins = [];
      wanted.forEach((c, i) => {
        assertValidIdentifier(c.name);
        if (c.fk) {
          const alias = `fk${i}`;
          joins.push(`LEFT JOIN "${assertValidIdentifier(c.fk.table)}" ${alias} ON ${alias}."${assertValidIdentifier(c.fk.column)}" = d."${c.name}"`);
          selects.push(`${alias}."${assertValidIdentifier(c.fk.display)}" AS "${c.name}"`);
        } else {
          selects.push(`d."${c.name}"`);
        }
      });
      const hasProject = info.all.has('project_id');
      const params = [req.user.tenant_id, req.user.user_id, clientIds];
      const conds = ['d.tenant_id = $1', 'd.user_id = $2', 'd.client_id = ANY($3::uuid[])'];
      if (info.all.has('scadenza')) {
        const cond = expiryCond(area, 'd.scadenza').replace(/^ AND /, '');
        if (cond) conds.push(cond);
      }
      if (info.all.has('id_roles')) { params.push(role); conds.push(`(d.id_roles IS NULL OR d.id_roles >= $${params.length})`); }
      const rows = clientIds.length ? (await db.query(
        `SELECT d.client_id${hasProject ? ', d.project_id' : ''}${selects.length ? ', ' + selects.join(', ') : ''}
           FROM "${info.table}" d ${joins.join(' ')}
          WHERE ${conds.join(' AND ')}`,
        params
      )).rows : [];
      const types = new Map(wanted.map((c) => [c.name, c.fk ? 'text' : c.type]));
      tables.push({
        area,
        // Con colonne dei progetti, le tabelle che hanno project_id si legano al progetto.
        byProject: withProjects && hasProject,
        byClientRows: groupBy(rows, 'client_id'),
        byProjectRows: hasProject ? groupBy(rows.filter((r) => r.project_id), 'project_id') : new Map(),
        fmt: (row, key) => (row && Object.prototype.hasOwnProperty.call(row, key) ? fmtCell(row[key], types.get(key)) : '')
      });
    }

    const cell = (f, client, project, detail) => {
      if (f.area === 'clients') {
        if (f.key === 'Cliente') return client.name || '';
        return clientValues.get(reportingCellKey(client.id, f.parentKey, f.key)) ?? '';
      }
      if (f.area === 'projects') {
        if (!project) return '';
        if (f.key === 'Progetto') return project.name || '';
        return projectValues.get(reportingCellKey(project.id, f.parentKey, f.key)) ?? '';
      }
      const t = tables.find((x) => x.area === f.area);
      return t ? t.fmt(detail[f.area], f.key) : '';
    };

    const rows = [];
    let truncated = false;
    outer:
    for (const c of clients) {
      const projs = withProjects ? (projectsByClient.get(String(c.id)) || []) : [];
      for (const p of (projs.length ? projs : [null])) {
        // Righe di ogni tabella dettaglio per questo cliente/progetto ([null] = nessuna riga).
        const lists = tables.map((t) => {
          const list = t.byProject
            ? (p ? (t.byProjectRows.get(String(p.id)) || []) : [])
            : (t.byClientRows.get(String(c.id)) || []);
          return list.length ? list : [null];
        });
        // Prodotto delle righe delle tabelle dettaglio.
        let combos = [{}];
        tables.forEach((t, i) => {
          const next = [];
          combos.forEach((combo) => lists[i].forEach((r) => next.push({ ...combo, [t.area]: r })));
          combos = next;
        });
        for (const detail of combos) {
          const values = fields.map((f) => cell(f, c, p, detail));
          if (!values.some((v) => String(v).trim() !== '')) continue; // riga tutta vuota
          rows.push({ clientId: c.id, projectId: p ? p.id : null, values });
          if (rows.length >= REPORTING_MAX_ROWS) { truncated = true; break outer; }
        }
      }
    }
    res.json({ rows, truncated, maxRows: REPORTING_MAX_ROWS });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// --- Report salvati ("I miei Report", tabella reporting: Supporto/CreaDB/reporting.sql) ---
// report = definizione JSON { columns, sort, filters, valueFilters }: i dati si ricalcolano a
// ogni apertura con /api/reporting/data. Sempre e solo i report del tenant + utente del contesto.
const REPORT_MAX_JSON = 200 * 1024;
app.get('/api/reporting/reports', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    const r = await db.query(
      'SELECT id, nome_report FROM reporting WHERE tenant_id = $1 AND user_id = $2',
      [req.user.tenant_id, req.user.user_id]
    );
    res.json(r.rows.sort((a, b) => String(a.nome_report).localeCompare(String(b.nome_report), 'it', { sensitivity: 'base' })));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});
app.get('/api/reporting/reports/:id', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    const r = await db.query(
      'SELECT id, nome_report, report FROM reporting WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3',
      [String(req.params.id), req.user.tenant_id, req.user.user_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Report non trovato' });
    let report = {};
    try { report = JSON.parse(r.rows[0].report || '{}'); } catch (e) { report = {}; }
    res.json({ id: r.rows[0].id, nome_report: r.rows[0].nome_report, report });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});
// Salva: nome nuovo = nuovo report; nome già usato = 409, a meno di overwrite:true (sovrascrive).
app.post('/api/reporting/reports', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    const nome = String((req.body && req.body.nome_report) || '').trim().slice(0, 255);
    if (!nome) return res.status(400).json({ error: 'Nome del report richiesto' });
    const def = req.body && req.body.report;
    if (!def || typeof def !== 'object' || !Array.isArray(def.columns) || !def.columns.length) {
      return res.status(400).json({ error: 'Il report non ha colonne' });
    }
    const json = JSON.stringify({
      columns: def.columns, sort: def.sort || null, filters: def.filters || {}, valueFilters: def.valueFilters || {},
      // grafici della scheda "Grafici" (tipo, categoria, valori/aggregazioni)
      charts: Array.isArray(def.charts) ? def.charts.slice(0, 30) : [],
      // caselle Attivi / Non attivi per area
      status: def.status && typeof def.status === 'object' ? def.status : {}
    });
    if (json.length > REPORT_MAX_JSON) return res.status(413).json({ error: 'Report troppo grande' });
    const existing = await db.query(
      'SELECT id FROM reporting WHERE tenant_id = $1 AND user_id = $2 AND lower(nome_report) = lower($3)',
      [req.user.tenant_id, req.user.user_id, nome]
    );
    if (existing.rows[0]) {
      if (!(req.body && req.body.overwrite === true)) {
        return res.status(409).json({ error: 'Esiste già un report con questo nome', id: existing.rows[0].id });
      }
      await db.query('UPDATE reporting SET report = $1, nome_report = $2 WHERE id = $3', [json, nome, existing.rows[0].id]);
      return res.json({ id: existing.rows[0].id, nome_report: nome, updated: true });
    }
    const r = await db.query(
      'INSERT INTO reporting (tenant_id, user_id, nome_report, report) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.user.tenant_id, req.user.user_id, nome, json]
    );
    res.status(201).json({ id: r.rows[0].id, nome_report: nome, created: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});
app.delete('/api/reporting/reports/:id', requireAuth, async (req, res) => {
  try {
    await assertReportingEnabled(req);
    const r = await db.query(
      'DELETE FROM reporting WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3',
      [String(req.params.id), req.user.tenant_id, req.user.user_id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Report non trovato' });
    res.json({ deleted: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/settings/chatbot-enabled', requireAuth, async (req, res) => {
  try {
    res.json({ enabled: (await readDashboardFlags(req.user)).chatbot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    await assertFieldConfigAllowed(req, req.params.source, { tipo_valore: tipoValore, tabella, colonna, VariabDB: variabDb }, null);
    const scope = (req.body && req.body.scope) || 'this';
    const tenantScope = (req.body && req.body.tenantScope) || 'this-tenant';
    const isAdminTenantScope = Number(req.user.id_roles) === 1;
    if (tenantScope === 'all-tenants' && !isAdminTenantScope) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }
    const kind = (req.body && req.body.kind) || 'custom';
    // Tutte le INSERT del nuovo campo passano da qui: le righe create diventano
    // modificabili dal ruolo di chi crea il campo (id_roles_write).
    const insertField = async (sql, params) => {
      const text = /\bRETURNING\b/i.test(sql) ? sql : `${sql} RETURNING id`;
      const r = await db.query(text, params);
      const ids = r.rows.map((row) => row.id).filter(Boolean);
      if (ids.length) {
        await db.query(`UPDATE "${source}" SET id_roles_write = $1 WHERE id = ANY($2::uuid[])`, [roleWriteValue(req), ids]);
        r.rows.forEach((row) => { if ('id_roles_write' in row) row.id_roles_write = roleWriteValue(req); });
      }
      return r;
    };
    // Contenitore dello scope 'all': 'Cliente' al top-level, oppure il campo del Nodo Padre.
    const containerCampo = ((req.body && req.body.containerCampo) || 'Cliente').trim() || 'Cliente';
    // id_roles del nuovo campo (visibilità per ruolo); vuoto/assente = NULL (nessuna restrizione).
    const idRolesRaw = (req.body && req.body.id_roles);
    // Non admin: niente nuovi campi nelle impostazioni; in clienti/progetti id_roles del
    // campo = ruolo di chi lo crea (come id_roles_write).
    assertStructureSourceAllowed(req, source);
    const idRoles = !isAdminUser(req)
      ? Number(roleWriteValue(req))
      : ((idRolesRaw === '' || idRolesRaw == null) ? null : Number(idRolesRaw));
    if (!rawCampo) {
      return res.status(400).json({ error: 'nome campo richiesto' });
    }
    if (scope === 'this' && !clientId) {
      return res.status(400).json({ error: 'clientId richiesto' });
    }
    // Aggiungere un campo a un cliente/progetto/Nodo Padre modifica quell'oggetto:
    // il contenitore deve essere modificabile dal ruolo del contesto.
    if (EAV_UUID_RE.test(clientId)) await assertRowsWritable(req, db, source, [clientId]);

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

    // NUOVO CAMPO DENTRO UN NODO PADRE (tipo_valore = 0), per settings/clients/projects.
    // Il contenitore non è un nome ma una riga, e quella riga esiste una volta per ogni
    // (tenant, utente) — e per i clienti anche per ogni cliente: inserire un'unica riga
    // con argument = id del nodo lo renderebbe visibile solo a chi l'ha creato. Si ricostruisce
    // quindi la catena logica del contenitore e si crea un figlio sotto ogni nodo omologo.
    const containerChainRows = await eavContainerChain(source, clientId, req.user.tenant_id);
    const isNodeContainer = !!containerChainRows && containerChainRows.length > 1;
    if (containerChainRows && (source === 'settings' || isNodeContainer)) {
      const wantsAllTenants = (scope === 'all-tenants') || (tenantScope === 'all-tenants');
      if (wantsAllTenants && Number(req.user.id_roles) !== 1) {
        return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
      }
      const params = [];
      // 'all' (clienti/progetti) = lo stesso nodo dentro ogni contenitore: si vincola solo
      // l'ultimo livello. Altrimenti si vincola la catena intera, cioè quel nodo lì.
      const startIndex = (scope === 'all' && isNodeContainer) ? containerChainRows.length - 1 : 0;
      const j = eavChainSql(source, containerChainRows, startIndex, params, source !== 'settings');
      const conds = [...j.conds];
      if (!wantsAllTenants) {
        params.push(req.user.tenant_id);
        conds.push(`${j.alias}.tenant_id = $${params.length}`);
        // Le impostazioni hanno una riga per utente: il campo nasce per tutti gli utenti
        // del tenant, non solo per chi lo sta creando.
        if (source !== 'settings') {
          params.push(req.user.user_id);
          conds.push(`${j.alias}.user_id = $${params.length}`);
        }
      }
      params.push(campo);      const pCampo = params.length;
      params.push(tipoValore); const pTipo = params.length;
      params.push(tabella);    const pTab = params.length;
      params.push(colonna);    const pCol = params.length;
      params.push(variabDb);   const pVar = params.length;
      params.push(valore2);    const pVal2 = params.length;
      params.push(bandBase);   const pBase = params.length;
      params.push(idRoles);    const pRoles = params.length;
      // Ordinamento calcolato dentro ciascun nodo di destinazione, non globalmente.
      const bandClauseX = isStandard
        ? "AND x.campo NOT LIKE '(*)%' AND (x.ordinamento IS NULL OR x.ordinamento < 200)"
        : 'AND x.ordinamento >= 200';
      // Progetti: la riga richiede client_id, che il contenitore possiede già.
      const clientIdCol = source === 'projects' ? ', client_id' : '';
      const clientIdSel = source === 'projects' ? `, ${j.alias}.client_id` : '';
      const q = `INSERT INTO "${source}" (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles${clientIdCol})
                 SELECT ${j.alias}.id::text, $${pCampo}, $${pTipo}, $${pTab}, $${pCol}, $${pVar}, $${pVal2},
                        ${j.alias}.tenant_id, ${j.alias}.user_id,
                        COALESCE((SELECT MAX(x.ordinamento) + 1 FROM "${source}" x
                                   WHERE x.argument = ${j.alias}.id::text ${bandClauseX}), $${pBase}::integer),
                        $${pRoles}::smallint${clientIdSel}
                 FROM ${j.froms.join(', ')}
                 WHERE ${conds.join(' AND ')}`;
      const result = await insertField(q, params);
      return res.status(201).json({ inserted: result.rowCount });
    }

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
      const result = await insertField(q, p);
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
      const result = await insertField(q, params);
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
      const result = await insertField(
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
      const result = await insertField(
        `INSERT INTO projects (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles, client_id)
         VALUES ($1, $2, $3, $4, $5, $10, $11, $6, $7, $8, $9, $12) RETURNING *`,
        [clientId, campo, tipoValore, tabella, colonna, req.user.tenant_id, req.user.user_id, newOrd, idRoles, variabDb, valore2, projClientId]
      );
      return res.status(201).json(result.rows[0]);
    }

    const result = await insertField(
      `INSERT INTO "${source}" (argument, campo, tipo_valore, tabella, colonna, "VariabDB", valore2, tenant_id, user_id, ordinamento, id_roles)
       VALUES ($1, $2, $3, $4, $5, $10, $11, $6, $7, $8, $9) RETURNING *`,
      [clientId, campo, tipoValore, tabella, colonna, req.user.tenant_id, req.user.user_id, newOrd, idRoles, variabDb, valore2]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
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
    // Non admin: nelle impostazioni nessuna eliminazione; altrove solo campi custom "(*)".
    assertStructureSourceAllowed(req, source);
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
    // Solo i campi modificabili dal ruolo del contesto (id_roles_write).
    query += roleWriteSql(req, params, /"\s+f\s+USING/.test(query) ? 'f.' : '', null, source);
    const result = await db.query(query, params);
    res.json({ deleted: result.rowCount });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
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
    // Non admin: nelle impostazioni nessuna rinomina; altrove solo campi custom "(*)".
    assertStructureSourceAllowed(req, source);
    const custGuard = isAdmin ? '' : " AND campo LIKE '(*)%'";
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
      // Solo i campi modificabili dal ruolo del contesto (id_roles_write).
      query += roleWriteSql(req, params, /"\s+f\s+SET/.test(query) ? 'f.' : '', null, source);
      const result = await db.query(query, params);
      updated += result.rowCount;
    }
    res.json({ updated });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Riordino/spostamento campi (drag&drop): aggiorna ordinamento + layout_col (+ layout_span
// per i progetti) per campo. items = [{ campo, ordinamento, layout_col, layout_span }, ...].
// Ambito, in due dialetti (come per aggiungi/elimina/rinomina campo):
//  - Impostazioni: scope = 'this-tenant' | 'all-tenants' (solo admin id_roles=1);
//  - Clienti/Progetti: scope = 'this' | 'all' (contenitore) + tenantScope = 'this-tenant' | 'all-tenants'.
// Per compatibilità viene accettato 'all-tenants' su entrambi i parametri.
app.post('/api/:source(settings|clients|projects)/reorder-fields', requireAuth, async (req, res) => {
  try {
    const source = req.params.source;
    const argument = ((req.body && req.body.argument) || '').trim();
    const rawScope = (req.body && req.body.scope) || '';
    const tenantScope = (req.body && req.body.tenantScope) || 'this-tenant';
    const allTenants = (rawScope === 'all-tenants') || (tenantScope === 'all-tenants');
    // Ambito contenitore (solo clienti/progetti): 'all' = tutti i clienti/progetti.
    const containerScope = (rawScope === 'all') ? 'all' : 'this';
    let items = (req.body && req.body.items) || [];
    if (!argument) return res.status(400).json({ error: 'argument richiesto' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Nessun elemento' });
    const isAdmin = Number(req.user.id_roles) === 1;
    // Non admin: nelle impostazioni nessuno spostamento; in clienti/progetti si spostano solo
    // i campi custom "(*)", rinumerati nell'ordine ricevuto a partire da 200 (i campi
    // standard restano dove sono).
    assertStructureSourceAllowed(req, source);
    if (!isAdmin) {
      items = items
        .filter((it) => it && isCustomCampo(it.campo))
        .sort((a, b) => (Number(a.ordinamento) || 0) - (Number(b.ordinamento) || 0)
          || (Number(a.layout_col) || 0) - (Number(b.layout_col) || 0))
        .map((it, i) => ({ ...it, ordinamento: CUSTOM_ORD_BASE + i }));
      if (!items.length) return res.json({ updated: 0 });
    }
    if (allTenants && !isAdmin) {
      return res.status(403).json({ error: 'Solo un admin può agire su tutti i tenant' });
    }

    // Il contenitore può essere un nome (argomento delle impostazioni) oppure l'id di una
    // riga (Nodo Padre, o riga identità di cliente/progetto). Nel secondo caso l'id vale
    // solo qui: per raggiungere lo stesso contenitore negli altri tenant/utenti si ricostruisce
    // la catena logica dei "campo" fino alla radice.
    const chain = await eavContainerChain(source, argument, req.user.tenant_id);
    const isNodeContainer = !!chain && chain.length > 1;
    if (!chain && EAV_UUID_RE.test(argument)) {
      return res.status(400).json({ error: 'Contenitore non trovato' });
    }

    // layout_span (quante colonne occupa il campo) esiste su settings/clients/projects:
    // va salvato ovunque sia presente, non solo sui progetti.
    const sourceColumns = await getTableColumns(source);
    const spanSupported = sourceColumns.has('layout_span');

    let updated = 0;
    for (const it of items) {
      const campo = ((it && it.campo) || '').trim();
      if (!campo) continue;
      const ord = (it.ordinamento == null || it.ordinamento === '') ? null : parseInt(it.ordinamento, 10);
      const lay = (it.layout_col == null || it.layout_col === '') ? null : parseInt(it.layout_col, 10);
      const span = (!spanSupported || it.layout_span == null || it.layout_span === '')
        ? null : parseInt(it.layout_span, 10);
      // SET comune a tutte le varianti: i primi due segnaposto sono sempre ord/lay,
      // l'eventuale layout_span occupa il terzo.
      const setCols = ['ordinamento = $1', 'layout_col = $2'];
      const head = [ord, lay];
      if (span != null) { setCols.push('layout_span = $3'); head.push(span); }
      const set = setCols.join(', ');
      const n = head.length; // numero di segnaposto già usati dal SET

      let query, params;
      // Il contenitore è una riga (Nodo Padre o riga identità): si passa dalla catena
      // logica, così l'aggiornamento raggiunge il contenitore omologo di ogni utente/tenant
      // e non solo la riga con quell'id. 'all' vincola soltanto l'ultimo livello,
      // cioè lo stesso nodo dentro qualsiasi contenitore.
      // Restando nel proprio tenant su clienti/progetti l'id del contenitore è già preciso:
      // la catena serve alle impostazioni (righe per utente) e agli ambiti allargati.
      const useChain = !!chain && (
        source === 'settings'
        || (containerScope === 'this' && allTenants)
        || (containerScope === 'all' && isNodeContainer)
      );
      if (useChain) {
        params = [...head];
        const startIndex = (containerScope === 'all' && isNodeContainer) ? chain.length - 1 : 0;
        const j = eavChainSql(source, chain, startIndex, params, source !== 'settings');
        params.push(campo);
        let where = `${j.conds.join(' AND ')} AND f.argument = ${j.alias}.id::text AND f.campo = $${params.length}`;
        if (!allTenants) {
          params.push(req.user.tenant_id);
          where += ` AND f.tenant_id = $${params.length}`;
          // Impostazioni: le righe sono per utente, la disposizione vale per tutto il tenant.
          if (source !== 'settings') {
            params.push(req.user.user_id);
            where += ` AND f.user_id = $${params.length}`;
          }
        }
        query = `UPDATE "${source}" f SET ${set} FROM ${j.froms.join(', ')} WHERE ${where}`;
      } else if (source === 'settings') {
        if (allTenants) {
          // argument delle impostazioni è il nome dell'argomento: identico in ogni tenant.
          query = `UPDATE settings SET ${set} WHERE argument = $${n + 1} AND campo = $${n + 2}`;
          params = [...head, argument, campo];
        } else {
          query = `UPDATE settings SET ${set} WHERE argument = $${n + 1} AND campo = $${n + 2} AND tenant_id = $${n + 3}`;
          params = [...head, argument, campo, req.user.tenant_id];
        }
      } else if (allTenants) {
        query = `UPDATE "${source}" SET ${set} WHERE campo = $${n + 1}`;
        params = [...head, campo];
      } else if (containerScope === 'all') {
        query = `UPDATE "${source}" SET ${set} WHERE campo = $${n + 1} AND tenant_id = $${n + 2} AND user_id = $${n + 3}`;
        params = [...head, campo, req.user.tenant_id, req.user.user_id];
      } else {
        query = `UPDATE "${source}" SET ${set} WHERE argument = $${n + 1} AND campo = $${n + 2} AND tenant_id = $${n + 3}`;
        params = [...head, argument, campo, req.user.tenant_id];
      }
      // Solo i campi modificabili dal ruolo del contesto (id_roles_write).
      query += roleWriteSql(req, params, /"\s+f\s+SET/.test(query) ? 'f.' : '', null, source);
      const r = await db.query(query, params);
      updated += r.rowCount;
    }
    res.json({ updated });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
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
    // Le istruzioni vanno eseguite nell'ordine indicato da function_db.ordinamento
    // (dal numero più basso al più alto); le righe senza ordinamento vengono eseguite
    // per ultime, mantenendo comunque l'operazione deterministica.
    const fdb = await db.query(
      `SELECT * FROM function_db WHERE ${conds.join(' AND ')} ORDER BY ordinamento ASC NULLS LAST, id`,
      params
    );
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
        assertCanWriteTable(req, tab);
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

// Chiusura e riapertura del progetto: le può fare solo il proprietario, cioè l'utente del
// contesto deve essere lo user_id della riga del progetto (stesso tenant). L'Admin sempre.
async function assertProjectOwner(req, projectId, clientId) {
  if (isAdminUser(req)) return;
  const params = [projectId, req.user.tenant_id, req.user.user_id];
  let clientClause = '';
  if (clientId) { params.push(clientId); clientClause = ` AND client_id = $${params.length}`; }
  const r = await db.query(
    `SELECT 1 FROM projects
      WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3
        AND argument = 'Progetto' AND campo = 'Progetto'${clientClause}
      LIMIT 1`,
    params
  );
  if (!r.rows.length) {
    throw Object.assign(new Error('Solo il proprietario del progetto può chiuderlo o riaprirlo'), { statusCode: 403 });
  }
}

// Pulsante "Chiudi Progetto" nel dettaglio progetto: esegue l'istruzione configurata in
// function_db (cod_istruzione=3, istruzione='update', funzione='Chiudi Progetto') sul
// project_id/client_id correnti. Stessa logica/riuso del motore già usato per tipo_valore=15
// (fun_tabella/fun_colonna = UPDATE fun_colonna = ieri), estesa con fun_project (colonna su
// cui filtrare il project_id) e con il filtro client_id (colonna "client_id" se presente).
// Selezione della riga function_db: prima quella con tenant_id = tenant del login; se non
// esiste, quella di default con tenant_id IS NULL.
app.post('/api/projects/close', requireAuth, async (req, res) => {
  const projectId = ((req.body && req.body.projectId) || '').trim();
  const clientId = ((req.body && req.body.clientId) || '').trim();
  if (!projectId) return res.status(400).json({ error: 'projectId richiesto' });
  try {
    // Chiudere il progetto spetta al suo proprietario (user_id del progetto), qualunque sia
    // id_roles_write: quello vale per la modifica dei campi, non per chiusura/riapertura.
    await assertProjectOwner(req, projectId, clientId);
    const codIstruzione = 3;
    const funzione = 'Chiudi Progetto';

    let fdb = await db.query(
      `SELECT * FROM function_db WHERE cod_istruzione = $1 AND lower(istruzione) = 'update' AND funzione = $2 AND tenant_id = $3`,
      [codIstruzione, funzione, req.user.tenant_id]
    );
    if (fdb.rows.length === 0) {
      fdb = await db.query(
        `SELECT * FROM function_db WHERE cod_istruzione = $1 AND lower(istruzione) = 'update' AND funzione = $2 AND tenant_id IS NULL`,
        [codIstruzione, funzione]
      );
    }
    if (fdb.rows.length === 0) return res.json({ updated: 0, executed: 0 });

    const client = await db.connect();
    let updated = 0, executed = 0;
    try {
      await client.query('BEGIN');
      for (const r of fdb.rows) {
        const tab = r.fun_tabella, col = r.fun_colonna;
        if (!tab || !col) continue;
        assertValidIdentifier(tab);
        assertValidIdentifier(col);
        assertCanWriteTable(req, tab);
        const tcols = await getTableColumns(tab);
        if (tcols.size === 0) throw Object.assign(new Error('Tabella inesistente: ' + tab), { statusCode: 400 });
        if (!tcols.has(col)) throw Object.assign(new Error('Colonna inesistente: ' + col), { statusCode: 400 });

        // Colonna su cui filtrare il project_id: da fun_project, altrimenti 'project_id' se presente.
        let projCol = (r.fun_project || '').trim();
        if (!projCol && tcols.has('project_id')) projCol = 'project_id';
        if (!projCol) throw Object.assign(new Error('Colonna project_id non configurata (fun_project) per ' + tab), { statusCode: 400 });
        assertValidIdentifier(projCol);

        let tenCol = (r.fun_tenant || '').trim();
        if (!tenCol && tcols.has('tenant_id')) tenCol = 'tenant_id';
        let usrCol = (r.fun_user || '').trim();
        if (!usrCol && tcols.has('user_id')) usrCol = 'user_id';
        const cliCol = tcols.has('client_id') ? 'client_id' : '';

        const parts = [`"${projCol}" = $1`];
        const p = [projectId];
        if (tenCol) { assertValidIdentifier(tenCol); p.push(req.user.tenant_id); parts.push(`"${tenCol}" = $${p.length}`); }
        if (usrCol) { assertValidIdentifier(usrCol); p.push(req.user.user_id); parts.push(`"${usrCol}" = $${p.length}`); }
        if (cliCol && clientId) { p.push(clientId); parts.push(`"${cliCol}" = $${p.length}`); }

        const rr = await client.query(
          `UPDATE "${tab}" SET "${col}" = CURRENT_DATE - INTERVAL '1 day' WHERE ${parts.join(' AND ')}`,
          p
        );
        updated += rr.rowCount;
        executed++;
      }
      await client.query('COMMIT');
      res.json({ updated, executed });
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

// Riapre un progetto chiuso impostando al 31/12/2099 la scadenza della riga
// identita e di tutte le righe EAV discendenti, a qualunque livello di argument.
// La CTE ricorsiva mantiene l'operazione limitata al tenant, all'utente e al cliente
// del progetto autenticato; UNION evita cicli in caso di dati gerarchici anomali.
app.post('/api/projects/reopen', requireAuth, async (req, res) => {
  const projectId = String((req.body && req.body.projectId) || '').trim();
  const clientId = String((req.body && req.body.clientId) || '').trim();
  if (!projectId) return res.status(400).json({ error: 'projectId richiesto' });
  if (!clientId) return res.status(400).json({ error: 'clientId richiesto' });

  try {
    // Riaprire il progetto spetta al suo proprietario (user_id del progetto), come la chiusura.
    await assertProjectOwner(req, projectId, clientId);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH RECURSIVE project_tree(id) AS (
         SELECT id
         FROM projects
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3
           AND client_id = $4
           AND argument = 'Progetto'
           AND campo = 'Progetto'
           AND scadenza < CURRENT_DATE
         UNION
         SELECT child.id
         FROM projects child
         JOIN project_tree parent ON child.argument = parent.id::text
         WHERE child.tenant_id = $2
           AND child.user_id = $3
           AND child.client_id = $4
       )
       UPDATE projects p
       SET scadenza = DATE '2099-12-31'
       WHERE p.id IN (SELECT id FROM project_tree)
       RETURNING p.id`,
      [projectId, req.user.tenant_id, req.user.user_id, clientId]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Progetto non trovato o non autorizzato' });
    }
    await client.query('COMMIT');
    res.json({ updated: result.rowCount, scadenza: '2099-12-31' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { /* ignore */ }
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    client.release();
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
    if (clientId) {
      const clientIdColumn = cols.has('client_id') ? 'client_id' : cols.has('id_cliente') ? 'id_cliente' : null;
      if (clientIdColumn) { params.push(clientId); conds.push(`"${clientIdColumn}" = $${params.length}`); }
    }
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
    if (clientId) {
      const clientIdColumn = cols.has('client_id') ? 'client_id' : cols.has('id_cliente') ? 'id_cliente' : null;
      if (clientIdColumn) { params.push(clientId); conds.push(`"${clientIdColumn}" = $${params.length}`); }
    }
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
    assertCanWriteTable(req, tabella);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    const generated = await getGeneratedColumns(tabella);
    // crypto: lo decide il server (sempre 1), mai il browser: con 0 la riga non verrebbe cifrata.
    const managedByServer = new Set(['id', 'tenant_id', 'user_id', 'id_cliente', 'client_id', 'created_at', 'updated_at', 'created_by', 'crypto']);
    let data = {};
    for (const [k, v] of Object.entries(values)) {
      if (cols.has(k) && !generated.has(k) && !managedByServer.has(k)) {
        data[k] = v === '' ? null : v;
      }
    }
    // Colonne di scoping impostate dal server (mai dal client)
    if (cols.has('tenant_id')) data.tenant_id = req.user.tenant_id;
    if (cols.has('user_id')) data.user_id = req.user.user_id;
    if (clientId) {
      const clientIdColumn = cols.has('client_id') ? 'client_id' : cols.has('id_cliente') ? 'id_cliente' : null;
      if (clientIdColumn) data[clientIdColumn] = clientId;
    }
    // Nuova riga: modificabile dal ruolo di chi la crea.
    stampRoleWrite(req, data, cols);
    if (cols.has('crypto')) data.crypto = 1;

    data = await cryptoWrite(db, 'main', tabella, data);

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
    assertCanWriteTable(req, tabella);
    if (!(await isManagedTable(tabella))) return res.status(404).json({ error: 'Tabella non gestita' });

    const cols = await getTableColumns(tabella);
    await assertRowsWritable(req, db, tabella, [rowId], cols);
    const conds = ['id = $1'];
    const params = [rowId];
    if (cols.has('tenant_id')) { params.push(req.user.tenant_id); conds.push(`tenant_id = $${params.length}`); }
    if (cols.has('user_id')) { params.push(req.user.user_id); conds.push(`user_id = $${params.length}`); }
    if (clientId) {
      const clientIdColumn = cols.has('client_id') ? 'client_id' : cols.has('id_cliente') ? 'id_cliente' : null;
      if (clientIdColumn) { params.push(clientId); conds.push(`"${clientIdColumn}" = $${params.length}`); }
    }
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
    // Un progetto chiuso puo essere consultato integralmente in sola lettura quando
    // il frontend richiede includeExpired=1. Gli stessi filtri di ownership restano
    // obbligatori, quindi l'opzione non amplia il perimetro tenant/utente/cliente.
    const includeExpired = table === 'projects'
      && ['1', 'true'].includes(String(req.query && req.query.includeExpired).toLowerCase());
    const expiryClause = includeExpired ? '' : 'AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)';
    const result = await db.query(
      `SELECT * FROM "${table}"
       WHERE argument = $1 AND tenant_id = $2 AND user_id = $3
         AND (id_roles IS NULL OR id_roles >= $4)
         ${expiryClause}
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
    // Contenitore (cliente/progetto/Nodo Padre): se non è modificabile dal ruolo del
    // contesto, il browser nasconde aggiungi/elimina/rinomina/sposta campi.
    let containerWritable = true;
    if (EAV_UUID_RE.test(String(argument))) {
      const c = await db.query(`SELECT id_roles_write FROM "${table}" WHERE id = $1 LIMIT 1`, [argument]);
      if (c.rows[0]) containerWritable = canWriteRow(req, c.rows[0].id_roles_write, table);
    }
    res.set('X-Can-Write-Container', containerWritable ? '1' : '0');

    const rows = result.rows;
    for (const row of rows) {
      // Permesso per riga: il campo è modificabile solo se id_roles_write = ruolo del contesto.
      row.__can_write = canWriteRow(req, row.id_roles_write, table);
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

      // Tipo 17 (scelta singola) e 18 (multi-selezione): le opzioni sono lette da
      // tabella.colonna (settings/clients/projects.tabella / .colonna), filtrate per
      // tenant_id/user_id e, quando la tabella li possiede, client_id/project_id del
      // contesto corrente (stessa risoluzione già usata per il tipo 4, vedi
      // referenceKeys). VariabDB è una condizione SQL aggiuntiva configurata da un
      // utente privilegiato (non input dell'utente finale) ed è sempre aggiunta in AND
      // dopo i filtri di contesto. Il valore selezionato è salvato su valore2 (tipo 17:
      // il valore così com'è; tipo 18: più valori uniti da ", "), nessun endpoint di
      // scrittura dedicato: usa la normale PUT /api/data/:table/:id.
      if ((Number(row.tipo_valore) === 17 || Number(row.tipo_valore) === 18) && row.tabella && row.colonna) {
        const optionsProp = Number(row.tipo_valore) === 18 ? 'tipo18_options' : 'tipo17_options';
        try {
          assertValidIdentifier(row.tabella);
          assertValidIdentifier(row.colonna);
          const keys = await referenceKeys(row.tabella, req.user, { clientId: clientContextId, projectId: projectContextId });
          const params = keys.map(k => k.val);
          const conds = keys.map((k, i) => `"${k.col}" = $${i + 1}`);
          let where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
          const variab = (row.VariabDB || '').trim();
          if (variab) {
            where = where
              ? `${where} ${variab}`
              : 'WHERE ' + variab.replace(/^\s*(and|or)\s+/i, '');
          }
          // Colonna foreign key (es. licenze_app.licenza_id -> conf_licenze_app.id): al posto
          // dell'id si mostra (e si salva in valore2) la descrizione della tabella collegata.
          // Sottoquery per non rendere ambigue le colonne di VariabDB (es. scadenza).
          const fk = (await db.query(
            `SELECT ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
                AND tc.table_name = $1 AND kcu.column_name = $2
              LIMIT 1`,
            [row.tabella, row.colonna]
          )).rows[0];
          let sql = `SELECT DISTINCT "${row.colonna}" AS v FROM "${row.tabella}" ${where} ORDER BY "${row.colonna}" NULLS LAST LIMIT 500`;
          if (fk) {
            const foreignTable = assertValidIdentifier(fk.foreign_table);
            const foreignColumn = assertValidIdentifier(fk.foreign_column);
            const foreignColumns = await getTableColumns(foreignTable);
            const displayColumn = [...foreignColumns].find(name => /^desc_/i.test(name))
              || ['description', 'descrizione', 'nominativo', 'name', 'nome', 'title', 'label', 'valore2', 'commessa'].find(name => foreignColumns.has(name));
            if (displayColumn) {
              assertValidIdentifier(displayColumn);
              sql = `SELECT "${displayColumn}" AS v FROM "${foreignTable}"
                      WHERE "${foreignColumn}" IN (SELECT "${row.colonna}" FROM "${row.tabella}" ${where})
                      LIMIT 500`;
            }
          }
          const opts = await db.query(sql, params);
          // Deduplica e ordina dopo la lettura: le descrizioni possono essere cifrate sul DB.
          row[optionsProp] = [...new Set(opts.rows.map(r => r.v)
            .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
            .map(v => (fk ? String(v).trim() : v)))]
            .sort((a, b) => (fk ? String(a).localeCompare(String(b), 'it', { sensitivity: 'base' }) : 0));
        } catch (e) {
          row[optionsProp] = [];
          console.error(`[TIPO ${row.tipo_valore}] Errore risoluzione opzioni:`, e.message);
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

// ==========================================
// CAMPI TIPO 4 (Database) DEI PROGETTI: valore copiato in valore2
// ==========================================
// Un campo tipo 4 mostra il valore letto da tabella.colonna (riga di tenant/utente/cliente/
// progetto + VariabDB). Dopo ogni salvataggio dei dati di un progetto o di una sua griglia
// lo stesso valore si scrive anche in valore2 del campo, così lo leggono le altre funzioni
// (Offerta economica, Kick-off, Reporting, condizioni della Check List...). Si ricalcolano
// tutti i campi tipo 4 del progetto, anche dentro le sezioni; si scrive solo se il valore è
// cambiato (cifrato se la riga lo è). In background, raggruppando i salvataggi ravvicinati.
const tipo4InAttesa = new Map(); // "tenant|utente|progetto" -> timer

// Progetto (riga identità argument = campo = 'Progetto') a cui appartiene una riga di projects.
async function tipo4ProgettoDi(tenantId, userId, rowId) {
  let id = String(rowId || '');
  for (let i = 0; i < 8 && EAV_UUID_RE.test(id); i++) {
    const r = (await db.query(
      'SELECT id::text AS id, argument, campo, client_id FROM projects WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1',
      [id, tenantId, userId]
    )).rows[0];
    if (!r) return null;
    if (r.argument === 'Progetto' && r.campo === 'Progetto') return { projectId: r.id, clientId: r.client_id };
    id = String(r.argument || '');
  }
  return null;
}

const tipo4Testo = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};

async function tipo4AllineaProgetto(user, projectId, clientId) {
  const ids = (await db.query(
    `WITH RECURSIVE albero(id, livello) AS (
       SELECT id, 0 FROM projects WHERE id::text = $1
       UNION ALL
       SELECT p.id, a.livello + 1 FROM projects p JOIN albero a ON p.argument = a.id::text
        WHERE p.tenant_id = $2 AND p.user_id = $3 AND a.livello < 6 AND p.tipo_valore::text = '0'
     )
     SELECT id::text AS id FROM albero`,
    [projectId, user.tenant_id, user.user_id]
  )).rows.map((x) => x.id);
  const campi = (await db.query(
    `SELECT id, tabella, colonna, "VariabDB" AS variabdb, valore2::text AS valore2, client_id
       FROM projects
      WHERE tenant_id = $1 AND user_id = $2 AND argument = ANY($3::text[]) AND tipo_valore::text = '4'
        AND tabella IS NOT NULL AND colonna IS NOT NULL
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
    [user.tenant_id, user.user_id, ids]
  )).rows;
  let scritti = 0;
  for (const c of campi) {
    try {
      const tabella = assertValidIdentifier(String(c.tabella).trim());
      const colonna = assertValidIdentifier(String(c.colonna).trim());
      // Stessa lettura della scheda (GET dei campi), con il progetto vero come contesto.
      const keys = await referenceKeys(tabella, user, { clientId: c.client_id || clientId, projectId });
      let where = keys.length ? 'WHERE ' + keys.map((k, i) => `"${k.col}" = $${i + 1}`).join(' AND ') : '';
      const variab = String(c.variabdb || '').trim();
      if (variab) where = where ? `${where} ${variab}` : 'WHERE ' + variab.replace(/^\s*(and|or)\s+/i, '');
      const ref = await db.query(`SELECT "${colonna}" AS v FROM "${tabella}" ${where} LIMIT 1`, keys.map((k) => k.val));
      const nuovo = tipo4Testo(ref.rows[0] ? ref.rows[0].v : null);
      if ((nuovo ?? '') === (c.valore2 ?? '')) continue;
      const dati = await cryptoWrite(db, 'main', 'projects', { valore2: nuovo }, c.id);
      const cols = Object.keys(dati).filter((k) => k === 'valore2' || k === 'crypto');
      await db.query(
        `UPDATE projects SET ${cols.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
        [...cols.map((k) => dati[k]), c.id]
      );
      scritti += 1;
    } catch (e) {
      console.warn(`[TIPO 4] campo ${c.id}: valore non aggiornato (${e.message})`);
    }
  }
  if (scritti) console.log(`[TIPO 4] progetto ${projectId}: ${scritti} campi Database copiati in valore2`);
  return scritti;
}

// Da chiamare dopo un salvataggio riuscito che riguarda una riga di projects (campo o griglia).
function tipo4DopoSalvataggio(req, rowId) {
  const user = { tenant_id: req.user.tenant_id, user_id: req.user.user_id };
  (async () => {
    const prog = await tipo4ProgettoDi(user.tenant_id, user.user_id, rowId);
    if (!prog) return;
    const k = `${user.tenant_id}|${user.user_id}|${prog.projectId}`;
    clearTimeout(tipo4InAttesa.get(k));
    tipo4InAttesa.set(k, setTimeout(() => {
      tipo4InAttesa.delete(k);
      tipo4AllineaProgetto(user, prog.projectId, prog.clientId).catch((e) => console.warn('[TIPO 4]', e.message));
    }, 800));
  })().catch((e) => console.warn('[TIPO 4]', e.message));
}
// Aggancio: a risposta inviata con esito positivo.
function tipo4AFineRisposta(req, res, rowId) {
  if (!rowId) return;
  res.on('finish', () => { if (res.statusCode < 400) tipo4DopoSalvataggio(req, rowId); });
}

// Salvataggio di un campo di tipo 4 (riferimento a un'altra tabella) per settings, clients o projects.
// Prima di scrivere il valore nella tabella di riferimento, verifica che non esista già
// nella colonna <colonna> della tabella <tabella> indicate nella riga (per lo stesso contesto:
// tenant/user, +client_id se "clients", +client_id/project_id se "projects", + eventuale VariabDB).
app.put('/api/:source(settings|clients|projects)/:id/reference-value', requireAuth, async (req, res) => {
  // Campo tipo 4 di un progetto modificato: il suo valore (e degli altri) va in valore2.
  if (req.params.source === 'projects') tipo4AFineRisposta(req, res, req.params.id);
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
    // Permesso per riga: il campo deve essere modificabile dal ruolo del contesto.
    if (!canWriteRow(req, row.id_roles_write, table)) return res.status(403).json({ error: READ_ONLY_ERROR });
    const { tabella, colonna } = row;
    if (!tabella || !colonna) {
      return res.status(400).json({ error: 'Tabella o colonna non definite per questa impostazione' });
    }

    // Valida gli identificatori prima di interpolarli (anti SQL injection)
    assertValidIdentifier(tabella);
    assertValidIdentifier(colonna);
    // Consentite anche users/tenants: la scrittura tocca solo la riga del login (Profilo).
    assertCanWriteTable(req, tabella, 'main', { ownRowOnly: true });

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

    // Cifratura a riposo: se la tabella di riferimento ha la colonna crypto e la riga
    // di contesto è marcata crypto = 1, il valore viene scritto cifrato (a video resta
    // in chiaro perché la lettura passa dal pool che decifra).
    let valueToWrite = value === '' ? null : value;
    if (valueToWrite !== null && valueToWrite !== undefined) {
      // Stessa condizione di identityWhere ma con i segnaposto a partire da $1.
      let identityWhereFrom1 = keys.map((k, i) => `"${k.col}" = $${i + 1}`).join(' AND ');
      if (variab) {
        identityWhereFrom1 = identityWhereFrom1
          ? `${identityWhereFrom1} ${variab}`
          : variab.replace(/^\s*(and|or)\s+/i, '');
      }
      try {
        const cur = await db.query(
          `SELECT crypto FROM "${tabella}" WHERE ${identityWhereFrom1} LIMIT 1`,
          keyValues
        );
        if (cur.rows.length > 0) {
          const enc = await cryptoWrite(db, 'main', tabella, { [colonna]: valueToWrite, crypto: cur.rows[0].crypto });
          valueToWrite = enc[colonna];
        }
      } catch (e) { /* tabella senza colonna crypto: si scrive in chiaro */ }
    }

    // Scrive il valore nella tabella di riferimento, sulla riga del login/contesto
    const upd = await db.query(
      `UPDATE "${tabella}" SET "${colonna}" = $1 WHERE ${identityWhere} RETURNING "${colonna}" AS v`,
      [valueToWrite, ...keyValues]
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
// GDPR — Diritto alla cancellazione (art. 17): solo richiesta al team Projexa
// ==========================================

// Privacy e dati personali (dashboard): l'utente NON cancella da solo l'account (i dati
// di clienti, progetti, task e riunioni sono dell'azienda). Invia una richiesta che arriva
// per email alla casella del team Projexa (da Projexa a Projexa) e viene gestita entro
// 30 giorni (art. 17 GDPR). L'invio resta nel log email (tipo richiesta_cancellazione).
// Esportazione dei dati e cancellazione automatica sono state tolte il 2026-10-02.
const ultimaRichiestaCancellazione = new Map(); // user_id -> ms (una richiesta ogni 10 minuti)
app.post('/api/gdpr/richiesta-cancellazione', requireAuth, async (req, res) => {
  try {
    const uid = req.user.user_id;
    const prec = ultimaRichiestaCancellazione.get(uid);
    if (prec && Date.now() - prec < 10 * 60 * 1000) {
      return res.status(429).json({ error: 'Richiesta già inviata pochi minuti fa: il team Projexa ti contatterà.' });
    }
    const motivo = String((req.body && req.body.motivo) || '').trim().slice(0, 2000);
    let nome = '';
    try {
      const u = (await db.query('SELECT name, cognome FROM users WHERE id = $1', [uid])).rows[0];
      if (u) nome = [u.name, u.cognome].filter(Boolean).join(' ');
    } catch (e) { /* nome non disponibile: si invia comunque */ }
    const quando = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const { html, text } = buildRichiestaCancellazioneEmail({
      nome, email: req.user.email, tenant: req.user.tenant_name, userId: uid, tenantId: req.user.tenant_id, motivo, quando
    });
    await sendMail({
      to: EMAIL_PROJEXA,
      subject: `Richiesta cancellazione account - ${nome || req.user.email || uid}`,
      html, text,
      log: { req, tipo: 'richiesta_cancellazione', userId: uid, tenantId: req.user.tenant_id }
    });
    ultimaRichiestaCancellazione.set(uid, Date.now());
    res.json({ inviata: true });
  } catch (error) {
    console.error('[GDPR] Richiesta di cancellazione non inviata:', error.message);
    res.status(502).json({ error: `Richiesta non inviata (${error.message}). Riprova più tardi o scrivi a ${EMAIL_PROJEXA}.` });
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

// ==========================================
// ISSUE ENDPOINTS (modulo Issue)
// Il client visualizza anche colonne tecniche/calcolate restituite da SELECT *.
// In modifica accettiamo esclusivamente i campi realmente editabili della griglia:
// colonne come id, tenant_id, crypto, created_at, updated_at e "giorni"
// (GENERATED ALWAYS) non devono mai finire nella UPDATE.
const ISSUE_EDITABLE_COLUMNS = new Set([
  'data_segnalazione', 'project_id', 'visibilita', 'modulo',
  'richiedente', 'categoria', 'stato', 'priorita', 'descrizione',
  'mysupport', 'tkt_jira', 'owner', 'deadline', 'note', 'data_chiusura'
]);
// ==========================================

// GET /api/auth/context - Dati del contesto autenticato (usato da js/issue.js per
// popolare userRole/contextUserId/contextTenantId). Endpoint mancante segnalato
// dalla guida di installazione: senza questo issue.js riceveva 404.
app.get('/api/auth/context', requireAuth, async (req, res) => {
  res.json({
    user_id: req.user.user_id,
    tenant_id: req.user.tenant_id,
    id_roles: req.user.id_roles,
    name: req.user.name
  });
});

// GET /api/issue/clients - Ottieni i clienti disponibili per l'utente corrente
app.get('/api/issue/clients', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const { tenant_id, user_id } = req.user;
    
    const result = await pool.query(
      `SELECT id, valore2 AS name FROM public.clients
       WHERE argument = 'Cliente' AND campo = 'Cliente'
         AND tenant_id = $1 AND user_id = $2 AND valore2 IS NOT NULL
       ORDER BY valore2`,
      [tenant_id, user_id]
    );
    
    res.json(result.rows);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/issue/options - Elenchi contestuali per modulo e richiedente
app.get('/api/issue/options', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const { tenant_id, user_id } = req.user;
    const { client_id } = req.query;

    if (!client_id) {
      return res.status(400).json({ error: 'client_id richiesto' });
    }

    await sincronizzaRubricaTenant(tenant_id); // rubrica condivisa: allinea prima di leggerla
    const [modulesResult, requestersResult, rubrica] = await Promise.all([
      // Moduli = licenze del cliente (licenze_app). Il nome non è più in licenze_app ma
      // nell'anagrafica collegata da licenza_id (conf_licenze_app.description). Il valore
      // salvato nella issue resta l'id della riga di licenze_app.
      pool.query(
        `SELECT la.id::text AS value, TRIM(cl.description::text) AS label
         FROM public.licenze_app la
         JOIN public.conf_licenze_app cl ON cl.id = la.licenza_id
         WHERE la.tenant_id = $1 AND la.user_id = $2 AND la.client_id = $3
           AND NULLIF(TRIM(cl.description::text), '') IS NOT NULL`,
        [tenant_id, user_id, client_id]
      ),
      pool.query(
        `SELECT id::text AS value, TRIM(nominativo::text) AS label
         FROM public.contacts
         WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3
           AND NULLIF(TRIM(nominativo::text), '') IS NOT NULL
         ORDER BY label, value`,
        [tenant_id, user_id, client_id]
      ),
      // Owner = contatto della rubrica (si salva rubrica.id). Anche i contatti scaduti,
      // così una issue già assegnata mostra ancora il nome; la UI propone solo gli attivi.
      koRubrica(req, { tutte: true, pool })
    ]);
    const oggi = new Date(new Date().toDateString());
    // "me" = contatto di rubrica con l'email dell'utente (confronto qui: l'email può essere cifrata)
    const myEmail = String(req.user.email || '').trim().toLowerCase();
    const me = myEmail ? rubrica.find(x => String(x.email || '').trim().toLowerCase() === myEmail) : null;

    res.json({
      // La UI mostra la label, ma il valore salvato nella tabella issue è l'UUID.
      // Ordinati dopo la lettura: i nomi possono essere cifrati nel database.
      moduli: modulesResult.rows.map(row => ({ value: row.value, label: String(row.label || '').trim() }))
        .filter(row => row.label)
        .sort((a, b) => a.label.localeCompare(b.label, 'it', { sensitivity: 'base' })),
      richiedenti: requestersResult.rows.map(row => ({ value: row.value, label: row.label })),
      owners: rubrica
        .map(x => ({
          value: x.id,
          label: String(x.nominativo || '').trim(),
          email: String(x.email || '').trim(),
          attivo: !x.scadenza || new Date(x.scadenza) >= oggi
        }))
        .filter(x => x.label)
        .sort((a, b) => a.label.localeCompare(b.label, 'it', { sensitivity: 'base' })),
      ownerMe: me ? me.id : null
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/issue/jira-lookup?codes=ADFPE-299/ADFPE-300 - Dati dei ticket Jira scritti in
// una issue. Per ogni codice si cerca prima in cl_quotazioni (colonna codice) e, se non
// c'è, in task_app (cod_task); tenant e utente del contesto. Il confronto si fa dopo la
// lettura perché i codici possono essere cifrati.
const JIRA_KEY_RE = /[A-Z][A-Z0-9_]+-\d+/gi;
const jiraKeys = (text) => [...new Set((String(text || '').match(JIRA_KEY_RE) || []).map((k) => k.toUpperCase()))];
const ISSUE_JIRA_FONTI = [
  { table: 'cl_quotazioni', column: 'codice', label: 'Quotazioni' },
  { table: 'task_app', column: 'cod_task', label: 'Task Jira' }
];
app.get('/api/issue/jira-lookup', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const codici = jiraKeys(req.query.codes).slice(0, 20);
    if (!codici.length) return res.status(400).json({ error: 'Nessun codice Jira valido' });

    const daTrovare = new Set(codici);
    const trovati = new Map(); // codice -> { fonte, righe }
    for (const fonte of ISSUE_JIRA_FONTI) {
      if (!daTrovare.size) break;
      const r = await pool.query(
        `SELECT * FROM public."${fonte.table}" WHERE tenant_id = $1 AND user_id = $2`,
        [req.user.tenant_id, req.user.user_id]
      );
      for (const row of r.rows) {
        for (const k of jiraKeys(row[fonte.column])) {
          if (!daTrovare.has(k)) continue;
          if (!trovati.has(k)) trovati.set(k, { fonte: fonte.label, righe: [] });
          if (trovati.get(k).fonte === fonte.label) trovati.get(k).righe.push(row);
        }
      }
      for (const k of trovati.keys()) daTrovare.delete(k);
    }

    // Solo colonne con dati, senza quelle tecniche (stesse regole del Reporting)
    const campi = (row) => Object.entries(row)
      .filter(([c, v]) => !REPORTING_HIDDEN_COLUMNS.has(c) && !isReportingAppoName(c)
        && v !== null && v !== undefined && String(v).trim() !== '')
      .map(([c, v]) => ({ campo: reportingColumnLabel(c), valore: v instanceof Date ? v.toISOString() : String(v) }));

    res.json(codici.map((codice) => {
      const t = trovati.get(codice);
      return t
        ? { codice, fonte: t.fonte, righe: t.righe.map(campi) }
        : { codice, fonte: null, righe: [] };
    }));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/issue - Ottieni le issue filtrate per cliente
app.get('/api/issue', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const { tenant_id, user_id, id_roles } = req.user;
    const { client_id } = req.query;
    
    if (!client_id) {
      return res.status(400).json({ error: 'client_id richiesto' });
    }
    
    // Verificare che l'utente ha accesso al cliente
    const clientCheck = await pool.query(
      `SELECT id FROM public.clients 
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [client_id, tenant_id, user_id]
    );
    
    if (clientCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accesso negato a questo cliente' });
    }
    
    const result = await pool.query(
      `SELECT * FROM public.issue 
       WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3
       ORDER BY data_segnalazione DESC`,
      [tenant_id, user_id, client_id]
    );
    
    res.json(result.rows);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/issue - Crea una nuova issue
app.post('/api/issue', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const { tenant_id, user_id, id_roles } = req.user;
    
    let data = { ...req.body };
    
    // Forza i valori di contesto
    data.tenant_id = tenant_id;
    data.user_id = user_id;
    
    // Valida che client_id esista e sia accessibile
    const clientCheck = await pool.query(
      `SELECT id FROM public.clients 
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [data.client_id, tenant_id, user_id]
    );
    
    if (clientCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Cliente non accessibile' });
    }
    
    // Imposta i valori di default. id_roles_write = ruolo di chi crea (l'admin può indicarlo).
    if (!data.id_roles_write || !isAdminUser(req)) data.id_roles_write = id_roles;
    if (!data.id_roles) data.id_roles = 70; // default role
    if (!data.visibilita) data.visibilita = 'Interna';
    if (!data.categoria) data.categoria = 'Richiesta';
    if (!data.stato) data.stato = 'Aperto';
    if (!data.priorita) data.priorita = 'Media';
    if (!data.scadenza) data.scadenza = '2099-12-31';
    if (!data.data_segnalazione) data.data_segnalazione = new Date().toISOString().split('T')[0];
    
    // Stringhe vuote diventano NULL
    for (const k of Object.keys(data)) {
      if (data[k] === '') data[k] = null;
    }

    // Cifra esclusivamente i campi previsti dalla policy della tabella issue
    // quando la riga ha crypto = 1 (richiedente, descrizione, owner e note).
    data = await cryptoWrite(pool, pickDbKey(req), 'issue', data);
    
    const columns = Object.keys(data).map(assertValidIdentifier);
    const values = columns.map(col => data[col]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const quotedColumns = columns.map(c => `"${c}"`).join(', ');
    
    const query = `INSERT INTO public.issue (${quotedColumns}) VALUES (${placeholders}) RETURNING *`;
    const result = await pool.query(query, values);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// PUT /api/issue/:id - Modifica un'issue
app.put('/api/issue/:id', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const { tenant_id, user_id, id_roles } = req.user;
    const issueId = req.params.id;
    
    let data = { ...req.body };
    delete data.id;
    delete data.tenant_id;
    delete data.user_id;
    delete data.client_id;
    data = Object.fromEntries(
      Object.entries(data).filter(([column]) => ISSUE_EDITABLE_COLUMNS.has(column))
    );
    
    // Recupera l'issue esistente
    const issueResult = await pool.query(
      `SELECT * FROM public.issue 
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [issueId, tenant_id, user_id]
    );
    
    if (issueResult.rows.length === 0) {
      return res.status(404).json({ error: 'Issue non trovata' });
    }
    
    const issue = issueResult.rows[0];
    
    // Permesso per riga: stessa regola di tutte le tabelle (id_roles_write = ruolo del
    // contesto, Admin sempre); solo l'admin può cambiare id_roles_write.
    if (!canWriteRow(req, issue.id_roles_write)) {
      return res.status(403).json({ error: 'Non hai i permessi per modificare questa issue' });
    }
    stripRoleWrite(req, data);
    
    // Stringhe vuote diventano NULL
    for (const k of Object.keys(data)) {
      if (data[k] === '') data[k] = null;
    }

    // Mantiene cifrati anche i valori modificati dopo la migrazione iniziale.
    data = await cryptoWrite(pool, pickDbKey(req), 'issue', data, issueId);
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    for (const [col, val] of Object.entries(data)) {
      assertValidIdentifier(col);
      updates.push(`"${col}" = $${paramCount}`);
      values.push(val);
      paramCount++;
    }
    
    if (updates.length === 0) {
      return res.json(issue);
    }
    
    values.push(issueId);
    const query = `UPDATE public.issue SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    const result = await pool.query(query, values);
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// DELETE /api/issue/:id - Elimina un'issue
app.delete('/api/issue/:id', requireAuth, async (req, res) => {
  try {
    const pool = pickDb(req);
    const { tenant_id, user_id, id_roles } = req.user;
    const issueId = req.params.id;
    
    // Recupera l'issue
    const issueResult = await pool.query(
      `SELECT * FROM public.issue 
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [issueId, tenant_id, user_id]
    );
    
    if (issueResult.rows.length === 0) {
      return res.status(404).json({ error: 'Issue non trovata' });
    }
    
    const issue = issueResult.rows[0];
    
    // Permesso per riga: stessa regola di tutte le tabelle (id_roles_write = ruolo del contesto).
    if (!canWriteRow(req, issue.id_roles_write)) {
      return res.status(403).json({ error: 'Non hai i permessi per eliminare questa issue' });
    }
    
    await pool.query(
      `DELETE FROM public.issue WHERE id = $1`,
      [issueId]
    );
    
    res.json({ success: true, message: 'Issue eliminata' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error Handler: il dettaglio tecnico resta nei log del server, non va al client.
// In sviluppo si include err.message per comodità di debug.
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  const body = { error: status === 400 ? 'Richiesta non valida' : 'Errore interno del server' };
  if (process.env.NODE_ENV !== 'production') body.message = err.message;
  res.status(status).json(body);
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Projexa API running on http://localhost:${PORT}`);
  let dbHost = '?';
  try { dbHost = new URL(resolveDbUrl('DATABASE_URL')).host; } catch { /* URL assente o non valido */ }
  console.log(`📊 Database: PostgreSQL su ${dbHost}`);
  console.log(`\n✓ Health check: http://localhost:${PORT}/api/health\n`);
  // Riprende i blocchi di trascrizione rimasti in coda (es. dopo un riavvio del server)
  kickTranscriptionWorker();
  // Monitor della VM (monitor.html): storico di CPU/memoria/rete dall'avvio (solo Linux).
  startVmSampler();
  // Job schedulati (tabella job_schedules): attivo solo con JOB_SCHEDULER_ENABLED=true (sulla VM).
  avviaScheduler();
  // Log accessi/variazioni: invio della coda audit_outbox a Oracle (solo con AUDIT_ORACLE_ENABLED=true).
  avviaInvioAudit();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down gracefully...');
  db.end((err) => {
    if (err) console.error('Error closing database:', err);
    process.exit(0);
  });
});
