// ============================================================================
// CIFRATURA DEI DATI A RIPOSO (AES-256-GCM)
// ----------------------------------------------------------------------------
// Obiettivo: sul database i valori sono cifrati, mentre l'applicazione (e quindi
// il video) continua a mostrare testo e numeri in chiaro.
//
//   scrittura  -> l'endpoint cifra i valori previsti dalla regola (encryptRowForWrite)
//   lettura    -> il pool decifra automaticamente tutto ciò che ha il prefisso
//                 "enc:v1:" (vedi config/cryptoPool.js), quindi nessun endpoint
//                 di lettura va modificato.
//
// La chiave arriva dalla variabile d'ambiente ENCRYPTION_KEY (su Render e in
// locale nel .env). Può essere una passphrase qualsiasi: viene derivata a 32 byte
// con SHA-256. INTEGR_ENC_KEY resta accettata SOLO in decifratura, per non perdere
// i token Jira già salvati prima dell'introduzione di ENCRYPTION_KEY.
//
// ATTENZIONE: se la chiave cambia, i dati già cifrati non sono più leggibili.
// Prima di cambiarla usare "Migrazione Crypto" -> Decripta su tutte le tabelle.
// ============================================================================
import crypto from 'crypto';

export const ENC_PREFIX = 'enc:v1:';

// ----------------------------------------------------------------------------
// CHIAVI
// ----------------------------------------------------------------------------

function envKey(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

let cachedSignature = null;
let cachedEncKey = null;
let cachedDecKeys = [];

// Deriva 32 byte da qualunque passphrase: la env var può essere testo libero.
function derive(source) {
  return crypto.createHash('sha256').update(source).digest();
}

function refreshKeys() {
  const enc = envKey('ENCRYPTION_KEY');
  const legacy = envKey('INTEGR_ENC_KEY');
  const signature = enc + '|' + legacy;
  if (signature === cachedSignature) return;
  cachedSignature = signature;
  // Si CIFRA solo con ENCRYPTION_KEY. Svuotarla disattiva completamente la
  // cifratura in scrittura: è l'interruttore per tornare a scrivere in chiaro.
  cachedEncKey = enc ? derive(enc) : null;
  // Si DECIFRA anche con INTEGR_ENC_KEY, così i token Jira salvati prima
  // dell'unificazione della chiave restano leggibili.
  const seen = new Set();
  cachedDecKeys = [];
  for (const s of [enc, legacy]) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    cachedDecKeys.push(derive(s));
  }
}

function encryptionKey() {
  refreshKeys();
  return cachedEncKey;
}

function decryptionKeys() {
  refreshKeys();
  return cachedDecKeys;
}

// true se è configurata ENCRYPTION_KEY: senza di essa la cifratura è disattivata
// e i dati restano in chiaro (l'applicazione continua a funzionare).
export function hasEncryptionKey() {
  return encryptionKey() !== null;
}

// ----------------------------------------------------------------------------
// PRIMITIVE
// ----------------------------------------------------------------------------

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

// Cifra un valore. Restituisce "enc:v1:<iv>.<tag>.<dati>" (base64).
// Se manca la chiave restituisce il valore invariato (in chiaro).
export function encryptValue(plain) {
  if (plain === null || plain === undefined) return plain;
  const text = String(plain);
  if (isEncrypted(text)) return text; // già cifrato: non cifrare due volte
  const key = encryptionKey();
  if (!key) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

// Decifra un valore prodotto da encryptValue. I valori senza prefisso sono già in
// chiaro e vengono restituiti così come sono (convivenza dati cifrati/non cifrati).
// Se nessuna chiave riesce a decifrare, restituisce il valore grezzo: meglio un
// dato illeggibile a video che un errore che blocca l'intera pagina.
export function decryptValue(stored) {
  if (!isEncrypted(stored)) return stored;
  const [ivB64, tagB64, dataB64] = stored.slice(ENC_PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return stored;
  for (const key of decryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch (e) {
      // chiave sbagliata: prova la successiva
    }
  }
  console.error('❌ Decifratura fallita (ENCRYPTION_KEY mancante o cambiata).');
  return stored;
}

// Decifra ricorsivamente stringhe dentro oggetti/array (righe del DB, campi JSON).
export function decryptDeep(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return isEncrypted(value) ? decryptValue(value) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const d = decryptDeep(v, depth + 1);
      if (d !== v) changed = true;
      return d;
    });
    return changed ? out : value;
  }
  // Solo oggetti "semplici" (righe pg, JSON): mai Date, Buffer, ecc.
  if (typeof value === 'object' && (value.constructor === Object || value.constructor === undefined)) {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const d = decryptDeep(value[k], depth + 1);
      if (d !== value[k]) changed = true;
      out[k] = d;
    }
    return changed ? out : value;
  }
  return value;
}

