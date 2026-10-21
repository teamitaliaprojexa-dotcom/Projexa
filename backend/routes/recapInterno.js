// ============================================================================
// RECAP INTERNO DELLA RIUNIONE (2026-10-09) - API /api/recap-interno
// ----------------------------------------------------------------------------
// Finestra del recap › scheda «Recap interno» (sito/dashboard.html). Accanto al recap per il
// cliente (rec_meeting.recap, invariato) il project manager genera SU RICHIESTA un recap per il
// proprio team: una sintesi interna (rec_meeting.recap_interno) e l'elenco delle attività che il
// team deve fare (tabella rec_meeting_attivita), ognuna con owner e scadenza.
// La trascrizione non dice chi parla, quindi l'owner lo propone l'AI solo se il testo è chiaro e
// lo sceglie il PM tra le persone del team del progetto della riunione (o lo scrive a mano).
// Dalla scheda: «Crea task» (tasks assegnati agli owner) ed «Email al team» (nel browser).
//
// AI = quella del recap (Impostazioni › AI › «AI generazione e-mail recap»), prompt RECAP_INTERNO
// (config/prompts.js). La generazione gira in background: con «Projexa» può durare
// molti minuti; la pagina interroga lo stato e a fine lavoro arriva la notifica in campanella.
// Tabelle: Supporto/CreaDB/recap_interno.sql.
// ============================================================================
import express from 'express';
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { getPromptFor } from '../config/prompts.js';
import { askAiProvider, localRecapMode, askOllamaRecap, PROVIDERS as AI_PROVIDERS } from './ai.js';
import {
  recapSource, recapAiImpostata, recapEsecuzione, isChiediSempre, applyCorrections, stripMarkdown, encRec
} from '../jobs/meetingTranscription.js';
import { inviaPromptBatch, controllaRecapBatchUtente } from '../jobs/recapBatch.js';
import { parseDueDate } from '../jobs/recapTasks.js';
import { notificaRiunione } from '../jobs/notifiche.js';
import { avanzamentoRiunione } from '../config/lavoriProjexa.js';
import { cercaDoppione, aggiornamento, todoAperte, ownerTodo, aggiornaTodo } from '../config/dedupVoci.js';

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

// Persone proponibili come owner: SOLO il team del progetto della riunione (Kick-off,
// proj_componenti), completato con la rubrica. rubricaId serve ad assegnare il task al contatto giusto.
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
  // Solo le persone del team del progetto (scelta dell'utente, 2026-10-09): la rubrica serve
  // a completarle (contatto per assegnare il task, email se nel team manca), abbinata per email
  // o, in mancanza, per nominativo.
  const perNome = new Map(rb.map((x) => [norm(x.nominativo), x]));
  const out = [];
  const visti = new Set();
  for (const t of team) {
    const r = (t.email && perEmail.get(norm(t.email))) || perNome.get(norm(t.nominativo)) || null;
    const k = norm(t.email || t.nominativo);
    if (visti.has(k)) continue;
    visti.add(k);
    out.push({ nominativo: String(t.nominativo).trim(), email: t.email || (r && r.email) || '', rubricaId: r ? r.id : null, team: true });
  }
  return out.sort((a, b) => a.nominativo.localeCompare(b.nominativo, 'it'));
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

// Dati per il prompt: riunione, trascrizione corretta, persone del team e build(testo) -> prompt.
// Usata anche dall'insegnante notturno del recap (jobs/analisiRecap.js).
export async function prepara(user, idCalendar) {
  const m = await riunione(user, idCalendar);
  const { transcript, vars, rules } = await recapSource(user, idCalendar);
  const elenco = await persone(user, m);
  const team = elenco.filter((p) => p.team);
  const varsInt = { ...vars, TEAM: team.length ? team.map((p) => `- ${p.nominativo}`).join('\n') : '(nessuna persona indicata nel team del progetto)' };
  let tpl = (await getPromptFor('RECAP_INTERNO', user)).testo;
  if (!tpl.includes('{{TRASCRIZIONE}}')) tpl += '\n\nTrascrizione:\n{{TRASCRIZIONE}}';
  const build = (t) => tpl.replace(/\{\{(TRASCRIZIONE|OGGETTO|DATA|UTENTE|TEAM)\}\}/g, (x, k) => (k === 'TRASCRIZIONE' ? t : (varsInt[k] || '')));
  return { m, transcript, vars, rules, elenco, build };
}

// Generazione completa (in background) con l'AI indicata. Le attività già trasformate in task
// restano; le altre si sostituiscono con quelle nuove.
async function genera(user, idCalendar, providerName) {
  const p = await prepara(user, idCalendar);
  const r = localRecapMode(providerName) === 'server'
    ? await askOllamaRecap(async (t) => p.build(t), p.transcript, { meeting: true, contesto: p.vars.OGGETTO, ai: providerName, cosa: 'Recap interno', chiave: `${user.tenant_id}|${user.user_id}|${idCalendar}`, tipo: 'interno' })
    : await askAiProvider(user.user_id, providerName, p.build(p.transcript));
  await salvaInterno(user, idCalendar, p, r.text, r.label);
}

