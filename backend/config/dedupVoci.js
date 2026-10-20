// ============================================================================
// DOPPIONI DI TO-DO E RAID CREATI DALLE RIUNIONI (2026-10-20)
// ----------------------------------------------------------------------------
// Alla prima riunione si parla di un punto (es. «Utenza Studio Romboli: creare l'utenza…»), alla
// seconda se ne riparla per lo stato e l'AI lo riscrive con parole diverse («Creazione utenza
// studio Romboli: creare utenza dedicata…»). Prima di creare una To-Do o una voce RAID si cerca
// tra le voci APERTE dello stesso progetto e dello stesso registro: se è la stessa cosa non si
// crea il doppione e, se la nuova porta informazioni in più, si aggiungono alla voce esistente
// come «Aggiornamento del <data>».
//
// Regole (nessuna AI: veloce e prevedibile):
//   - stesso registro (To-Do con To-Do; Rischio con Rischio; Decisione con Decisione;
//     Dipendenza e Assunzione insieme);
//   - owner diversi (entrambi indicati) = voci diverse;
//   - numeri / date diversi nel titolo (es. «sessione 1» e «sessione 2», «16 novembre» e
//     «26 novembre») = voci diverse;
//   - titolo (per le To-Do l'argomento prima dei «:» della descrizione) con almeno 2 parole
//     significative in comune e ≥ 75% delle parole del titolo più corto; oppure titolo e
//     descrizione insieme con almeno 4 parole in comune e ≥ 60% del testo più corto.
// ============================================================================
import db from './database.js';
import { encryptRowForWrite } from './crypto.js';

const VUOTE = new Set(['della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'sulla', 'sulle', 'dalla', 'dalle', 'alla', 'alle',
  'questo', 'questa', 'quello', 'quella', 'sono', 'anche', 'perché', 'quindi', 'allora', 'essere', 'fare', 'avere', 'tutti',
  'tutte', 'entro', 'dopo', 'prima', 'come', 'cosa', 'ogni', 'loro', 'nostro', 'nostra', 'vostro', 'vostra', 'attività',
  'attivita', 'interne', 'riunione', 'creare', 'creazione', 'gestire', 'gestione', 'verificare', 'verifica', 'definire', 'progetto']);

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const parole = (t) => new Set(norm(t).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !VUOTE.has(w) && !/^\d+$/.test(w)));
const numeri = (t) => new Set((norm(t).match(/\d+/g) || []).map((n) => String(Number(n))));
const persona = (o) => [...parole(o)].sort().join(' ');

// Titolo «vero» di una To-Do: le To-Do dal recap interno hanno un titolo uguale per tutte
// («<riunione> - Attività interne») e l'argomento in testa alla descrizione («Argomento: …»).
export function titoloVoce(v) {
  const d = String(v.descrizione || '');
  const m = /^([^:\n]{3,90}):\s/.exec(d);
  if (v.registro === 'todo' && (m || /attivit[aà] interne|azioni in carico/i.test(String(v.titolo || '')))) return m ? m[1] : d.slice(0, 90);
  return String(v.titolo || '');
}

const famiglia = (r) => (r === 'assunzione' ? 'dipendenza' : r);

function sovrapposizione(a, b) {
  let comuni = 0;
  for (const w of a) if (b.has(w)) comuni++;
  return { comuni, quota: comuni / Math.max(1, Math.min(a.size, b.size)) };
}

// Voce esistente che è la stessa cosa della nuova, oppure null.
// v = { registro: 'todo' | 'rischio' | 'decisione' | 'dipendenza' | 'assunzione', titolo, descrizione, owner }
export function cercaDoppione(nuova, esistenti) {
  const tN = titoloVoce(nuova);
  const WtN = parole(tN), WN = parole(`${tN} ${nuova.descrizione || ''}`), numN = numeri(tN), oN = persona(nuova.owner);
  let migliore = null;
  for (const e of esistenti) {
    if (famiglia(e.registro) !== famiglia(nuova.registro)) continue;
    const oE = persona(e.owner);
    if (oN && oE && oN !== oE && !sovrapposizione(parole(nuova.owner), parole(e.owner)).comuni) continue;
    const tE = titoloVoce(e);
    const numE = numeri(tE);
    if (numN.size && numE.size && [...numN].sort().join() !== [...numE].sort().join()) continue;
    const t = sovrapposizione(WtN, parole(tE));
    const tutto = sovrapposizione(WN, parole(`${tE} ${e.descrizione || ''}`));
    const ok = (t.comuni >= 2 && t.quota >= 0.75) || (tutto.comuni >= 4 && tutto.quota >= 0.6);
    if (!ok) continue;
    const punti = t.quota * 2 + tutto.quota;
    if (!migliore || punti > migliore.punti) migliore = { voce: e, punti };
  }
  return migliore ? migliore.voce : null;
}