// ============================================================================
// REGOLA: COSA VIENE CIFRATO
// ============================================================================
//
//  1) La tabella deve avere la colonna "crypto": senza quella colonna non si
//     cifra nulla. Si cifrano solo le righe con crypto = 1.
//  2) Non si cifrano MAI: UUID, date/timestamp, booleani, numeri, gli hash delle
//     password e le colonne di contesto tenant_id / user_id / client_id /
//     project_id (e in generale qualsiasi colonna *_id).
//  3) clients  -> solo valore2 e valore3
//     projects -> solo valore2
//  4) Tutte le altre tabelle: tutte le colonne testuali che superano il punto 2.
//
// NB (punto 2, numeri): un valore cifrato è testo, quindi una colonna numerica
// non può contenerlo. clients.valore3 è numeric(12,2): finché resta numeric viene
// SALTATA e la UI lo segnala. Per cifrarla davvero va convertita in text —
// istruzione pronta (commentata) in Supporto/CreaDB/crypto_migrazione.sql.
// ============================================================================

// Tipi Postgres che possono contenere il testo cifrato.
const TEXT_TYPES = new Set(['text', 'character varying', 'character']);

// Colonne mai cifrate, in qualunque tabella.
// Oltre alle chiavi tecniche ci sono le colonne "strutturali" dell'EAV
// (argument, campo, tabella, colonna, tipo_valore, ...): l'applicazione le usa
// dentro le WHERE con l'uguaglianza e, poiché la cifratura è randomizzata
// (IV casuale), cifrarle renderebbe impossibile ritrovare le righe.
const NEVER_ENCRYPT_COLUMNS = new Set([
  'id', 'crypto',
  'tenant_id', 'user_id', 'client_id', 'project_id',
  'created_by', 'created_at', 'updated_at',
  'password', 'password_hash',
  'argument', 'campo', 'tabella', 'colonna', 'tipo_valore', 'VariabDB',
  'id_roles', 'id_roles_write', 'table_name', 'is_active', 'active',
  'elemento', 'provider_integrazione', 'tipo_integrazione',
  'cod_istruzione', 'istruzione', 'funzione', 'fun_tenant', 'fun_user',
  'fun_tabella', 'fun_colonna'
]);

// Colonne mai cifrate solo in certe tabelle (chiavi di ricerca di quella tabella).
// users.email è la chiave del login: cifrarla impedirebbe l'accesso.
const NEVER_ENCRYPT_BY_TABLE = {
  users: new Set(['email', 'username'])
};

// Tabelle con elenco chiuso di colonne da cifrare (regola esplicita del punto 3).
const TABLE_COLUMN_ALLOWLIST = {
  clients: new Set(['valore2', 'valore3']),
  projects: new Set(['valore2'])
};

