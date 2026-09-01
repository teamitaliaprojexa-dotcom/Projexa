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
import crypto from 'crypto';
import authDb from './authDatabase.js';

// Elementi il cui valore è un segreto: vengono cifrati a riposo con AES-256-GCM
// se è configurata la variabile d'ambiente INTEGR_ENC_KEY.
const SECRET_ELEMENTS = new Set(['jira_access_token', 'jira_refresh_token']);

const ENC_PREFIX = 'enc:v1:';

function encryptionKey() {
  const source = process.env.INTEGR_ENC_KEY || '';
  if (!source) return null;
  // Deriva 32 byte da qualunque passphrase, così la env var può essere un testo libero.
  return crypto.createHash('sha256').update(source).digest();
}

// Cifra un segreto. Senza INTEGR_ENC_KEY il valore resta in chiaro (con un avviso):
// l'integrazione continua a funzionare, ma è vivamente consigliato impostare la chiave.
export function encryptSecret(plain) {
  if (plain == null) return null;
  const key = encryptionKey();
  if (!key) {
    console.warn('⚠️  INTEGR_ENC_KEY non impostata: i token delle integrazioni vengono salvati in chiaro.');
    return String(plain);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

// Decifra un valore prodotto da encryptSecret. I valori senza prefisso sono in chiaro
// (salvati prima che la chiave fosse configurata) e vengono restituiti così come sono.
export function decryptSecret(stored) {
  if (stored == null) return null;
  const text = String(stored);
  if (!text.startsWith(ENC_PREFIX)) return text;
  const key = encryptionKey();
  if (!key) {
    console.error('❌ Valore cifrato ma INTEGR_ENC_KEY non impostata: impossibile decifrare.');
    return null;
  }
  try {
    const [ivB64, tagB64, dataB64] = text.slice(ENC_PREFIX.length).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('❌ Decifratura del token fallita (chiave cambiata?):', error.message);
    return null;
  }
}

function toStored(elemento, value) {
  return SECRET_ELEMENTS.has(elemento) ? encryptSecret(value) : (value == null ? null : String(value));
}

function fromStored(elemento, value) {
  return SECRET_ELEMENTS.has(elemento) ? decryptSecret(value) : value;
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
        [userId, tipo, provider, elemento, toStored(elemento, value), expiry[elemento] || null]
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
      const stored = toStored(elemento, value);
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
