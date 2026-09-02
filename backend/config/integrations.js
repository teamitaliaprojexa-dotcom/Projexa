// Accesso alla tabella integr_tok_auth (progetto Neon "Projexa-Auth"), dove vengono
// conservati i dati di autenticazione delle integrazioni esterne (Jira, ecc.).
//
// La tabella è in stile EAV: una riga per ogni "elemento" dell'integrazione
// (token, refresh token, email, url del sito...), così si possono aggiungere nuovi
// dati senza modificare lo schema.
//
//   user_id               -> utente Projexa (FK users.id di Projexa-Auth)
//   tipo_integrazione     -> dominio funzionale (es. 'issue_tracking')
//   provider_integrazione -> provider (es. 'Jira')
//   elemento              -> nome del dato (es. 'jira_refresh_token')
//   valore_alfa           -> valore (cifrato per i segreti, vedi sotto)
//   active / data_inzio / scadenza
//
// NB: la colonna della data di attivazione si chiama "data_inzio" (refuso già
// presente nel database): va scritta esattamente così.
import authDb from './authDatabase.js';
import { encryptValue, decryptValue, hasEncryptionKey } from './crypto.js';

// Elementi il cui valore è un segreto: sono SEMPRE cifrati a riposo con AES-256-GCM,
// a prescindere dalla colonna crypto della tabella.
const SECRET_ELEMENTS = new Set(['jira_access_token', 'jira_refresh_token']);

// La chiave è ENCRYPTION_KEY (config/crypto.js); INTEGR_ENC_KEY resta valida in
// decifratura per i token salvati prima dell'unificazione della chiave.
export function encryptSecret(plain) {
  if (plain == null) return null;
  if (!hasEncryptionKey()) {
    console.warn('⚠️  ENCRYPTION_KEY non impostata: i token delle integrazioni vengono salvati in chiaro.');
    return String(plain);
  }
  return encryptValue(plain);
}

export function decryptSecret(stored) {
  if (stored == null) return null;
  return decryptValue(String(stored));
}

// Vale 1 quando la tabella integr_tok_auth è stata portata in gestione cifrata
// ("Migrazione Crypto" sulla tabella): in quel caso TUTTI i valore_alfa vengono
// scritti cifrati, non solo i token. Letto una volta e tenuto in cache.
let cryptoTableFlag = null;
async function integrTableIsCrypto() {
  if (cryptoTableFlag !== null) return cryptoTableFlag;
  try {
    const r = await authDb.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'integr_tok_auth' AND column_name = 'crypto'`
    );
    if (r.rows.length === 0) { cryptoTableFlag = false; return false; }
    // Default della colonna a 1 -> la tabella nasce cifrata; in alternativa basta
    // che ci sia già almeno una riga marcata crypto = 1.
    const def = r.rows[0].column_default == null ? '' : String(r.rows[0].column_default);
    if (/^\s*'?(1|true)'?/i.test(def)) { cryptoTableFlag = true; return true; }
    const v = await authDb.query(
      `SELECT COUNT(*)::int AS n FROM integr_tok_auth WHERE crypto::text IN ('1','true','t')`
    );
    cryptoTableFlag = v.rows[0].n > 0;
  } catch (e) {
    cryptoTableFlag = false;
  }
  return cryptoTableFlag;
}

async function toStored(elemento, value) {
  if (value == null) return null;
  if (SECRET_ELEMENTS.has(elemento)) return encryptSecret(value);
  return (await integrTableIsCrypto()) ? encryptValue(String(value)) : String(value);
}

// NB: la lettura passa già dal pool che decifra automaticamente (config/cryptoPool.js).
// Questa funzione resta come rete di sicurezza per i valori non ancora decifrati.
function fromStored(elemento, value) {
  return typeof value === 'string' ? decryptValue(value) : value;
}

// Legge tutti gli elementi attivi di un'integrazione: { elemento: valore }.
export async function getIntegration(userId, provider) {
  const result = await authDb.query(
    `SELECT elemento, valore_alfa
       FROM integr_tok_auth
      WHERE user_id = $1 AND lower(provider_integrazione) = lower($2)
        AND (active IS DISTINCT FROM false)`,
    [userId, provider]
  );
  const out = {};
  for (const row of result.rows) {
    if (row.elemento) out[row.elemento] = fromStored(row.elemento, row.valore_alfa);
  }
  return out;
}

// Riscrive da zero l'integrazione: cancella le righe esistenti dell'utente/provider
// e inserisce quelle passate. `expiry` permette di dare una scadenza a singoli elementi
// (es. { jira_refresh_token: '2026-12-01' }).
export async function saveIntegration(userId, provider, tipo, elements, expiry = {}) {
  const client = await authDb.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM integr_tok_auth WHERE user_id = $1 AND lower(provider_integrazione) = lower($2)`,
      [userId, provider]
    );
    for (const [elemento, value] of Object.entries(elements)) {
      if (value === undefined) continue;
      await client.query(
        `INSERT INTO integr_tok_auth
           (user_id, tipo_integrazione, provider_integrazione, elemento, valore_alfa, active, data_inzio, scadenza)
         VALUES ($1, $2, $3, $4, $5, true, CURRENT_DATE, $6)`,
        [userId, tipo, provider, elemento, await toStored(elemento, value), expiry[elemento] || null]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Aggiorna (o crea, se mancanti) solo gli elementi indicati, lasciando intatti gli altri.
// Usata dal refresh del token, che riscrive access token, refresh token e scadenza.
export async function updateIntegrationElements(userId, provider, tipo, elements, expiry = {}) {
  const client = await authDb.connect();
  try {
    await client.query('BEGIN');
    for (const [elemento, value] of Object.entries(elements)) {
      if (value === undefined) continue;
      const stored = await toStored(elemento, value);
      const scadenza = expiry[elemento] || null;
      const upd = await client.query(
        `UPDATE integr_tok_auth
            SET valore_alfa = $1, active = true, scadenza = $2
          WHERE user_id = $3 AND lower(provider_integrazione) = lower($4) AND elemento = $5`,
        [stored, scadenza, userId, provider, elemento]
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO integr_tok_auth
             (user_id, tipo_integrazione, provider_integrazione, elemento, valore_alfa, active, data_inzio, scadenza)
           VALUES ($1, $2, $3, $4, $5, true, CURRENT_DATE, $6)`,
          [userId, tipo, provider, elemento, stored, scadenza]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Cancella tutte le righe dell'integrazione per quell'utente (disconnessione o
// disattivazione del flag in settings). Restituisce il numero di righe rimosse.
export async function deleteIntegration(userId, provider) {
  const result = await authDb.query(
    `DELETE FROM integr_tok_auth WHERE user_id = $1 AND lower(provider_integrazione) = lower($2)`,
    [userId, provider]
  );
  return result.rowCount;
}
