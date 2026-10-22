// ============================================================================
// AZIONI A CARICO DEL CLIENTE + PROMEMORIA AL PM (2026-10-16)
// ----------------------------------------------------------------------------
// Registro pm_azioni_cliente (Supporto/CreaDB/azioni_cliente.sql). Dal 2026-10-16 (scelta
// dell'utente) le righe NON nascono più da sole: nella finestra del recap «Crea task» Projexa
// propone, senza AI, le righe della sezione «AZIONI IN CARICO AL CLIENTE» (jobs/recapTasks.js ›
// parseAzioniCliente) e il PM spunta quelle da salvare (proposteDaRecap / salvaDaRecap); il PM
// può aggiungerne a mano dal Cruscotto. «Elimina» cancella la riga dalla tabella. Si vedono nel Cruscotto PM (scheda «Azioni cliente»), nel Portfolio e nella
// Linea della riunione (server.js › /api/meeting-panel).
//
// Scelta dell'utente: NESSUNA email al cliente. Solo promemoria al PM in campanella
// (fonte «cliente»), dal job notifiche_scadenze (jobs/notifiche.js, ogni mattina):
//   - «in scadenza» N giorni prima (az_giorni_prima, predefinito 2), una volta;
//   - «da sollecitare» il giorno dopo la scadenza, poi ogni N giorni lavorativi
//     (az_ogni_giorni, 5) fino a un massimo (az_max_solleciti, 3).
// Regole per PM in pm_preferenze (Portfolio › Avvisi e digest).
//
// Ogni azione presa dal recap ha una «chiave» (impronta del testo): nella finestra «Crea task»
// le azioni già salvate per quella riunione si mostrano non spuntate.
// ============================================================================
import { createHash } from 'crypto';
import db from './database.js';
import notifDb from './notifDatabase.js';
import { encryptRowForWrite, encryptValue } from './crypto.js';
import { tabellaPresente, colonneTabella, oggiIso, dataIt, giorniTra } from './pmCore.js';
import { parseAzioniCliente, parseDueDate } from '../jobs/recapTasks.js';
import { stripMarkdown } from '../jobs/meetingTranscription.js';

export const TABELLA = 'pm_azioni_cliente';
export const STATI = ['aperta', 'fatta', 'annullata'];
export const REGOLE_DEFAULT = { az_notifiche: true, az_giorni_prima: 2, az_ogni_giorni: 5, az_max_solleciti: 3 };
const PRIMO_SOLLECITO_MAX = 30; // azioni scadute da più di N giorni: nessun primo promemoria (arretrato)

const normTesto = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const chiaveDi = (descrizione) => createHash('sha256').update(normTesto(descrizione)).digest('hex');
// Stessa impronta per le azioni create da altre parti (Add-in Outlook).
export const chiaveAzioneCliente = chiaveDi;

