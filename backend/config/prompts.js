// Prompt AI per funzione (tabella app_prompts, database principale).
// Chiave: tenant_id + user_id + funzione (es. RECAP_EMAIL).
//   - riga con tenant_id e user_id dell'utente del contesto -> prompt personalizzato;
//   - altrimenti la riga "standard" (tenant_id NULL, user_id NULL).
// La riga standard nasce dal file backend/prompts/<funzione in minuscolo>.txt, che resta
// anche come riserva se il database non risponde. Il prompt si rilegge a ogni uso: le
// modifiche fatte da prompt-editor.html valgono subito, senza riavvii, e i deploy (che
// sovrascrivono i file) non le toccano.
//
// Tabella: Supporto/CreaDB/app_prompts.sql (creata anche in automatico al primo uso).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

// Funzioni con prompt gestibile dall'editor: codice -> titolo e segnaposto disponibili.
export const PROMPT_FUNCTIONS = {
  RECAP_EMAIL: {
    titolo: 'Recap email della riunione',
    segnaposto: ['TRASCRIZIONE', 'OGGETTO', 'DATA', 'UTENTE']
  }
};

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      // Versione precedente della tabella (chiave "nome", mai usata in produzione).
      await db.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'app_prompts' AND column_name = 'nome') THEN
          DROP TABLE app_prompts;
        END IF; END $$`);
      await db.query(
        `CREATE TABLE IF NOT EXISTS app_prompts (
           id          BIGSERIAL PRIMARY KEY,
           tenant_id   UUID,
           user_id     UUID,
           funzione    TEXT NOT NULL,
           testo       TEXT NOT NULL,
           updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_by  TEXT,
           CONSTRAINT app_prompts_chiave UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, funzione),
           CONSTRAINT app_prompts_ambito CHECK ((tenant_id IS NULL) = (user_id IS NULL))
         )`
      );
      // Riga standard di ogni funzione: se manca, dal file.
      for (const funzione of Object.keys(PROMPT_FUNCTIONS)) {
        await db.query(
          `INSERT INTO app_prompts (tenant_id, user_id, funzione, testo, updated_by)
           VALUES (NULL, NULL, $1, $2, 'file')
           ON CONFLICT ON CONSTRAINT app_prompts_chiave DO NOTHING`,
          [funzione, readPromptFile(funzione)]
        );
      }
    })().catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

export function readPromptFile(funzione) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${String(funzione).toLowerCase()}.txt`), 'utf8');
}

// Prompt da usare per l'utente del contesto: il suo se esiste, altrimenti lo standard.
// user: { tenant_id, user_id }. Restituisce { testo, ambito: 'utente' | 'standard' | 'file' }.
export async function getPromptFor(funzione, user) {
  try {
    await ensureTable();
    const row = (await db.query(
      `SELECT testo, tenant_id FROM app_prompts
        WHERE funzione = $1
          AND ((tenant_id = $2 AND user_id = $3) OR (tenant_id IS NULL AND user_id IS NULL))
        ORDER BY (tenant_id IS NULL)
        LIMIT 1`,
      [funzione, user?.tenant_id || null, user?.user_id || null]
    )).rows[0];
    if (row && row.testo && row.testo.trim()) {
      return { testo: row.testo, ambito: row.tenant_id ? 'utente' : 'standard' };
    }
  } catch (e) {
    console.error(`[PROMPT] lettura di ${funzione} dal database fallita, uso il file:`, e.message);
  }
  return { testo: readPromptFile(funzione), ambito: 'file' };
}

// Riga esatta di un ambito (tenantId/userId null = standard), senza ripiego. null se assente.
export async function getPromptRow(funzione, tenantId, userId) {
  await ensureTable();
  return (await db.query(
    `SELECT testo, updated_at, updated_by FROM app_prompts
      WHERE funzione = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND user_id IS NOT DISTINCT FROM $3`,
    [funzione, tenantId || null, userId || null]
  )).rows[0] || null;
}

export async function savePrompt(funzione, tenantId, userId, testo, autore) {
  await ensureTable();
  return (await db.query(
    `INSERT INTO app_prompts (tenant_id, user_id, funzione, testo, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, NOW(), $5)
     ON CONFLICT ON CONSTRAINT app_prompts_chiave
     DO UPDATE SET testo = EXCLUDED.testo, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING updated_at, updated_by`,
    [tenantId || null, userId || null, funzione, testo, autore || null]
  )).rows[0];
}

// Solo righe personalizzate: la standard non si cancella (si ripristina dal file).
export async function deleteUserPrompt(funzione, tenantId, userId) {
  await ensureTable();
  const r = await db.query(
    'DELETE FROM app_prompts WHERE funzione = $1 AND tenant_id = $2 AND user_id = $3',
    [funzione, tenantId, userId]
  );
  return r.rowCount;
}

// Elenco delle personalizzazioni di una funzione (per l'editor).
export async function listUserPrompts(funzione) {
  await ensureTable();
  return (await db.query(
    `SELECT tenant_id, user_id, updated_at, updated_by FROM app_prompts
      WHERE funzione = $1 AND tenant_id IS NOT NULL ORDER BY updated_at DESC`,
    [funzione]
  )).rows;
}
