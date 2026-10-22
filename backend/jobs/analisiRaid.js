// ============================================================================
// ANALISI RAID E CHANGE REQUEST: confronto Projexa / AI esterna (2026-10-22)
// ----------------------------------------------------------------------------
// Quando RAID o Change Request si estraggono con «Projexa» (routes/pm.js, /raid/estrai e
// /cr/estrai) per un utente di ANALISI_PM_EMAILS, il compito ESATTO e la risposta di Projexa si
// salvano in pm_raid_analisi e lo stesso compito va subito all'AI scelta nella pagina Analisi PM
// (Gemini o ChatGPT, in modalità Immediata: il testo è il recap, corto). L'AI esterna risponde
// solo per confronto: non crea niente nel registro. In Analisi PM › RAID e CR l'utente sceglie
// la risposta giusta; le scelte diventano il file per addestrare raid-projexa-14b, che poi RAID
// e CR con «Projexa 14B» usano al posto della base qwen3:14b (se manca, la base).
// Tabella: Supporto/CreaDB/analisi_raid.sql (senza tabella nessun confronto, il resto va).
// ============================================================================
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import { encryptValue } from '../config/crypto.js';
import { askAiProvider } from '../routes/ai.js';
import { analisiPmAbilitata, aiScelta } from './analisiPm.js';

export const OLLAMA_RAID_ADDESTRATO = process.env.OLLAMA_RAID_PROJEXA_MODEL || 'raid-projexa-14b';
// Insegnante rimasto «da_inviare» (riavvio del server a metà): si riprova dopo questo tempo.
const RIPROVA_MS = 10 * 60000;

async function insegnanteAttivo(user) {
  if (!String(process.env.ANALISI_PM_EMAILS || '').trim()) return false;
  const email = user.email || ((await authDb.query('SELECT email FROM users WHERE id = $1', [user.user_id])).rows[0] || {}).email;
  return analisiPmAbilitata(email);
}

// Salva il confronto e chiede la risposta all'AI esterna in background. Non lancia mai errori:
// il RAID dell'utente non deve fallire per il confronto.
export async function registraConfronto(user, { operazione, idCalendar, projectId, clientId, prompt, risposta, modello }) {
  try {
    if (!(await insegnanteAttivo(user))) return;
    const ai = await aiScelta(user);
    const r = await db.query(
      `INSERT INTO pm_raid_analisi (tenant_id, user_id, client_id, project_id, id_calendar, operazione, prompt, projexa_modello, projexa_risposta, insegnante_ai)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
      [user.tenant_id, user.user_id, clientId || null, projectId || null, idCalendar || null, operazione,
        encryptValue(prompt), String(modello || '').slice(0, 60) || null, encryptValue(String(risposta || '')), ai]);
    chiediInsegnante(r.rows[0].id).catch(() => {});
  } catch (e) {
    if (e.code !== '42P01') console.error(`❌ [ANALISI RAID] confronto non salvato: ${e.message}`);
  }
}

// Lo stesso compito all'AI esterna (Immediata). Esito in insegnante_stato: pronto | errore.
const inCorso = new Set();
export async function chiediInsegnante(id) {
  if (inCorso.has(id)) return;
  inCorso.add(id);
  try { await insegnante(id); } finally { inCorso.delete(id); }
}
async function insegnante(id) {
  const a = (await db.query(
    `SELECT id::text AS id, user_id::text AS user_id, prompt, insegnante_ai FROM pm_raid_analisi WHERE id = $1`, [id])).rows[0];
  if (!a) return;
  try {
    const r = await askAiProvider(a.user_id, a.insegnante_ai || 'Gemini', a.prompt, { json: true, immediato: true });
    await db.query(`UPDATE pm_raid_analisi SET insegnante_stato = 'pronto', insegnante_risposta = $2, insegnante_errore = NULL WHERE id = $1`,
      [id, encryptValue(String(r.text || ''))]);
  } catch (e) {
    await db.query(`UPDATE pm_raid_analisi SET insegnante_stato = 'errore', insegnante_errore = $2 WHERE id = $1`,
      [id, String(e.message || e).slice(0, 1000)]).catch(() => {});
  }
}

// Confronti rimasti a metà (riavvio): si richiedono all'apertura della pagina Analisi PM.
export async function riprendiInsegnanti(user) {
  const r = await db.query(
    `SELECT id::text AS id FROM pm_raid_analisi
      WHERE tenant_id = $1 AND user_id = $2 AND insegnante_stato = 'da_inviare' AND created_at < now() - ($3 || ' milliseconds')::interval
      LIMIT 5`, [user.tenant_id, user.user_id, String(RIPROVA_MS)]);
  for (const x of r.rows) chiediInsegnante(x.id).catch(() => {});
}