async function ruoloUtente(user) {
  if (Number.isFinite(Number(user.id_roles))) return String(Number(user.id_roles));
  const r = (await db.query('SELECT id_roles FROM user_tenants WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [user.tenant_id, user.user_id])).rows[0];
  return r && r.id_roles != null ? String(r.id_roles) : null;
}

// ----------------------------------------------------------------------------
// AZIONI DAL RECAP (finestra «Crea task» del recap, routes/calendar.js)
// ----------------------------------------------------------------------------
// Riunione collegata (o ricollegata) a cliente/progetto dopo aver salvato le azioni: le azioni
// la seguono. Non legge più i recap (nome rimasto per i chiamanti).
export async function sincronizzaAzioniCliente(user) {
  if (!(await tabellaPresente(TABELLA))) return { tabelle: false };
  await db.query(
    `UPDATE ${TABELLA} a SET client_id = m.client_id, project_id = m.project_id, updated_at = now()
       FROM rec_meeting m
      WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.id_calendar IS NOT NULL
        AND m.tenant_id = a.tenant_id AND m.user_id = a.user_id AND m.id_calendar = a.id_calendar
        AND (a.client_id IS DISTINCT FROM m.client_id OR a.project_id IS DISTINCT FROM m.project_id)`,
    [user.tenant_id, user.user_id]);
  return { tabelle: true };
}

// Proposte per la finestra: righe della sezione del cliente del recap della riunione m
// ({ id_calendar, recap, data_calendar }), con referente, scadenza letta dal testo e «esiste»
// se già salvata per questa riunione.
export async function proposteDaRecap(user, m) {
  if (!(await tabellaPresente(TABELLA))) return { disponibile: false, items: [] };
  const data = m.data_calendar ? String(m.data_calendar).slice(0, 10) : null;
  const gia = new Set((await db.query(
    `SELECT chiave FROM ${TABELLA} WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND chiave IS NOT NULL
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
    [user.tenant_id, user.user_id, m.id_calendar])).rows.map((x) => x.chiave));
  const visti = new Set();
  const items = [];
  for (const a of parseAzioniCliente(stripMarkdown(m.recap || ''))) {
    const chiave = chiaveDi(a.description);
    if (visti.has(chiave)) continue;
    visti.add(chiave);
    items.push({ descrizione: a.description, referente: a.referente || '', data_scadenza: parseDueDate(a.description, data), esiste: gia.has(chiave) });
  }
  return { disponibile: true, items };
}

// Salva le azioni spuntate (testo, referente e scadenza come corretti nella finestra).
// Cliente e progetto = quelli della riunione. Le azioni già salvate (stessa impronta) si saltano.
export async function salvaDaRecap(user, m, azioni) {
  if (!(await tabellaPresente(TABELLA))) { const e = new Error('Va eseguito lo script Supporto/CreaDB/azioni_cliente.sql'); e.status = 503; throw e; }
  const ruolo = await ruoloUtente(user);
  const client = await db.connect();
  let create = 0, saltate = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`azioni_cliente|${user.tenant_id}|${user.user_id}`]);
    const gia = new Set((await client.query(
      `SELECT chiave FROM ${TABELLA} WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND chiave IS NOT NULL
          AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
      [user.tenant_id, user.user_id, m.id_calendar])).rows.map((x) => x.chiave));
    for (const a of azioni) {
      const chiave = chiaveDi(a.descrizione);
      if (gia.has(chiave)) { saltate += 1; continue; }
      gia.add(chiave);
      const riga = {
        tenant_id: user.tenant_id, user_id: user.user_id, client_id: m.client_id || null, project_id: m.project_id || null,
        id_calendar: m.id_calendar, referente: a.referente ? String(a.referente).slice(0, 300) : null,
        descrizione: String(a.descrizione).slice(0, 4000), data_scadenza: a.data_scadenza || null,
        stato: 'aperta', origine: 'recap', chiave, modificata: true, id_roles_write: ruolo, crypto: 1
      };
      const { data } = await encryptRowForWrite(db, TABELLA, riga);
      const cols = Object.keys(data);
      await client.query(`INSERT INTO ${TABELLA} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(', ')})`,
        cols.map((c) => data[c]));
      create += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* già chiusa */ }
    throw e;
  } finally {
    client.release();
  }
  return { create, saltate };
}

// ----------------------------------------------------------------------------
// ELENCO
// ----------------------------------------------------------------------------
// filtro: { projectId } = un progetto; { clientId, senzaProgetto: true } = riunioni del solo
// cliente; nessuno = tutte. tutte = anche fatte/annullate; recentiGiorni = fatte da poco.
export async function elencoAzioniCliente(user, { projectId = null, clientId = null, senzaProgetto = false, tutte = false, recentiGiorni = null, id = null } = {}) {
  if (!(await tabellaPresente(TABELLA))) return [];
  const p = [user.tenant_id, user.user_id];
  const w = ['a.tenant_id = $1', 'a.user_id = $2', '(a.scadenza IS NULL OR a.scadenza >= CURRENT_DATE)'];
  if (id) { p.push(id); w.push(`a.id::text = $${p.length}`); }
  if (projectId) { p.push(projectId); w.push(`a.project_id::text = $${p.length}`); }
  if (clientId) { p.push(clientId); w.push(`a.client_id::text = $${p.length}`); }
  if (senzaProgetto) w.push('a.project_id IS NULL');
  if (!tutte) w.push(recentiGiorni ? `(a.stato = 'aperta' OR (a.stato = 'fatta' AND a.fatta_il >= CURRENT_DATE - ${Number(recentiGiorni) | 0}))` : "a.stato = 'aperta'");
  const colAz = await colonneTabella(TABELLA);
  const r = await db.query(
    `SELECT a.id::text AS id, a.client_id::text AS client_id, a.project_id::text AS project_id, a.id_calendar,
            ${colAz.has('rubrica_id') ? 'a.rubrica_id::text AS rubrica_id' : 'NULL AS rubrica_id'},
            ${colAz.has('contatto_id') ? 'a.contatto_id::text AS contatto_id' : 'NULL AS contatto_id'}, a.referente, a.descrizione, a.data_scadenza::text AS data_scadenza, a.stato, a.fatta_il::text AS fatta_il,
            a.note, a.origine, a.modificata, a.solleciti, a.ultimo_sollecito::text AS ultimo_sollecito, a.id_roles_write,
            a.created_at, c.valore2 AS cliente, pr.valore2 AS progetto,
            m.oggetto AS riunione, m.data_calendar::text AS riunione_data
       FROM ${TABELLA} a
       LEFT JOIN clients c ON c.id = a.client_id
       LEFT JOIN projects pr ON pr.id = a.project_id
       LEFT JOIN rec_meeting m ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id AND m.id_calendar = a.id_calendar
      WHERE ${w.join(' AND ')}
      ORDER BY (a.stato <> 'aperta'), a.data_scadenza NULLS LAST, m.data_calendar DESC NULLS LAST, a.created_at
      LIMIT 500`, p);
  const oggi = oggiIso();
  return r.rows.map((x) => {
    const giorni = x.data_scadenza ? giorniTra(oggi, x.data_scadenza) : null;
    return {
      ...x,
      riunione_data: x.riunione_data ? x.riunione_data.slice(0, 10) : null,
      giorni,                                                      // >0 mancano, <0 scaduta da
      scaduta: x.stato === 'aperta' && giorni != null && giorni < 0,
      inScadenza: x.stato === 'aperta' && giorni != null && giorni >= 0 && giorni <= 7
    };
  });
}

// ----------------------------------------------------------------------------
// REFERENTE ↔ CONTATTI DEL CLIENTE / RUBRICA (destinatari dell'email «Email» del registro)
// ----------------------------------------------------------------------------
// Le persone del cliente stanno di solito nei Contatti del cliente (contacts), a volte nella
// Rubrica (rubrica). Contatto scelto a mano (contatto_id / rubrica_id, dal triangolo giallo)
// oppure abbinato da solo, prima tra i Contatti di QUEL cliente e poi in Rubrica: stesso nome e
// cognome in qualsiasi ordine («Vietti Claudia» = «Claudia Vietti»), senza quanto sta tra
// parentesi o dopo « - » («Mario Rossi (ACME)», «Federica Di Marzo - MVN srl»), un solo
// contatto con quel nome. Solo il nome di battesimo («Antonina») vale tra i Contatti del cliente
// se una sola persona lo porta. Nessun contatto = referenteDaScegliere (triangolo giallo).
const pulisciNome = (s) => String(s || '').replace(/\([^)]*\)/g, ' ').split(/\s+[-–]\s+/)[0];
export const normNome = (s) => pulisciNome(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const ordina = (l) => l.sort((a, b) => a.nominativo.localeCompare(b.nominativo, 'it', { sensitivity: 'base' }));

export async function rubricaUtente(user, idsAnche = []) {
  const r = await db.query(
    `SELECT id::text AS id, nominativo, email FROM rubrica
      WHERE tenant_id = $1 AND user_id = $2 AND ((scadenza IS NULL OR scadenza >= CURRENT_DATE) OR id::text = ANY($3::text[]))
      LIMIT 5000`, [user.tenant_id, user.user_id, idsAnche]);
  return ordina(r.rows.filter((x) => String(x.nominativo || '').trim())
    .map((x) => ({ fonte: 'rubrica', id: x.id, nominativo: String(x.nominativo).trim(), email: String(x.email || '').trim() })));
}

// Contatti dei clienti indicati (tabella contacts, colonna del cliente client_id o id_cliente).
export async function contattiClienti(user, clientIds) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return [];
  const cc = await colonneTabella('contacts');
  const col = ['client_id', 'id_cliente'].find((c) => cc.has(c));
  if (!col) return [];
  const r = await db.query(
    `SELECT id::text AS id, "${col}"::text AS client_id, nominativo, ${cc.has('nome') ? 'nome, cognome,' : ''} ${cc.has('email') ? 'email' : "'' AS email"}
       FROM contacts WHERE tenant_id = $1 AND user_id = $2 AND "${col}"::text = ANY($3::text[]) LIMIT 5000`,
    [user.tenant_id, user.user_id, ids]);
  return ordina(r.rows.map((x) => ({
    fonte: 'cliente', id: x.id, clientId: x.client_id,
    nominativo: String(x.nominativo || [x.nome, x.cognome].filter(Boolean).join(' ') || '').trim(),
    email: String(x.email || '').trim()
  })).filter((x) => x.nominativo));
}