// «AI Automatizza (solo Batch)» a fine trascrizione (jobs/aiAutomatizza.js): recap interno in
// Batch con l'AI indicata, senza guardare «Esecuzione Recap». Restituisce
//   { modo: 'batch' }                                   richiesta inviata;
//   { modo: 'immediato', motivo, avvia }                Batch impossibile o rifiutato dall'AI:
//                                                       avvia() genera subito (in background);
// oppure lancia l'errore (tabelle mancanti, riunione senza trascrizione, chiave scollegata).
export async function avviaRecapInternoAutomatico(user, idCalendar, providerName) {
  await richiedeTabelle();
  const k = chiave(user, idCalendar);
  if (inCorso.has(k)) throw errore(409, 'Recap interno già in preparazione');
  const immediato = (motivo) => ({
    modo: 'immediato', motivo,
    avvia: async () => {
      inCorso.add(k);
      try {
        await impostaStato(user, idCalendar, 'in_corso');
        await genera(user, idCalendar, providerName);
      } catch (e) {
        await impostaStato(user, idCalendar, 'errore', String(e.message || e).slice(0, 1000)).catch(() => {});
        throw e;
      } finally {
        inCorso.delete(k);
      }
    }
  });
  if (localRecapMode(providerName) === 'server') return immediato('Projexa non ha la modalità Batch');
  const p = await prepara(user, idCalendar);
  try {
    await inviaPromptBatch(user, idCalendar, providerName, p.build(p.transcript), { tipo: 'recap_interno' });
  } catch (e) {
    if (e.status === 428) throw e; // AI non collegata: inutile riprovare in Immediato
    return immediato(e.message);
  }
  await impostaStato(user, idCalendar, 'batch');
  return { modo: 'batch' };
}

// Recap interno in modalità Batch arrivato dall'AI (jobs/recapBatch.js).
export async function completaRecapInternoBatch(user, idCalendar, testo, label) {
  await salvaInterno(user, idCalendar, await prepara(user, idCalendar), testo, label);
}
export async function erroreRecapInternoBatch(user, idCalendar, messaggio) {
  await impostaStato(user, idCalendar, 'errore', String(messaggio || 'Batch non riuscito').slice(0, 1000));
}

