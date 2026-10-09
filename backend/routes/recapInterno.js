// ============================================================================
// RECAP INTERNO DELLA RIUNIONE (2026-10-09) - API /api/recap-interno
// ----------------------------------------------------------------------------
// Finestra del recap › scheda «Recap interno» (sito/dashboard.html). Accanto al recap per il
// cliente (rec_meeting.recap, invariato) il project manager genera SU RICHIESTA un recap per il
// proprio team: una sintesi interna (rec_meeting.recap_interno) e l'elenco delle attività che il
// team deve fare (tabella rec_meeting_attivita), ognuna con owner e scadenza.
// La trascrizione non dice chi parla, quindi l'owner lo propone l'AI solo se il testo è chiaro e
// lo sceglie il PM (team del progetto della riunione o rubrica, o scritto a mano).
// Dalla scheda: «Crea task» (tasks assegnati agli owner) ed «Email al team» (nel browser).
//
// AI = quella del recap (Impostazioni › AI › «AI generazione e-mail recap»), prompt RECAP_INTERNO
// (config/prompts.js). La generazione gira in background: con «Recap Projexa (lento)» può durare
// molti minuti; la pagina interroga lo stato e a fine lavoro arriva la notifica in campanella.
// Tabelle: Supporto/CreaDB/recap_interno.sql.
// ============================================================================
import express from 'express';
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { getPromptFor } from '../config/prompts.js';
import { askAiProvider, localRecapMode, askOllamaRecap } from './ai.js';
import { recapSource, recapProviderName, applyCorrections, stripMarkdown, encRec } from '../jobs/meetingTranscription.js';
import { parseDueDate } from '../jobs/recapTasks.js';
import { notificaRiunione } from '../jobs/notifiche.js';

const router = express.Router();
const errore = (status, message) => Object.assign(new Error(message), { status });
const invia = (res, e, tag) => {
  if (!e.status) console.error(`❌ RECAP_INTERNO ${tag}:`, e.message);
  res.status(e.status || 500).json({ error: e.message });
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

// Generazioni in corso in questo processo: "tenant|utente|id_calendar".
const inCorso = new Set();
const chiave = (user, id) => `${user.tenant_id}|${user.user_id}|${id}`;

let pronta = null;
async function tabellePronte() {
  if (pronta) return pronta;
  const r = await db.query(
    `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'rec_meeting' AND column_name = 'recap_interno_stato') AS c,
            (SELECT count(*) FROM information_schema.tables WHERE table_name = 'rec_meeting_attivita') AS t`
  );
  const ok = Number(r.rows[0].c) > 0 && Number(r.rows[0].t) > 0;
  if (ok) pronta = true;
  return ok;
}
async function richiedeTabelle() {
  if (!(await tabellePronte())) throw errore(503, 'Funzione non ancora attiva: va eseguito lo script Supporto/CreaDB/recap_interno.sql sul database');
}

async function riunione(user, idCalendar) {
  const id = String(idCalendar || '').trim();
  if (!id) throw errore(400, 'Riunione non indicata');
  const m = (await db.query(
    `SELECT id_calendar, oggetto, data_calendar::text AS data, client_id::text AS client_id, project_id::text AS project_id,
            (trascrizione IS NOT NULL AND BTRIM(trascrizione) <> '') AS ha_trascrizione
       FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, id]
  )).rows[0];
  if (!m) throw errore(404, 'Riunione non gestita con Projexa');
  return m;
}

// Persone proponibili come owner: il team del progetto della riunione (Kick-off, proj_componenti)
// e la rubrica dell'utente. rubricaId serve ad assegnare il task al contatto giusto.
async function persone(user, m) {
  const rb = (await db.query(
    `SELECT id::text AS id, nominativo, email FROM rubrica
      WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) LIMIT 3000`,
    [user.tenant_id, user.user_id]
  )).rows.filter((x) => x.nominativo);
  const perEmail = new Map(rb.filter((x) => x.email).map((x) => [norm(x.email), x]));
  let team = [];
  if (m.project_id) {
    team = (await db.query(
      `SELECT nominativo, email FROM proj_componenti
        WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
      [user.tenant_id, user.user_id, m.project_id]
    )).rows.filter((x) => x.nominativo);
  }
  const out = [];
  const visti = new Set();
  for (const t of team) {
    const r = t.email ? perEmail.get(norm(t.email)) : null;
    const k = norm(t.email || t.nominativo);
    if (visti.has(k)) continue;
    visti.add(k);
    out.push({ nominativo: String(t.nominativo).trim(), email: t.email || '', rubricaId: r ? r.id : null, team: true });
  }
  for (const r of rb) {
    const k = norm(r.email || r.nominativo);
    if (visti.has(k)) continue;
    visti.add(k);
    out.push({ nominativo: String(r.nominativo).trim(), email: r.email || '', rubricaId: r.id, team: false });
  }
  return out.sort((a, b) => (b.team - a.team) || a.nominativo.localeCompare(b.nominativo, 'it'));
}