export async function abbinaReferenti(user, azioni) {
  if (!azioni.length) return azioni;
  const [rubrica, contatti] = await Promise.all([
    rubricaUtente(user, azioni.map((a) => a.rubrica_id).filter(Boolean)),
    contattiClienti(user, azioni.map((a) => a.client_id))
  ]);
  const rubId = new Map(rubrica.map((c) => [c.id, c]));
  const conId = new Map(contatti.map((c) => [c.id, c]));
  const indice = (lista) => {
    const m = new Map();
    for (const c of lista) { const k = normNome(c.nominativo); if (k) m.set(k, m.has(k) ? null : c); } // null = omonimi
    return m;
  };
  const perCliente = new Map(); // client_id -> { nomi, contatti }
  for (const c of contatti) {
    if (!perCliente.has(c.clientId)) perCliente.set(c.clientId, []);
    perCliente.get(c.clientId).push(c);
  }
  const idxCliente = new Map([...perCliente].map(([k, l]) => [k, { nomi: indice(l), l }]));
  const cerca = (a) => {
    const k = normNome(a.referente);
    if (!k) return null;
    const ic = idxCliente.get(a.client_id);
    if (ic) {
      if (ic.nomi.get(k)) return ic.nomi.get(k);
      if (!k.includes(' ')) { // solo il nome: una sola persona del cliente con quel nome
        const t = ic.l.filter((c) => normNome(c.nominativo).split(' ').includes(k));
        if (t.length === 1) return t[0];
      }
    }
    // Solo i Contatti del cliente (scelta dell'utente 2026-10-16): la Rubrica ha i colleghi interni.
    return null;
  };
  return azioni.map((a) => {
    let c = (a.contatto_id && conId.get(a.contatto_id)) || (a.rubrica_id && rubId.get(a.rubrica_id)) || null;
    let auto = false;
    if (!c && a.referente) { c = cerca(a); auto = !!c; }
    return { ...a, contatto: c ? { fonte: c.fonte, id: c.id, nominativo: c.nominativo, email: c.email, auto } : null, referenteDaScegliere: !c || !c.email };
  });
}