// Decide se una colonna è cifrabile e, in caso contrario, perché (serve alla UI).
export function columnDecision(tableName, columnName, dataType) {
  const allowlist = TABLE_COLUMN_ALLOWLIST[tableName];
  if (allowlist && !allowlist.has(columnName)) {
    return { encrypt: false, reason: `non prevista per la tabella ${tableName}` };
  }
  if (NEVER_ENCRYPT_COLUMNS.has(columnName)) {
    return { encrypt: false, reason: 'colonna chiave/di sistema' };
  }
  if ((NEVER_ENCRYPT_BY_TABLE[tableName] || new Set()).has(columnName)) {
    return { encrypt: false, reason: 'colonna usata per la ricerca (login/lookup)' };
  }
  if (/_id$/.test(columnName)) {
    return { encrypt: false, reason: 'riferimento a un\'altra tabella (*_id)' };
  }
  if (/hash/i.test(columnName) || /password/i.test(columnName)) {
    return { encrypt: false, reason: 'hash/password' };
  }
  if (!TEXT_TYPES.has(dataType)) {
    return { encrypt: false, reason: `tipo ${dataType} (solo le colonne testuali possono contenere il cifrato)` };
  }
  return { encrypt: true, reason: '' };
}

// ----------------------------------------------------------------------------
// METADATI DELLE TABELLE (con cache per database)
// ----------------------------------------------------------------------------

const policyCache = new Map(); // "dbKey:tabella" -> policy

export function clearCryptoPolicyCache() {
  policyCache.clear();
}