// Owner scritto dall'AI -> persona conosciuta (nome completo, o cognome/nome se univoco).
function abbinaOwner(nome, elenco) {
  const n = norm(nome);
  if (!n) return null;
  const esatto = elenco.find((p) => norm(p.nominativo) === n);
  if (esatto) return esatto;
  const parti = n.split(' ').filter((x) => x.length >= 3);
  const candidati = elenco.filter((p) => parti.some((x) => norm(p.nominativo).split(' ').includes(x)));
  const delTeam = candidati.filter((p) => p.team);
  if (delTeam.length === 1) return delTeam[0];
  return candidati.length === 1 ? candidati[0] : null;
}

// Testo dell'AI -> { sintesi, attivita: [{ argomento, descrizione, owner, scadenza }] }.
export function leggiRecapInterno(testo, dataRiunione) {
  const righe = stripMarkdown(String(testo || '')).replace(/\r\n?/g, '\n').split('\n');
  const iSint = righe.findIndex((l) => /^\s*sintesi\b/i.test(l));
  const iAtt = righe.findIndex((l) => /^\s*attivit[aà]\b/i.test(l));
  const fineSint = iAtt > iSint ? iAtt : righe.length;
  const sintesi = (iSint >= 0 ? righe.slice(iSint + 1, fineSint) : righe.slice(0, iAtt >= 0 ? iAtt : 0))
    .map((l) => l.trim()).filter(Boolean).join('\n').trim();
  const attivita = [];
  for (const l of righe.slice(iAtt >= 0 ? iAtt + 1 : 0)) {
    const m = /^\s*(?:[-•*–]|\d+[.)])\s*(.+)$/.exec(l);
    if (!m || !m[1].includes('|')) continue;
    let [argomento = '', descrizione = '', owner = '', scadenza = ''] = m[1].split('|').map((x) => x.trim());
    if (!descrizione) { descrizione = argomento; argomento = ''; }
    if (!descrizione || /^descrizione/i.test(descrizione)) continue; // riga d'intestazione ripetuta dall'AI
    const iso = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(scadenza);
    const data = iso ? `${iso[3]}-${iso[2].padStart(2, '0')}-${iso[1].padStart(2, '0')}` : (scadenza ? parseDueDate(scadenza, dataRiunione) : null);
    attivita.push({ argomento: argomento.slice(0, 200), descrizione: descrizione.slice(0, 4000), owner: owner.replace(/^[-–]$/, '').slice(0, 300), scadenza: data || null });
  }
  return { sintesi, attivita };
}