// Testo per il contesto delle funzioni AI del progetto (Briefing, Status Report, Chiedi).
export async function testoAzioniCliente(user, projectId) {
  const l = await elencoAzioniCliente(user, { projectId });
  if (!l.length) return '';
  return ['AZIONI A CARICO DEL CLIENTE (aperte)',
    ...l.slice(0, 40).map((a) => `- ${a.descrizione}${a.referente ? ` | ${a.referente}` : ''} | scadenza ${dataIt(a.data_scadenza) || 'da definire'}${a.scaduta ? ` (SCADUTA da ${-a.giorni} giorni)` : ''}${a.solleciti ? ` | già sollecitata ${a.solleciti} volte` : ''}`)
  ].join('\n');
}

// ----------------------------------------------------------------------------
// REGOLE DEI PROMEMORIA (pm_preferenze)
// ----------------------------------------------------------------------------
export async function regolePromemoria(user) {
  const cols = await colonneTabella('pm_preferenze');
  if (!cols.has('az_giorni_prima')) return { ...REGOLE_DEFAULT, tabelle: false };
  const r = (await db.query('SELECT az_notifiche, az_giorni_prima, az_ogni_giorni, az_max_solleciti FROM pm_preferenze WHERE tenant_id = $1 AND user_id = $2',
    [user.tenant_id, user.user_id])).rows[0];
  return { ...REGOLE_DEFAULT, ...(r || {}), tabelle: true };
}
const limita = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
export function regoleDaBody(b) {
  return {
    az_notifiche: b.az_notifiche !== false,
    az_giorni_prima: limita(b.az_giorni_prima, 0, 30, REGOLE_DEFAULT.az_giorni_prima),
    az_ogni_giorni: limita(b.az_ogni_giorni, 1, 30, REGOLE_DEFAULT.az_ogni_giorni),
    az_max_solleciti: limita(b.az_max_solleciti, 0, 10, REGOLE_DEFAULT.az_max_solleciti)
  };
}

// Giorni lavorativi (lun-ven) dopo «da» fino a «a» compreso.
function lavorativiDopo(da, a) {
  let n = 0;
  const d = new Date(`${da}T12:00:00Z`);
  const fine = new Date(`${a}T12:00:00Z`);
  while (d < fine) {
    d.setUTCDate(d.getUTCDate() + 1);
    const g = d.getUTCDay();
    if (g !== 0 && g !== 6) n += 1;
  }
  return n;
}

