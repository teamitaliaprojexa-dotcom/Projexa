// ============================================================================
// CHI PARLA NELLA RIUNIONE (2026-11-12) - API /api/parlanti
// ----------------------------------------------------------------------------
// Pannello «Chi parla» durante la registrazione e finestra «Assegna nomi» (sito/dashboard.html).
// Logica in config/parlanti.js; tabella Supporto/CreaDB/rec_meeting_parlanti.sql.
//   POST   /persone    icone: partecipanti dell'invito (calendario + Add-in Outlook), con foto
//                      e contatto di rubrica / del cliente quando si riconoscono
//   GET    /cerca      ricerca in rubrica e tra i contatti del cliente della riunione
//   POST   /clic       «sta parlando lui/lei» al secondo indicato della registrazione
//   DELETE /clic/ultimo annulla l'ultimo clic
//   POST   /attendi    allo Stop: il recap aspetta i nomi dei «Partecipante N» rimasti
//   GET    /etichette  etichette della trascrizione (con frasi d'esempio) e stato dell'attesa
//   POST   /assegna    rinomina etichette (trascrizione, recap, attività, To-Do, azioni cliente)
// Nessuno di questi dati va all'AI.
// ============================================================================
import express from 'express';
import db from '../config/database.js';
import { encRec, speakerName, sbloccaFinalize } from '../jobs/meetingTranscription.js';
import { infoPerRiunione } from '../config/riunioniOutlook.js';
import { tabellaPronta, etichetteTrascrizione, rinominaParlanti, pulisciNome } from '../config/parlanti.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errore = (status, message) => Object.assign(new Error(message), { status });
const invia = (res, e, tag) => {
  if (!e.status) console.error(`❌ PARLANTI ${tag}:`, e.message);
  res.status(e.status || 500).json({ error: e.message });
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').trim();
const chiaveNome = (s) => norm(s).split(' ').filter(Boolean).sort().join(' '); // «Rossi Mario» = «Mario Rossi»

async function riunione(user, idCalendar) {
  const id = String(idCalendar || '').trim();
  if (!id) throw errore(400, 'Riunione non indicata');
  const m = (await db.query(
    `SELECT id_calendar, oggetto, client_id::text AS client_id, to_char(data_calendar, 'YYYY-MM-DD') AS data,
            to_char(orario_calendar, 'HH24:MI') AS ora
       FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, id]
  )).rows[0];
  if (!m) throw errore(404, 'Riunione non gestita con Projexa');
  return m;
}
async function richiedeTabella() {
  if (!(await tabellaPronta())) throw errore(503, 'Funzione non ancora attiva: va eseguito lo script Supporto/CreaDB/rec_meeting_parlanti.sql sul database');
}

async function rubricaUtente(user) {
  return (await db.query(
    `SELECT id::text AS id, nominativo, email, ruolo, (foto IS NOT NULL) AS foto FROM rubrica
      WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) LIMIT 3000`,
    [user.tenant_id, user.user_id]
  )).rows.filter((x) => x.nominativo);
}
async function contattiCliente(user, clientId) {
  if (!clientId) return [];
  try {
    return (await db.query(
      `SELECT id::text AS id, nominativo, email, qualifica FROM contacts WHERE tenant_id = $1 AND client_id::text = $2 LIMIT 2000`,
      [user.tenant_id, clientId]
    )).rows.filter((x) => String(x.nominativo || '').trim());
  } catch { return []; }
}

// Persona dall'invito -> arricchita con rubrica (foto) e contatti del cliente.
function arricchisci(p, rb, ct) {
  const em = norm(p.email);
  const kn = chiaveNome(p.nominativo);
  const r = rb.find((x) => em && norm(x.email) === em) || rb.find((x) => kn && chiaveNome(x.nominativo) === kn);
  const c = ct.find((x) => em && norm(x.email) === em) || ct.find((x) => kn && chiaveNome(x.nominativo) === kn);
  return {
    nominativo: String((r && r.nominativo) || (c && String(c.nominativo).trim()) || p.nominativo || p.email || '').trim(),
    email: p.email || (r && r.email) || (c && c.email) || '',
    rubrica_id: r ? r.id : null,
    contact_id: c ? c.id : null,
    foto: !!(r && r.foto),
    ruolo: (r && r.ruolo) || (c && c.qualifica) || '',
    fonte: r ? 'rubrica' : c ? 'cliente' : 'invito'
  };
}

router.post('/persone', async (req, res) => {
  try {
    const m = await riunione(req.user, req.body && req.body.id_calendar);
    const invitati = (Array.isArray(req.body.invitati) ? req.body.invitati : []).slice(0, 60)
      .map((x) => ({ nominativo: pulisciNome(x && x.nome), email: String((x && x.email) || '').trim().toLowerCase() }))
      .filter((x) => x.nominativo || /@/.test(x.email));
    // Appuntamento collegato dall'Add-in di Outlook (anche con il calendario condiviso).
    if (m.data && m.ora) {
      const info = await infoPerRiunione(req.user, { data: m.data, ora: m.ora, oggetto: m.oggetto }).catch(() => null);
      if (info) {
        for (const p of [info.organizzatore, ...(info.partecipanti || [])]) {
          if (!p) continue;
          invitati.push({ nominativo: pulisciNome(p.nome), email: String(p.email || '').trim().toLowerCase() });
        }
      }
    }
    const io = { nome: chiaveNome(await speakerName(req.user)), email: norm(req.user.email) };
    const [rb, ct] = await Promise.all([rubricaUtente(req.user), contattiCliente(req.user, m.client_id)]);
    const out = [];
    const visti = new Set();
    for (const p of invitati) {
      const x = arricchisci(p, rb, ct);
      if (!x.nominativo) continue;
      const kn = chiaveNome(x.nominativo);
      if ((io.email && norm(x.email) === io.email) || (io.nome && kn === io.nome)) continue; // la mia voce: il microfono
      const k = x.rubrica_id || x.contact_id || norm(x.email) || kn;
      if (!k || visti.has(k) || visti.has(kn)) continue;
      visti.add(k); visti.add(kn);
      out.push(x);
    }
    res.json({ persone: out, cliente: !!m.client_id, tabella: await tabellaPronta() });
  } catch (e) { invia(res, e, 'PERSONE'); }
});

router.get('/cerca', async (req, res) => {
  try {
    const m = await riunione(req.user, req.query.id_calendar);
    const q = norm(req.query.q);
    if (q.length < 2) return res.json({ rubrica: [], cliente: [] });
    const parti = q.split(' ').filter(Boolean);
    const trova = (testo) => { const t = norm(testo); return parti.every((p) => t.includes(p)); };
    const [rb, ct] = await Promise.all([rubricaUtente(req.user), contattiCliente(req.user, m.client_id)]);
    res.json({
      rubrica: rb.filter((x) => trova(`${x.nominativo} ${x.email || ''}`)).slice(0, 15)
        .map((x) => ({ nominativo: x.nominativo, email: x.email || '', rubrica_id: x.id, contact_id: null, foto: !!x.foto, ruolo: x.ruolo || '', fonte: 'rubrica' })),
      cliente: ct.filter((x) => trova(`${x.nominativo} ${x.email || ''}`)).slice(0, 15)
        .map((x) => {
          const r = rb.find((y) => x.email && norm(y.email) === norm(x.email));
          return { nominativo: String(x.nominativo).trim(), email: x.email || '', rubrica_id: r ? r.id : null, contact_id: x.id, foto: !!(r && r.foto), ruolo: x.qualifica || '', fonte: 'cliente' };
        }),
      haCliente: !!m.client_id
    });
  } catch (e) { invia(res, e, 'CERCA'); }
});

router.post('/clic', async (req, res) => {
  try {
    await richiedeTabella();
    const b = req.body || {};
    const m = await riunione(req.user, b.id_calendar);
    const sec = Number(b.sec);
    if (!Number.isFinite(sec) || sec < 0 || sec > 86400) throw errore(400, 'Orario non valido');
    const nominativo = pulisciNome(b.nominativo);
    if (!nominativo) throw errore(400, 'Persona non indicata');
    await db.query(
      `INSERT INTO rec_meeting_parlanti (tenant_id, user_id, id_calendar, sec, nominativo, email, rubrica_id, contact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar, Math.round(sec * 10) / 10, encRec(nominativo),
        b.email ? encRec(String(b.email).trim().slice(0, 300)) : null,
        UUID_RE.test(String(b.rubrica_id || '')) ? b.rubrica_id : null, UUID_RE.test(String(b.contact_id || '')) ? b.contact_id : null]
    );
    res.status(201).json({ ok: true });
  } catch (e) { invia(res, e, 'CLIC'); }
});