async function inserisciAttivita(client, user, idCalendar, a, ordine, origine) {
  const riga = {
    tenant_id: user.tenant_id, user_id: user.user_id, id_calendar: idCalendar, ordine,
    argomento: a.argomento || null, descrizione: a.descrizione, owner_nominativo: a.owner_nominativo || null,
    owner_email: a.owner_email || null, rubrica_id: a.rubrica_id || null, scadenza: a.scadenza || null, origine, crypto: 1
  };
  const { data } = await encryptRowForWrite(db, 'rec_meeting_attivita', riga);
  const cols = Object.keys(data);
  await client.query(
    `INSERT INTO rec_meeting_attivita (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => data[c])
  );
}

async function impostaStato(user, idCalendar, stato, erroreTesto = null) {
  await db.query(
    `UPDATE rec_meeting SET recap_interno_stato = $1, recap_interno_errore = $2 WHERE tenant_id = $3 AND user_id = $4 AND id_calendar = $5`,
    [stato, erroreTesto, user.tenant_id, user.user_id, idCalendar]
  );
}

// Generazione completa (in background). Le attività già trasformate in task restano; le altre
// si sostituiscono con quelle nuove.
async function genera(user, idCalendar) {
  const m = await riunione(user, idCalendar);
  const providerName = await recapProviderName(user);
  if (!providerName) throw errore(400, 'Scegli l\'AI in Impostazioni › AI › «AI generazione e-mail recap»');
  const { transcript, vars, rules } = await recapSource(user, idCalendar);
  const elenco = await persone(user, m);
  const team = elenco.filter((p) => p.team);
  const varsInt = { ...vars, TEAM: team.length ? team.map((p) => `- ${p.nominativo}`).join('\n') : '(nessuna persona indicata nel team del progetto)' };
  let tpl = (await getPromptFor('RECAP_INTERNO', user)).testo;
  if (!tpl.includes('{{TRASCRIZIONE}}')) tpl += '\n\nTrascrizione:\n{{TRASCRIZIONE}}';
  const build = (t) => tpl.replace(/\{\{(TRASCRIZIONE|OGGETTO|DATA|UTENTE|TEAM)\}\}/g, (x, k) => (k === 'TRASCRIZIONE' ? t : (varsInt[k] || '')));
  const r = localRecapMode(providerName) === 'server'
    ? await askOllamaRecap(async (t) => build(t), transcript, { meeting: true, contesto: vars.OGGETTO })
    : await askAiProvider(user.user_id, providerName, build(transcript));
  const testo = applyCorrections(String(r.text || '').trim(), rules).text;
  const { sintesi, attivita } = leggiRecapInterno(testo, m.data);
  if (!sintesi && !attivita.length) throw errore(502, `${r.label} non ha restituito un recap interno leggibile: riprova`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recap_interno|${chiave(user, idCalendar)}`]);
    const tenute = (await client.query(
      `SELECT descrizione FROM rec_meeting_attivita WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND task_id IS NOT NULL`,
      [user.tenant_id, user.user_id, idCalendar]
    )).rows.map((x) => norm(x.descrizione));
    await client.query(
      'DELETE FROM rec_meeting_attivita WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND task_id IS NULL',
      [user.tenant_id, user.user_id, idCalendar]
    );
    let ordine = tenute.length;
    for (const a of attivita) {
      if (tenute.includes(norm(a.descrizione))) continue;
      const p = abbinaOwner(a.owner, elenco);
      ordine += 1;
      await inserisciAttivita(client, user, idCalendar, {
        ...a,
        owner_nominativo: p ? p.nominativo : (a.owner || null),
        owner_email: p ? p.email : null,
        rubrica_id: p ? p.rubricaId : null
      }, ordine, 'ai');
    }
    await client.query(
      `UPDATE rec_meeting SET recap_interno = $1, recap_interno_stato = 'pronto', recap_interno_il = now(), recap_interno_errore = NULL
        WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
      [encRec(sintesi || ''), user.tenant_id, user.user_id, idCalendar]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await notificaRiunione({ tenantId: user.tenant_id, userId: user.user_id, idCalendar, tipo: 'recap_interno' });
  console.log(`[RECAP INTERNO] ✓ ${attivita.length} attività con ${r.label} per la riunione ${idCalendar}`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const m = await riunione(req.user, req.query.id_calendar);
    const pronte = await tabellePronte();
    const ai = await recapProviderName(req.user);
    if (!pronte) return res.json({ tabelle: false, stato: null, attivita: [], riunione: m, ai: { nome: ai, locale: localRecapMode(ai) === 'server' } });
    const r = (await db.query(
      `SELECT recap_interno, recap_interno_stato, recap_interno_il, recap_interno_errore FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    )).rows[0] || {};
    let stato = r.recap_interno_stato || null;
    // «in corso» rimasto da un riavvio del server: la generazione si è interrotta.
    if (stato === 'in_corso' && !inCorso.has(chiave(req.user, m.id_calendar))) stato = 'interrotto';
    const att = (await db.query(
      `SELECT id::text AS id, ordine, argomento, descrizione, owner_nominativo, owner_email, rubrica_id::text AS rubrica_id,
              scadenza::text AS scadenza, task_id::text AS task_id, origine
         FROM rec_meeting_attivita WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 ORDER BY ordine, created_at`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    )).rows;
    res.json({
      tabelle: true, riunione: m, stato, il: r.recap_interno_il, errore: r.recap_interno_errore,
      sintesi: r.recap_interno || '', attivita: att, ai: { nome: ai, locale: localRecapMode(ai) === 'server' }
    });
  } catch (e) { invia(res, e, 'LEGGI'); }
});