// ----------------------------------------------------------------------------
// PROMEMORIA IN CAMPANELLA (chiamato dal job notifiche_scadenze, tutti i tenant)
// ----------------------------------------------------------------------------
export async function promemoriaAzioniCliente() {
  const report = { controllate: 0, preavvisi: 0, solleciti: 0, errori: [] };
  if (!(await tabellaPresente(TABELLA))) return { ...report, nota: 'Tabella pm_azioni_cliente assente: eseguire Supporto/CreaDB/azioni_cliente.sql' };
  // (Dal 2026-10-16 i recap non si leggono più qui: le azioni si scelgono in «Crea task».)
  // Azioni aperte con scadenza: preavviso e solleciti secondo le regole del PM.
  const oggi = oggiIso();
  const azioni = (await db.query(
    `SELECT a.id::text AS id, a.tenant_id::text AS tenant_id, a.user_id::text AS user_id, a.descrizione, a.referente,
            a.data_scadenza::text AS due, a.preavviso_il, a.solleciti, a.ultimo_sollecito::text AS ultimo,
            c.valore2 AS cliente, pr.valore2 AS progetto
       FROM ${TABELLA} a
       LEFT JOIN clients c ON c.id = a.client_id
       LEFT JOIN projects pr ON pr.id = a.project_id
      WHERE a.stato = 'aperta' AND (a.scadenza IS NULL OR a.scadenza >= CURRENT_DATE)
        AND a.data_scadenza IS NOT NULL AND a.data_scadenza BETWEEN CURRENT_DATE - 180 AND CURRENT_DATE + 30`)).rows;
  const regole = new Map();
  for (const a of azioni) {
    report.controllate += 1;
    try {
      const k = `${a.tenant_id}|${a.user_id}`;
      if (!regole.has(k)) regole.set(k, await regolePromemoria(a));
      const rg = regole.get(k);
      if (!rg.az_notifiche) continue;
      const giorni = giorniTra(oggi, a.due);
      const dove = [a.cliente, a.progetto].filter(Boolean).join(' · ');
      const testo = `${dove ? `${dove}: ` : ''}«${String(a.descrizione || '').slice(0, 300)}»${a.referente ? `\nReferente: ${a.referente}` : ''}`;
      if (giorni >= 0 && giorni <= rg.az_giorni_prima && !a.preavviso_il) {
        const titolo = giorni === 0 ? 'Azione del cliente in scadenza oggi' : `Azione del cliente in scadenza tra ${giorni} giorn${giorni === 1 ? 'o' : 'i'}`;
        await notifica(a, `pre|${a.due}`, titolo, `${testo}\nScadenza: ${dataIt(a.due)}`);
        await db.query(`UPDATE ${TABELLA} SET preavviso_il = $2 WHERE id::text = $1`, [a.id, oggi]);
        report.preavvisi += 1;
      } else if (giorni < 0 && a.solleciti < rg.az_max_solleciti) {
        const dovuto = a.solleciti === 0 ? -giorni <= PRIMO_SOLLECITO_MAX : (!a.ultimo || lavorativiDopo(a.ultimo, oggi) >= rg.az_ogni_giorni);
        if (!dovuto) continue;
        const n = a.solleciti + 1;
        const titolo = `Sollecita il cliente: azione scaduta (${n}° promemoria${n === rg.az_max_solleciti ? ', ultimo' : ''})`;
        await notifica(a, `s${n}|${a.due}`, titolo, `${testo}\nScadenza: ${dataIt(a.due)}, scaduta da ${-giorni} giorn${giorni === -1 ? 'o' : 'i'}`);
        await db.query(`UPDATE ${TABELLA} SET solleciti = $2, ultimo_sollecito = $3 WHERE id::text = $1`, [a.id, n, oggi]);
        report.solleciti += 1;
      }
    } catch (e) {
      if (e.code === '42P01' && /notifiche/.test(e.message)) throw new Error('Tabelle delle notifiche assenti su projexa_notif: eseguire Supporto/CreaDB/notifiche.sql');
      report.errori.push(`azione ${a.id}: ${e.message}`);
    }
  }
  return report;
}

// Una notifica per azione e promemoria (chiave_dedup): non si ripete.
async function notifica(a, passo, titolo, messaggio) {
  await notifDb.query(
    `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id, chiave_dedup)
     VALUES ($1, $2, 'cliente', $3, $4, '${TABELLA}', $5, $6)
     ON CONFLICT (tenant_id, user_id, chiave_dedup) WHERE chiave_dedup IS NOT NULL DO NOTHING`,
    [a.tenant_id, a.user_id, encryptValue(titolo), encryptValue(messaggio), a.id, `cliente|${a.id}|${passo}`]
  );
}