// --------------------------------------------------------------------------
// Accesso ai dati (pool che decifra in lettura; scritture cifrate con encryptRowForWrite)
// --------------------------------------------------------------------------

// Nominativi della rubrica dell'utente (id -> nominativo), per confrontare gli owner delle
// To-Do assegnate a un contatto con quelli scritti a mano.
async function nomiRubrica(user) {
  const r = await db.query(
    `SELECT id::text AS id, nominativo FROM rubrica WHERE tenant_id = $1 AND user_id = $2 AND nominativo IS NOT NULL LIMIT 5000`,
    [user.tenant_id, user.user_id]).catch(() => ({ rows: [] }));
  return new Map(r.rows.map((x) => [x.id, x.nominativo]));
}

// To-Do aperte dello stesso progetto (o, senza progetto, dello stesso cliente) dell'utente.
// Senza né progetto né cliente non si confronta nulla (troppo generico).
export async function todoAperte(user, { projectId = null, clientId = null } = {}) {
  if (!projectId && !clientId) return [];
  const filtro = projectId ? 'project_id::text = $3' : 'project_id IS NULL AND client_id::text = $3';
  const r = await db.query(
    `SELECT id::text AS id, titile AS titolo, description AS descrizione, assigned_to::text AS rubrica_id,
            assigned_to_text AS owner_testo, due_date::text AS due_date
       FROM tasks
      WHERE tenant_id = $1 AND user_id = $2 AND ${filtro}
        AND status IS DISTINCT FROM 'completed' AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
    [user.tenant_id, user.user_id, String(projectId || clientId)]);
  const nomi = r.rows.some((x) => x.rubrica_id) ? await nomiRubrica(user) : new Map();
  return r.rows.map((x) => ({ ...x, registro: 'todo', owner: (x.rubrica_id && nomi.get(x.rubrica_id)) || x.owner_testo || '' }));
}

// Owner di una To-Do nuova (contatto di rubrica o nome scritto) nella stessa forma.
export async function ownerTodo(user, rubricaId, testo) {
  if (rubricaId) return (await nomiRubrica(user)).get(String(rubricaId)) || testo || '';
  return testo || '';
}

// Aggiorna una To-Do esistente con le informazioni nuove (descrizione arricchita; scadenza se
// non c'era). executor = client della transazione o db.
export async function aggiornaTodo(executor, user, esistente, { descrizione = null, dueDate = null } = {}) {
  const set = {};
  if (descrizione) set.description = descrizione.slice(0, 4000);
  if (dueDate && !esistente.due_date) set.due_date = dueDate;
  if (!Object.keys(set).length) return false;
  const { data } = await encryptRowForWrite(db, 'tasks', set, { id: esistente.id });
  const cols = Object.keys(data);
  await executor.query(
    `UPDATE tasks SET ${cols.map((c, i) => `"${c}" = $${i + 4}`).join(', ')}, updated_at = now()
      WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
    [esistente.id, user.tenant_id, user.user_id, ...cols.map((c) => data[c])]);
  if (set.description) esistente.descrizione = set.description;
  if (set.due_date) esistente.due_date = set.due_date;
  return true;
}

// Testo da aggiungere alla descrizione esistente se la nuova porta almeno 3 parole
// significative che non c'erano; null = niente di nuovo.
export function aggiornamento(vecchia, nuova, { data = '', fonte = '' } = {}) {
  const n = String(nuova || '').trim();
  if (!n) return null;
  const V = parole(vecchia);
  const nuove = [...parole(n)].filter((w) => !V.has(w));
  if (nuove.length < 3) return null;
  const quando = data ? ` del ${data}` : '';
  return `${String(vecchia || '').trim()}\n\nAggiornamento${quando}${fonte ? ` (${fonte})` : ''}: ${n}`.trim();
}