router.get('/persone', async (req, res) => {
  try {
    const m = await riunione(req.user, req.query.id_calendar);
    res.json(await persone(req.user, m));
  } catch (e) { invia(res, e, 'PERSONE'); }
});

// Avvia la generazione e risponde subito; la pagina interroga GET / finché lo stato è «in_corso».
router.post('/genera', async (req, res) => {
  try {
    await richiedeTabelle();
    const m = await riunione(req.user, req.body && req.body.id_calendar);
    if (!m.ha_trascrizione) throw errore(400, 'La riunione non ha ancora una trascrizione');
    if (!(await recapProviderName(req.user))) throw errore(400, 'Scegli l\'AI in Impostazioni › AI › «AI generazione e-mail recap»');
    const k = chiave(req.user, m.id_calendar);
    if (inCorso.has(k)) throw errore(409, 'Il recap interno di questa riunione è già in preparazione');
    inCorso.add(k);
    await impostaStato(req.user, m.id_calendar, 'in_corso');
    const user = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, email: req.user.email, id_roles: req.user.id_roles };
    genera(user, m.id_calendar)
      .catch(async (e) => {
        console.error(`❌ RECAP_INTERNO ${m.id_calendar}:`, e.message);
        await impostaStato(user, m.id_calendar, 'errore', String(e.message || e).slice(0, 1000)).catch(() => {});
      })
      .finally(() => inCorso.delete(k));
    res.status(202).json({ avviato: true });
  } catch (e) { invia(res, e, 'GENERA'); }
});