// Analizza una tabella e restituisce:
//   hasCryptoColumn : la tabella ha la colonna "crypto"
//   cryptoDefault   : valore di default della colonna crypto (per le nuove righe)
//   encryptColumns  : colonne che verranno cifrate
//   skipped         : [{ column, reason }] colonne escluse (mostrate nella UI)
//   textColumns     : tutte le colonne testuali (usate in decifratura)
//   hasId           : la tabella ha una colonna "id" (chiave per gli UPDATE)
export async function getCryptoPolicy(pool, tableName, dbKey = 'main') {
  const cacheKey = `${dbKey}:${tableName}`;
  if (policyCache.has(cacheKey)) return policyCache.get(cacheKey);

  const meta = await (pool.rawQuery || pool.query).call(
    pool,
    `SELECT column_name, data_type, column_default, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );

  const policy = {
    table: tableName,
    hasCryptoColumn: false,
    cryptoDefault: 0,
    hasId: false,
    encryptColumns: [],
    textColumns: [],
    skipped: []
  };

  for (const r of meta.rows) {
    const name = r.column_name;
    if (name === 'id') policy.hasId = true;
    if (name === 'crypto') {
      policy.hasCryptoColumn = true;
      const def = r.column_default == null ? '' : String(r.column_default);
      policy.cryptoDefault = /^\s*'?(1|true)'?/i.test(def) ? 1 : 0;
      continue;
    }
    // Colonne GENERATE (GENERATED ALWAYS AS ... STORED): Postgres non permette di
    // scriverle, quindi non possono essere né cifrate né decifrate.
    const generated = r.is_generated === 'ALWAYS';
    if (TEXT_TYPES.has(r.data_type) && !generated) policy.textColumns.push(name);

    const decision = generated
      ? { encrypt: false, reason: 'colonna generata (non scrivibile)' }
      : columnDecision(tableName, name, r.data_type);

    if (decision.encrypt) {
      policy.encryptColumns.push(name);
    } else if (generated && TEXT_TYPES.has(r.data_type) && columnDecision(tableName, name, r.data_type).encrypt) {
      policy.skipped.push({ column: name, reason: decision.reason });
    } else if (/^(numeric|integer|smallint|bigint|real|double precision)/.test(r.data_type)) {
      // Nella UI si segnalano solo le esclusioni "interessanti", cioè le colonne
      // numeriche (es. clients.valore3): sono dati che ci si aspetterebbe di vedere
      // cifrati, ma una colonna numerica non può contenere il testo cifrato.
      // Le colonne tecniche (uuid, date, booleani, chiavi) non si elencano.
      if (!/non prevista per la tabella/.test(decision.reason)) {
        policy.skipped.push({ column: name, reason: decision.reason });
      }
    }
  }

  policyCache.set(cacheKey, policy);
  return policy;
}

// ----------------------------------------------------------------------------
// SCRITTURA: cifra i valori di una riga prima di INSERT/UPDATE
// ----------------------------------------------------------------------------

function truthyFlag(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 't' || s === 'si' || s === 'sì') return 1;
  if (s === '0' || s === 'false' || s === 'f' || s === 'no') return 0;
  return null;
}

// Determina se la riga che si sta scrivendo va cifrata:
//   - se il payload contiene "crypto", vince quello (l'utente lo sta impostando);
//   - in UPDATE si legge il valore attuale della riga;
//   - in INSERT sulle tabelle EAV (settings/clients/projects) si eredita il flag
//     dalle righe sorelle dello stesso contenitore (argument), così i campi
//     aggiunti dopo la migrazione seguono le altre righe del cliente/progetto;
//   - altrimenti vale il DEFAULT della colonna crypto.
async function resolveCryptoFlag(pool, tableName, policy, data, { id = null } = {}) {
  const fromPayload = truthyFlag(data.crypto);
  if (fromPayload !== null) return fromPayload;

  const q = (pool.rawQuery || pool.query).bind(pool);

  if (id) {
    try {
      const r = await q(`SELECT crypto FROM "${tableName}" WHERE id = $1 LIMIT 1`, [id]);
      const cur = truthyFlag(r.rows[0]?.crypto);
      if (cur !== null) return cur;
    } catch (e) { /* tabella senza id o riga assente: si prosegue con il default */ }
  } else if (['settings', 'clients', 'projects'].includes(tableName) && data.argument) {
    try {
      const cond = ['argument = $1'];
      const params = [data.argument];
      if (data.tenant_id) { params.push(data.tenant_id); cond.push(`tenant_id = $${params.length}`); }
      const r = await q(
        `SELECT MAX(crypto) AS f FROM "${tableName}" WHERE ${cond.join(' AND ')}`,
        params
      );
      const inherited = truthyFlag(r.rows[0]?.f);
      if (inherited !== null) return inherited;
    } catch (e) { /* si prosegue con il default */ }
  }

  return policy.cryptoDefault;
}

// Cifra in-place (su una copia) i valori cifrabili di `data`.
// Restituisce { data, encrypted: n, cryptoFlag }.
// Se la tabella non ha la colonna crypto, o manca la chiave, i dati non vengono toccati.
export async function encryptRowForWrite(pool, tableName, data, { id = null, dbKey = 'main' } = {}) {
  if (!data || typeof data !== 'object') return { data, encrypted: 0, cryptoFlag: 0 };
  if (!hasEncryptionKey()) return { data, encrypted: 0, cryptoFlag: 0 };

  let policy;
  try {
    policy = await getCryptoPolicy(pool, tableName, dbKey);
  } catch (e) {
    return { data, encrypted: 0, cryptoFlag: 0 }; // metadati non leggibili: non bloccare la scrittura
  }
  if (!policy.hasCryptoColumn || policy.encryptColumns.length === 0) {
    return { data, encrypted: 0, cryptoFlag: 0 };
  }

  const flag = await resolveCryptoFlag(pool, tableName, policy, data, { id });
  if (!flag) return { data, encrypted: 0, cryptoFlag: 0 };

  const out = { ...data };
  let encrypted = 0;
  for (const col of policy.encryptColumns) {
    if (!Object.prototype.hasOwnProperty.call(out, col)) continue;
    const v = out[col];
    if (v === null || v === undefined || v === '' || isEncrypted(v)) continue;
    out[col] = encryptValue(v);
    encrypted += 1;
  }
  // Se abbiamo cifrato qualcosa, la riga deve risultare marcata crypto = 1.
  if (encrypted > 0 && truthyFlag(out.crypto) === null) out.crypto = 1;

  return { data: out, encrypted, cryptoFlag: flag };
}