async function salvaInterno(user, idCalendar, { m, elenco, rules }, testoAi, label) {
  const testo = applyCorrections(String(testoAi || '').trim(), rules).text;
  const { sintesi, attivita } = leggiRecapInterno(testo, m.data);
  if (!sintesi && !attivita.length) throw errore(502, `${label} non ha restituito un recap interno leggibile: riprova`);

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
  console.log(`[RECAP INTERNO] ✓ ${attivita.length} attività con ${label} per la riunione ${idCalendar}`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const m = await riunione(req.user, req.query.id_calendar);
    const pronte = await tabellePronte();
    // Con «Chiedi sempre» l'AI la sceglie l'utente a ogni generazione: non se ne mostra una.
    const impostata = await recapAiImpostata(req.user);
    const ai = isChiediSempre(impostata) ? '' : impostata;
    if (!pronte) return res.json({ tabelle: false, stato: null, attivita: [], riunione: m, ai: { nome: ai, locale: localRecapMode(ai) === 'server' } });
    const r = (await db.query(
      `SELECT recap_interno, recap_interno_stato, recap_interno_il, recap_interno_errore FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    )).rows[0] || {};
    let stato = r.recap_interno_stato || null;
    // In attesa del Batch: si controlla subito presso l'AI (in background).
    if (stato === 'batch') controllaRecapBatchUtente(req.user);
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

// Avanzamento di recap cliente e recap interno con Projexa (barra della finestra Recap,
// 2026-10-21): solo memoria del backend (config/lavoriProjexa.js), nessuna query né carico per
// la VM. Query: id_calendar. Risposta: { lavori: [{ tipo, modello, fase, percento, dal, inAttesa }] }.
router.get('/avanzamento', (req, res) => {
  const id = String(req.query.id_calendar || '').trim().slice(0, 300);
  res.json({ lavori: id ? avanzamentoRiunione(`${req.user.tenant_id}|${req.user.user_id}|${id}`) : [] });
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
    // Stesse regole del pulsante Recap: con «Chiedi sempre» AI ed esecuzione arrivano dalla
    // finestra di scelta (body.ai, body.esecuzione).
    const b = req.body || {};
    let providerName = await recapAiImpostata(req.user);
    if (isChiediSempre(providerName)) {
      providerName = String(b.ai || '').trim();
      if (!providerName) throw errore(400, 'Scegli l\'AI da usare per il recap interno');
    }
    if (!providerName) throw errore(400, 'Scegli l\'AI in Impostazioni › AI › «AI generazione e-mail recap»');
    const locale = localRecapMode(providerName) === 'server';
    if (!locale && !AI_PROVIDERS[providerName.toLowerCase()]) throw errore(400, `AI «${providerName}» non utilizzabile per il recap interno`);
    let esecuzione = await recapEsecuzione(req.user);
    if (esecuzione === 'chiedi') {
      esecuzione = String(b.esecuzione || '').trim().toLowerCase();
      if (!['immediato', 'batch'].includes(esecuzione)) throw errore(400, 'Scegli se eseguire il recap interno Immediato o in Batch');
    }
    const k = chiave(req.user, m.id_calendar);
    if (inCorso.has(k)) throw errore(409, 'Il recap interno di questa riunione è già in preparazione');
    const user = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, email: req.user.email, id_roles: req.user.id_roles };
    // Batch (non per Projexa, già gratuito): metà prezzo, risposta entro 24 ore; la
    // raccoglie jobs/recapBatch.js (o il controllo all'apertura della scheda).
    let nota = '';
    if (esecuzione === 'batch' && !locale) {
      try {
        const p = await prepara(user, m.id_calendar);
        const r = await inviaPromptBatch(user, m.id_calendar, providerName, p.build(p.transcript), { tipo: 'recap_interno' });
        await impostaStato(req.user, m.id_calendar, 'batch');
        return res.status(202).json({ avviato: true, batch: true, provider: r.provider });
      } catch (e) {
        // Piano senza Batch (es. Gemini gratuito): si genera subito, al prezzo normale.
        if (e.code !== 'BATCH_NON_DISPONIBILE') throw e;
        nota = e.message;
      }
    }
    inCorso.add(k);
    await impostaStato(req.user, m.id_calendar, 'in_corso');
    genera(user, m.id_calendar, providerName)
      .catch(async (e) => {
        console.error(`❌ RECAP_INTERNO ${m.id_calendar}:`, e.message);
        await impostaStato(user, m.id_calendar, 'errore', String(e.message || e).slice(0, 1000)).catch(() => {});
      })
      .finally(() => inCorso.delete(k));
    res.status(202).json({ avviato: true, nota });
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
    // Le attività si bloccano (FOR UPDATE) e si ricontrolla task_id dentro la transazione:
    // due «Crea task» insieme (doppio clic, due schede) creavano task doppi. 2026-10-17
    const libere = new Set((await client.query(
      `SELECT id::text AS id FROM rec_meeting_attivita
        WHERE tenant_id = $1 AND user_id = $2 AND id::text = ANY($3::text[]) AND task_id IS NULL FOR UPDATE`,
      [req.user.tenant_id, req.user.user_id, righe.map((a) => a.id)]
    )).rows.map((x) => x.id));
    let creati = 0, aggiornati = 0, giaPresenti = 0;
    // Doppioni (2026-10-20): attività già presente tra le To-Do aperte del progetto (riparlata in
    // una riunione successiva) -> niente To-Do nuova; le informazioni in più si aggiungono a
    // quella esistente e l'attività del recap si collega a lei (config/dedupVoci.js).
    const esistenti = await todoAperte(req.user, { projectId: m.project_id, clientId: m.client_id });
    const dataRiu = m.data ? String(m.data).slice(0, 10).split('-').reverse().join('/') : '';
    for (const a of righe) {
      if (!libere.has(a.id)) continue;
      const descrizioneNuova = `${a.argomento ? `${a.argomento}: ` : ''}${a.descrizione}`.slice(0, 4000);
      const owner = await ownerTodo(req.user, a.rubrica_id, a.owner_nominativo);
      const doppione = cercaDoppione({ registro: 'todo', titolo, descrizione: descrizioneNuova, owner }, esistenti);
      if (doppione) {
        const nuova = aggiornamento(doppione.descrizione, descrizioneNuova, { data: dataRiu, fonte: String(m.oggetto || '').trim() });
        if (await aggiornaTodo(client, req.user, doppione, { descrizione: nuova, dueDate: a.scadenza || null })) aggiornati += 1; else giaPresenti += 1;
        await client.query('UPDATE rec_meeting_attivita SET task_id = $1 WHERE id::text = $2 AND task_id IS NULL', [doppione.id, a.id]);
        continue;
      }
      const row = {
        tenant_id: req.user.tenant_id, user_id: req.user.user_id,
        client_id: m.client_id || null, project_id: m.project_id || null,
        tipo_task: 'Automatica', titile: titolo,
        description: descrizioneNuova,
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
      await client.query('UPDATE rec_meeting_attivita SET task_id = $1 WHERE id::text = $2 AND task_id IS NULL', [t.rows[0].id, a.id]);
      creati += 1;
      // Anche tra le attività di questo stesso «Crea task».
      esistenti.push({ id: String(t.rows[0].id), registro: 'todo', titolo, descrizione: descrizioneNuova, owner, due_date: a.scadenza || null });
    }
    await client.query('COMMIT');
    res.status(201).json({ creati, aggiornati, giaPresenti });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    invia(res, e, 'TASK');
  } finally { if (client) client.release(); }
});

export default router;