// Salvataggio della scheda: { id_calendar, sintesi, attivita: [{ id?, argomento, descrizione,
// owner_nominativo, owner_email, rubrica_id, scadenza }] } = l'elenco completo, nell'ordine
// mostrato. Le attività tolte si cancellano (quelle già trasformate in task restano).
router.put('/', async (req, res) => {
  let client;
  try {
    await richiedeTabelle();
    const b = req.body || {};
    const m = await riunione(req.user, b.id_calendar);
    const lista = (Array.isArray(b.attivita) ? b.attivita : []).slice(0, 200)
      .map((a) => ({
        id: a && UUID_RE.test(String(a.id || '')) ? String(a.id) : null,
        argomento: String((a && a.argomento) || '').trim().slice(0, 200),
        descrizione: String((a && a.descrizione) || '').trim().slice(0, 4000),
        owner_nominativo: String((a && a.owner_nominativo) || '').trim().slice(0, 300),
        owner_email: String((a && a.owner_email) || '').trim().slice(0, 300),
        rubrica_id: a && UUID_RE.test(String(a.rubrica_id || '')) ? String(a.rubrica_id) : null,
        scadenza: a && /^\d{4}-\d{2}-\d{2}$/.test(String(a.scadenza || '')) ? String(a.scadenza) : null
      }))
      .filter((a) => a.descrizione);
    client = await db.connect();
    await client.query('BEGIN');
    const esistenti = new Set((await client.query(
      'SELECT id::text AS id FROM rec_meeting_attivita WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    )).rows.map((x) => x.id));
    const tenuti = new Set(lista.filter((a) => a.id && esistenti.has(a.id)).map((a) => a.id));
    await client.query(
      `DELETE FROM rec_meeting_attivita WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3
          AND task_id IS NULL AND NOT (id::text = ANY($4::text[]))`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar, [...tenuti]]
    );
    let ordine = 0;
    for (const a of lista) {
      ordine += 1;
      if (a.id && esistenti.has(a.id)) {
        const dati = { ...a, ordine, updated_at: new Date().toISOString() };
        delete dati.id;
        const { data } = await encryptRowForWrite(db, 'rec_meeting_attivita', dati, { id: a.id });
        const cols = Object.keys(data);
        await client.query(
          `UPDATE rec_meeting_attivita SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
            WHERE id::text = $${cols.length + 1} AND tenant_id = $${cols.length + 2} AND user_id = $${cols.length + 3}`,
          [...cols.map((c) => data[c] === '' ? null : data[c]), a.id, req.user.tenant_id, req.user.user_id]
        );
      } else {
        await inserisciAttivita(client, req.user, m.id_calendar, a, ordine, 'manuale');
      }
    }
    if (typeof b.sintesi === 'string') {
      await client.query(
        `UPDATE rec_meeting SET recap_interno = $1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4`,
        [b.sintesi.trim() ? encRec(b.sintesi.trim().slice(0, 20000)) : null, req.user.tenant_id, req.user.user_id, m.id_calendar]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, attivita: lista.length });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    invia(res, e, 'SALVA');
  } finally { if (client) client.release(); }
});

// «Crea task»: { id_calendar, ids } -> una To-Do per attività (non ancora trasformata), assegnata
// all'owner (contatto di rubrica, oppure il nome scritto a mano), con cliente e progetto della
// riunione e la scadenza dell'attività.
router.post('/task', async (req, res) => {
  let client;
  try {
    await richiedeTabelle();
    const b = req.body || {};
    const m = await riunione(req.user, b.id_calendar);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => UUID_RE.test(x)).slice(0, 200);
    if (!ids.length) throw errore(400, 'Nessuna attività selezionata');
    const righe = (await db.query(
      `SELECT id::text AS id, argomento, descrizione, owner_nominativo, rubrica_id::text AS rubrica_id, scadenza::text AS scadenza
         FROM rec_meeting_attivita WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND task_id IS NULL AND id::text = ANY($4::text[])
        ORDER BY ordine`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar, ids]
    )).rows;
    if (!righe.length) throw errore(400, 'Le attività selezionate hanno già il loro task');
    const colTasks = new Set((await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks'")).rows.map((x) => x.column_name));
    const role = Number.isFinite(Number(req.user.id_roles)) ? Number(req.user.id_roles) : 90;
    const titolo = `${String(m.oggetto || 'Riunione').trim()} - Attività interne`.slice(0, 200);
    client = await db.connect();
    await client.query('BEGIN');
    let creati = 0;
    for (const a of righe) {
      const row = {
        tenant_id: req.user.tenant_id, user_id: req.user.user_id,
        client_id: m.client_id || null, project_id: m.project_id || null,
        tipo_task: 'Automatica', titile: titolo,
        description: `${a.argomento ? `${a.argomento}: ` : ''}${a.descrizione}`.slice(0, 4000),
        status: 'in_progress', priority: 'medium',
        assigned_to: a.rubrica_id || null,
        due_date: a.scadenza || null,
        data_inizio: m.data || null,
        scadenza: '2099-12-31', id_roles: role, id_roles_write: role,
        created_by: req.user.user_id, crypto: 1
      };
      if (!a.rubrica_id && a.owner_nominativo && colTasks.has('assigned_to_text')) row.assigned_to_text = a.owner_nominativo;
      const { data } = await encryptRowForWrite(db, 'tasks', row);
      const cols = Object.keys(data).filter((c) => colTasks.has(c));
      const t = await client.query(
        `INSERT INTO tasks (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => data[c])
      );
      await client.query('UPDATE rec_meeting_attivita SET task_id = $1 WHERE id::text = $2', [t.rows[0].id, a.id]);
      creati += 1;
    }
    await client.query('COMMIT');
    res.status(201).json({ creati });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    invia(res, e, 'TASK');
  } finally { if (client) client.release(); }
});

export default router;