router.delete('/clic/ultimo', async (req, res) => {
  try {
    await richiedeTabella();
    const m = await riunione(req.user, req.query.id_calendar);
    const r = await db.query(
      `DELETE FROM rec_meeting_parlanti WHERE id = (
         SELECT id FROM rec_meeting_parlanti WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 ORDER BY id DESC LIMIT 1)`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    );
    res.json({ ok: true, tolti: r.rowCount });
  } catch (e) { invia(res, e, 'ANNULLA'); }
});

router.post('/attendi', async (req, res) => {
  try {
    await richiedeTabella();
    const m = await riunione(req.user, req.body && req.body.id_calendar);
    await db.query(
      `UPDATE rec_meeting SET parlanti_stato = 'attesa', parlanti_attesa_fino = NULL WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    );
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'ATTENDI'); }
});

// stato: 'trascrizione' (diarizzazione non ancora fatta), 'da_assegnare' (il recap aspetta),
// 'fatto' / null (nessuna attesa).
router.get('/etichette', async (req, res) => {
  try {
    const m = await riunione(req.user, req.query.id_calendar);
    const pronta = await tabellaPronta();
    const r = (await db.query(
      `SELECT trascrizione${pronta ? ', parlanti_stato, parlanti_attesa_fino' : ''} FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
      [req.user.tenant_id, req.user.user_id, m.id_calendar]
    )).rows[0] || {};
    let stato = r.parlanti_stato || null;
    if (stato === 'attesa') stato = r.parlanti_attesa_fino ? (new Date(r.parlanti_attesa_fino) > new Date() ? 'da_assegnare' : 'fatto') : 'trascrizione';
    res.json({ stato, attesa_fino: r.parlanti_attesa_fino || null, etichette: await etichetteTrascrizione(req.user, r.trascrizione), tabella: pronta });
  } catch (e) { invia(res, e, 'ETICHETTE'); }
});

// { id_calendar, mappa: [{ da, a: { nominativo, email, rubrica_id, contact_id } }], collegati, sblocca }
router.post('/assegna', async (req, res) => {
  try {
    const b = req.body || {};
    const m = await riunione(req.user, b.id_calendar);
    const conti = await rinominaParlanti(req.user, m.id_calendar, b.mappa, { collegati: b.collegati !== false });
    // Finestra dello Stop (anche con «Salta»): il recap in attesa parte subito.
    if (b.sblocca && await tabellaPronta()) await sbloccaFinalize(req.user, m.id_calendar);
    res.json({ ok: true, ...conti });
  } catch (e) { invia(res, e, 'ASSEGNA'); }
});

export default router;
