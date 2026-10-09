// ============================================================================
// CRUSCOTTO PM E PORTFOLIO (funzioni da Project Manager senior, 2026-10-09)
// ----------------------------------------------------------------------------
// API sotto /api/pm (montate in server.js con requireAuth). Pagine: sito/pm.html (Cruscotto
// del progetto), sito/portfolio.html (tutti i progetti), sito/pm-documento.html (Status Report
// e Verbale di chiusura da stampare). Tabelle: Supporto/CreaDB/pm_senior.sql.
//
// Regole comuni:
//   - si lavora SOLO sui progetti di cui l'utente è proprietario (tenant + utente del login),
//     come Check List, Kick-off e Offerta (il Manager non vede qui i progetti del team);
//   - le righe nuove hanno id_roles_write = ruolo di chi le crea; si modificano solo con lo
//     stesso ruolo (o da admin), come nel resto dell'app;
//   - le righe non si cancellano: «Elimina» le chiude (scadenza = ieri);
//   - i testi liberi si cifrano a riposo (encryptRowForWrite, regole in config/crypto.js);
//   - l'AI è quella di Impostazioni › AI (pmCore.aiPerPm); i prompt sono in app_prompts.
// ============================================================================
import express from 'express';
import db from '../config/database.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { getPromptFor } from '../config/prompts.js';
import { sendMail } from '../config/mailer.js';
import * as OffertaDocx from '../config/offertaDocx.js';
import { leggiRispostaAi } from '../config/kickoffPptx.js';
import { speakerName, stripMarkdown } from '../jobs/meetingTranscription.js';
import { costruisciDigest, emailUtente } from '../jobs/pmJobs.js';
import {
  UUID_RE, errore, oggiIso, dataIt, dataIso, numero, fmt, euro, tabellaPresente, colonneTabella,
  progettoUtente, schedaProgetto, campiProgetto, economiaProgetto, saluteProgetto, saluteTuttiProgetti, righeGantt, analisiGantt,
  raidProgetto, crProgetto, taskProgetto, issueProgetto, riunioniProgetto, contestoProgetto,
  aiPerPm, chiediAi, leggiJson
} from '../config/pmCore.js';

const router = express.Router();

const invia = (res, e, tag) => {
  if (!e.statusCode && !e.status) console.error(`❌ PM ${tag}:`, e.message);
  res.status(e.statusCode || e.status || 500).json({ error: e.message });
};
const ruolo = (req) => (Number.isFinite(Number(req.user?.id_roles)) ? String(Number(req.user.id_roles)) : null);
const isAdmin = (req) => Number(req.user?.id_roles) === 1;
const READ_ONLY = 'Sola lettura: il tuo ruolo non può modificare questo elemento';
function puoScrivere(req, idRolesWrite) {
  if (isAdmin(req)) return true;
  const r = ruolo(req);
  if (r == null) return false;
  return String(idRolesWrite ?? '').split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean).includes(r);
}
async function richiedeTabella(nome) {
  if (!(await tabellaPresente(nome))) throw errore(503, 'Funzione non ancora attiva: va eseguito lo script Supporto/CreaDB/pm_senior.sql sul database');
}
const nowStamp = () => new Date().toISOString();
const testo = (v, max = 4000) => (v == null ? null : (String(v).trim().slice(0, max) || null));
const intero = (v, min, max) => {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw errore(400, 'Valore numerico non valido');
  if (min != null && (n < min || n > max)) throw errore(400, `Il valore deve essere tra ${min} e ${max}`);
  return n;
};
const decimale = (v) => {
  if (v === '' || v == null) return null;
  const n = numero(v);
  if (n == null) throw errore(400, 'Valore numerico non valido');
  return n;
};
const unoCinque = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : null; };
const dataOpz = (v) => {
  if (v === '' || v == null) return null;
  const d = dataIso(v);
  if (!d) throw errore(400, 'Data non valida');
  return d;
};
const scelta = (v, ammessi, def) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  if (!ammessi.includes(s)) throw errore(400, `Valore non ammesso: ${v}`);
  return s;
};

// INSERT / UPDATE con cifratura dei testi liberi.
async function inserisci(client, tabella, dati) {
  const { data } = await encryptRowForWrite(db, tabella, dati);
  const cols = Object.keys(data);
  const r = await client.query(
    `INSERT INTO ${tabella} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`,
    cols.map((c) => data[c])
  );
  return r.rows[0].id;
}
async function aggiorna(req, tabella, id, projectId, dati, { conUpdatedAt = true } = {}) {
  if (!UUID_RE.test(String(id))) throw errore(400, 'Id non valido');
  const r = (await db.query(
    `SELECT id_roles_write FROM ${tabella} WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3 AND project_id::text = $4`,
    [id, req.user.tenant_id, req.user.user_id, projectId]
  )).rows[0];
  if (!r) throw errore(404, 'Elemento non trovato');
  if (!puoScrivere(req, r.id_roles_write)) throw errore(403, READ_ONLY);
  const { data } = await encryptRowForWrite(db, tabella, dati, { id });
  const cols = Object.keys(data);
  if (!cols.length) return;
  await db.query(
    `UPDATE ${tabella} SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}${conUpdatedAt ? ', updated_at = now()' : ''}
      WHERE id::text = $${cols.length + 1} AND tenant_id = $${cols.length + 2} AND user_id = $${cols.length + 3}`,
    [...cols.map((c) => data[c]), id, req.user.tenant_id, req.user.user_id]
  );
}
async function chiudi(req, tabella, id, projectId) {
  await aggiorna(req, tabella, id, projectId, {}, { conUpdatedAt: false });
  await db.query(`UPDATE ${tabella} SET scadenza = CURRENT_DATE - 1 WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
    [id, req.user.tenant_id, req.user.user_id]);
}
const baseRiga = (req, prog) => ({
  tenant_id: req.user.tenant_id, user_id: req.user.user_id, client_id: prog.clientId || null, project_id: prog.projectId,
  id_roles_write: ruolo(req), crypto: 1
});
const conPermesso = (req, righe) => righe.map((x) => ({ ...x, puoModificare: puoScrivere(req, x.id_roles_write), id_roles_write: undefined }));
const pid = (req) => (req.query && req.query.projectId) || (req.body && req.body.projectId);

// ============================================================================
// CRUSCOTTO E PORTFOLIO
// ============================================================================
router.get('/progetto', async (req, res) => {
  try {
    const salute = await saluteProgetto(req.user, pid(req));
    const ai = await aiPerPm(req.user);
    // Campo Gantt (tipo 13) della scheda: serve al link «Apri il Gantt».
    const campi = await campiProgetto(req.user, salute.progetto.projectId);
    const g = (await db.query(
      `SELECT id::text AS id, campo FROM projects WHERE tenant_id = $1 AND user_id = $2 AND argument = ANY($3::text[])
          AND tipo_valore::text = '13' AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) ORDER BY id LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, campi.sezioni])).rows[0] || null;
    res.json({ ...salute, oggi: oggiIso(), ai: ai ? { nome: ai.nome, locale: ai.locale } : null, tabelle: await tabellaPresente('pm_raid'),
      ganttCampo: g ? { fieldId: g.id, label: String(g.campo || '').replace(/^\(\*\)\s*/, '') } : null });
  } catch (e) { invia(res, e, 'PROGETTO'); }
});

router.get('/portfolio', async (req, res) => {
  try {
    const tutti = await saluteTuttiProgetti(req.user);
    res.json({
      oggi: oggiIso(),
      progetti: tutti.map((s) => ({
        progetto: s.progetto, semaforo: s.semaforo, errore: s.errore || null,
        indicatori: s.indicatori, eac: s.eac || null, conteggi: s.conteggi || null,
        start: s.scheda ? s.scheda.start : null, end: s.scheda ? s.scheda.end : null,
        tipologia: s.scheda ? s.scheda.tipologia : '', stato: s.scheda ? s.scheda.stato : '',
        gantt: s.gantt ? { inizio: s.gantt.inizio, fine: s.gantt.fine, baselineFine: s.gantt.baselineFine, completamento: s.gantt.completamento, milestone: s.gantt.milestone, inRitardo: s.gantt.inRitardo.length } : null
      }))
    });
  } catch (e) { invia(res, e, 'PORTFOLIO'); }
});

// ============================================================================
// RAID (Rischi, Azioni = To-Do, Issue, Decisioni + dipendenze e assunzioni)
// ============================================================================
router.get('/raid', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const [raid, task, issue] = await Promise.all([
      raidProgetto(req.user, prog.projectId, { tutte: req.query.tutte === '1' }),
      taskProgetto(req.user, prog.projectId), issueProgetto(req.user, prog.projectId)
    ]);
    res.json({ raid: conPermesso(req, raid), task, issue, tabelle: await tabellaPresente('pm_raid') });
  } catch (e) { invia(res, e, 'RAID'); }
});

function datiRaid(b, parziale = false) {
  const d = {};
  const set = (k, v) => { if (!parziale || Object.prototype.hasOwnProperty.call(b, k)) d[k] = v; };
  set('tipo', scelta(b.tipo, ['rischio', 'decisione', 'dipendenza', 'assunzione'], 'rischio'));
  set('titolo', testo(b.titolo, 500));
  set('descrizione', testo(b.descrizione));
  set('probabilita', intero(b.probabilita, 1, 5));
  set('impatto', intero(b.impatto, 1, 5));
  set('owner', testo(b.owner, 300));
  set('mitigazione', testo(b.mitigazione));
  set('data_revisione', dataOpz(b.data_revisione));
  set('decisa_da', testo(b.decisa_da, 300));
  set('stato', scelta(b.stato, ['aperto', 'in_corso', 'chiuso'], 'aperto'));
  if (!parziale && !d.titolo) throw errore(400, 'Il titolo è obbligatorio');
  if (parziale && 'titolo' in d && !d.titolo) throw errore(400, 'Il titolo è obbligatorio');
  return d;
}

router.post('/raid', async (req, res) => {
  try {
    await richiedeTabella('pm_raid');
    const prog = await progettoUtente(req.user, pid(req));
    const id = await inserisci(db, 'pm_raid', { ...baseRiga(req, prog), ...datiRaid(req.body || {}), origine: 'manuale' });
    res.status(201).json({ id });
  } catch (e) { invia(res, e, 'RAID_NEW'); }
});
router.put('/raid/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_raid');
    const prog = await progettoUtente(req.user, pid(req));
    await aggiorna(req, 'pm_raid', req.params.id, prog.projectId, datiRaid(req.body || {}, true));
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'RAID_UPD'); }
});
// Riapre una riga tolta dal registro (scadenza di nuovo «nessuna scadenza»).
router.post('/raid/:id/riapri', async (req, res) => {
  try {
    await richiedeTabella('pm_raid');
    const prog = await progettoUtente(req.user, pid(req));
    await aggiorna(req, 'pm_raid', req.params.id, prog.projectId, {});
    await db.query(`UPDATE pm_raid SET scadenza = '2099-12-31', updated_at = now() WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3`,
      [req.params.id, req.user.tenant_id, req.user.user_id]);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'RAID_RIAPRI'); }
});
router.delete('/raid/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_raid');
    const prog = await progettoUtente(req.user, pid(req));
    await chiudi(req, 'pm_raid', req.params.id, prog.projectId);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'RAID_DEL'); }
});

// Riunioni del progetto con recap o trascrizione (scelta della riunione da cui estrarre).
router.get('/riunioni', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const r = await riunioniProgetto(req.user, prog.projectId, { limite: 30, conTrascrizione: true });
    let estratte = new Set();
    if (await tabellaPresente('pm_raid')) {
      estratte = new Set((await db.query(
        `SELECT DISTINCT id_calendar FROM pm_raid WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND id_calendar IS NOT NULL`,
        [req.user.tenant_id, req.user.user_id, prog.projectId])).rows.map((x) => x.id_calendar));
    }
    res.json(r.map((m) => ({ id_calendar: m.id_calendar, oggetto: m.oggetto || 'Riunione', data: m.data, haRecap: !!m.recap, giaEstratta: estratte.has(m.id_calendar) })));
  } catch (e) { invia(res, e, 'RIUNIONI'); }
});

// Progetto collegato a una riunione (pulsante «Rischi e decisioni» della finestra del recap).
router.get('/riunione', async (req, res) => {
  try {
    const m = (await db.query(
      `SELECT project_id::text AS p FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, String(req.query.id_calendar || '')])).rows[0];
    if (!m) throw errore(404, 'Riunione non gestita con Projexa');
    if (!m.p) throw errore(400, 'Collega prima la riunione a un cliente e a un progetto (tendine nella riga della riunione)');
    await progettoUtente(req.user, m.p);
    res.json({ projectId: m.p });
  } catch (e) { invia(res, e, 'RIUNIONE'); }
});

// Proposta AI di rischi, decisioni e dipendenze dal recap (o dalla trascrizione) di una riunione.
// Body: { projectId?, id_calendar }. Se la riunione è collegata a un progetto si usa quello.
router.post('/raid/estrai', async (req, res) => {
  try {
    const idCal = String((req.body && req.body.id_calendar) || '').trim();
    if (!idCal) throw errore(400, 'Riunione non indicata');
    const m = (await db.query(
      `SELECT id_calendar, oggetto, data_calendar::text AS data, recap, trascrizione, project_id::text AS project_id
         FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [req.user.tenant_id, req.user.user_id, idCal])).rows[0];
    if (!m) throw errore(404, 'Riunione non gestita con Projexa');
    const projectId = m.project_id || pid(req);
    if (!projectId) throw errore(400, 'Collega prima la riunione a un progetto (tendina Progetto nella riga della riunione)');
    const prog = await progettoUtente(req.user, projectId);
    const base = stripMarkdown(String(m.recap || '')).trim() || String(m.trascrizione || '').trim();
    if (!base) throw errore(400, 'La riunione non ha né recap né trascrizione');
    const [esistenti, crEsistenti] = await Promise.all([raidProgetto(req.user, prog.projectId), crProgetto(req.user, prog.projectId)]);
    const righeGia = [...esistenti.map((x) => `- (${x.tipo}) ${x.titolo}`), ...crEsistenti.map((x) => `- (change request ${x.codice || ''}) ${x.titolo}`)];
    const gia = righeGia.length ? righeGia.join('\n') : '(nessuno)';
    const vars = {
      PROGETTO: prog.nome, OGGETTO: m.oggetto || 'Riunione', DATA_RIUNIONE: dataIt(m.data), TESTO: base.slice(0, 120000), GIA_PRESENTI: gia
    };
    let tpl = (await getPromptFor('RAID_ESTRAZIONE', req.user)).testo;
    // Prompt salvato prima delle Change Request (standard già nel database o personalizzato):
    // le istruzioni per riconoscerle si aggiungono qui, così funziona senza ritoccare il prompt.
    if (!/change_request/i.test(tpl)) tpl += `\n\n${CR_ISTRUZIONI}`;
    const build = () => tpl.replace(/\{\{(PROGETTO|OGGETTO|DATA_RIUNIONE|TESTO|GIA_PRESENTI)\}\}/g, (x, k) => vars[k]);
    const r = await chiediAi(req.user, build, '', { json: true });
    const j = leggiJson(r.testo);
    if (!j) throw errore(502, `${r.label} non ha restituito un elenco leggibile: riprova`);
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9àèéìòù ]/g, '').replace(/\s+/g, ' ').trim();
    const titoli = new Set([...esistenti, ...crEsistenti].map((x) => norm(x.titolo)));
    const mappa = (arr, tipo) => (Array.isArray(arr) ? arr : []).filter((x) => x && x.titolo).map((x) => ({
      tipo,
      titolo: String(x.titolo).slice(0, 500),
      descrizione: x.descrizione ? String(x.descrizione) : '',
      probabilita: tipo === 'rischio' ? unoCinque(x.probabilita) : null,
      impatto: tipo === 'rischio' ? unoCinque(x.impatto) : null,
      owner: x.owner ? String(x.owner) : '',
      mitigazione: x.mitigazione ? String(x.mitigazione) : '',
      decisa_da: x.decisa_da ? String(x.decisa_da) : '',
      data_revisione: tipo === 'decisione' ? (dataIso(x.data) || m.data) : null,
      esiste: titoli.has(norm(x.titolo))
    }));
    res.json({
      progetto: { id: prog.projectId, nome: prog.nome }, riunione: { id_calendar: m.id_calendar, oggetto: m.oggetto, data: m.data },
      ai: `${r.label}${r.model ? ` (${r.model})` : ''}`,
      elementi: [...mappa(j.rischi, 'rischio'), ...mappa(j.decisioni, 'decisione'), ...mappa(j.dipendenze, 'dipendenza'),
        // Change Request: richieste del cliente che cambiano lo scope (diventano Bozze).
        ...(Array.isArray(j.change_request) ? j.change_request : []).filter((x) => x && x.titolo).map((x) => ({
          tipo: 'change_request',
          titolo: String(x.titolo).slice(0, 500),
          descrizione: x.descrizione ? String(x.descrizione) : '',
          motivo: x.motivo ? String(x.motivo) : '',
          richiesta_da: x.richiesta_da ? String(x.richiesta_da) : '',
          effort_delta: numero(x.effort),
          giorni_delta: Number.isFinite(numero(x.giorni)) ? Math.round(numero(x.giorni)) : null,
          esiste: titoli.has(norm(x.titolo))
        }))]
    });
  } catch (e) { invia(res, e, 'RAID_ESTRAI'); }
});

// Istruzioni per le Change Request, aggiunte ai prompt RAID_ESTRAZIONE salvati prima che esistessero.
const CR_ISTRUZIONI = `IN PIÙ individua le CHANGE REQUEST: richieste del cliente (o concordate in riunione) che CAMBIANO LO SCOPE del progetto rispetto a quanto previsto: funzioni, moduli, report o attività in più o in meno, cambi di requisiti, spostamenti di date chiesti dal cliente. Non sono change request i chiarimenti, le attività già previste, i problemi da risolvere (quelli sono rischi o issue).
Aggiungile all'oggetto JSON della risposta nella lista "change_request":
"change_request": [{"titolo": "...", "descrizione": "cosa cambia rispetto allo scope", "motivo": "perché il cliente lo chiede", "richiesta_da": "chi l'ha chiesta", "effort": 0, "giorni": 0}]
"effort" = ore o giornate in più se dette in riunione (negativo se in meno), altrimenti null; "giorni" = slittamento della data di fine se detto, altrimenti null. Non stimare tu effort o giorni: solo se sono detti. Lista vuota se non ce ne sono. Non ripetere le change request già presenti nell'elenco qui sopra.`;

// Salva gli elementi confermati: { projectId, id_calendar, elementi: [...] }.
router.post('/raid/importa', async (req, res) => {
  let client;
  try {
    await richiedeTabella('pm_raid');
    const b = req.body || {};
    const prog = await progettoUtente(req.user, b.projectId);
    const idCal = testo(b.id_calendar, 300);
    const tutti = (Array.isArray(b.elementi) ? b.elementi : []).slice(0, 60).filter(Boolean);
    const crIn = tutti.filter((x) => x.tipo === 'change_request');
    const elementi = tutti.filter((x) => x.tipo !== 'change_request').map((x) => datiRaid(x));
    // Change Request dalla riunione: SEMPRE in Bozza (scelta dell'utente), data di richiesta =
    // data della riunione, la riunione di origine nelle note. Importo e approvazione si
    // completano nella scheda Change Request.
    const cr = crIn.map((x) => ({ ...datiCr({ titolo: x.titolo, descrizione: x.descrizione, motivo: x.motivo, richiesta_da: x.richiesta_da, effort_delta: x.effort_delta, giorni_delta: x.giorni_delta }), stato: 'bozza', data_decisione: null }));
    if (!elementi.length && !cr.length) throw errore(400, 'Nessun elemento da salvare');
    if (cr.length) await richiedeTabella('pm_change_request');
    let riunione = null;
    if (idCal && cr.length) {
      riunione = (await db.query('SELECT oggetto, data_calendar::text AS data FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1',
        [req.user.tenant_id, req.user.user_id, idCal])).rows[0] || null;
    }
    client = await db.connect();
    await client.query('BEGIN');
    for (const el of elementi) await inserisci(client, 'pm_raid', { ...baseRiga(req, prog), ...el, origine: 'riunione', id_calendar: idCal });
    if (cr.length) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pm_cr|${prog.projectId}`]);
      let n = (await client.query(
        'SELECT COUNT(*)::int AS n FROM pm_change_request WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3',
        [req.user.tenant_id, req.user.user_id, prog.projectId])).rows[0].n;
      const nota = riunione ? `Dalla riunione «${riunione.oggetto || 'Riunione'}» del ${dataIt(riunione.data)}` : 'Da una riunione';
      for (const c of cr) {
        n += 1;
        await inserisci(client, 'pm_change_request', { ...baseRiga(req, prog), ...c, codice: `CR-${String(n).padStart(3, '0')}`,
          data_richiesta: (riunione && riunione.data) || oggiIso(), note: nota });
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ creati: elementi.length + cr.length, changeRequest: cr.length });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    invia(res, e, 'RAID_IMPORTA');
  } finally { if (client) client.release(); }
});

// ============================================================================
// CHANGE REQUEST
// ============================================================================
router.get('/cr', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const scheda = await schedaProgetto(req.user, prog.projectId);
    res.json({ cr: conPermesso(req, await crProgetto(req.user, prog.projectId)), unita: scheda.aOre ? 'ore' : 'giorni', tabelle: await tabellaPresente('pm_change_request') });
  } catch (e) { invia(res, e, 'CR'); }
});
function datiCr(b, parziale = false) {
  const d = {};
  const set = (k, v) => { if (!parziale || Object.prototype.hasOwnProperty.call(b, k)) d[k] = v; };
  set('titolo', testo(b.titolo, 500));
  set('descrizione', testo(b.descrizione));
  set('motivo', testo(b.motivo));
  set('richiesta_da', testo(b.richiesta_da, 300));
  set('data_richiesta', dataOpz(b.data_richiesta));
  set('effort_delta', decimale(b.effort_delta));
  set('importo_delta', decimale(b.importo_delta));
  set('giorni_delta', intero(b.giorni_delta));
  set('stato', scelta(b.stato, ['bozza', 'inviata', 'approvata', 'rifiutata'], 'bozza'));
  set('data_decisione', dataOpz(b.data_decisione));
  set('note', testo(b.note));
  if ((!parziale || 'titolo' in d) && !d.titolo) throw errore(400, 'Il titolo è obbligatorio');
  // Approvata o rifiutata senza data: oggi.
  if ((d.stato === 'approvata' || d.stato === 'rifiutata') && !d.data_decisione && (!parziale || !('data_decisione' in b))) d.data_decisione = oggiIso();
  return d;
}
router.post('/cr', async (req, res) => {
  let client;
  try {
    await richiedeTabella('pm_change_request');
    const prog = await progettoUtente(req.user, pid(req));
    const dati = datiCr(req.body || {});
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pm_cr|${prog.projectId}`]);
    const n = (await client.query(
      `SELECT COUNT(*)::int AS n FROM pm_change_request WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3`,
      [req.user.tenant_id, req.user.user_id, prog.projectId])).rows[0].n;
    const id = await inserisci(client, 'pm_change_request', { ...baseRiga(req, prog), ...dati, data_richiesta: dati.data_richiesta || oggiIso(), codice: `CR-${String(n + 1).padStart(3, '0')}` });
    await client.query('COMMIT');
    res.status(201).json({ id });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    invia(res, e, 'CR_NEW');
  } finally { if (client) client.release(); }
});
router.put('/cr/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_change_request');
    const prog = await progettoUtente(req.user, pid(req));
    await aggiorna(req, 'pm_change_request', req.params.id, prog.projectId, datiCr(req.body || {}, true));
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'CR_UPD'); }
});
router.delete('/cr/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_change_request');
    const prog = await progettoUtente(req.user, pid(req));
    await chiudi(req, 'pm_change_request', req.params.id, prog.projectId);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'CR_DEL'); }
});

// ============================================================================
// STAKEHOLDER E RACI
// ============================================================================
async function stakeholder(req, projectId) {
  if (!(await tabellaPresente('pm_stakeholder'))) return [];
  const r = await db.query(
    `SELECT id::text AS id, nominativo, email, ruolo, organizzazione, influenza, interesse, strategia, comunicazione, id_roles_write
       FROM pm_stakeholder WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY created_at`,
    [req.user.tenant_id, req.user.user_id, projectId]);
  return r.rows.sort((a, b) => String(a.nominativo || '').localeCompare(String(b.nominativo || ''), 'it'));
}
async function raci(req, projectId) {
  if (!(await tabellaPresente('pm_raci'))) return [];
  const r = await db.query(
    `SELECT attivita, ordinamento, stakeholder_id::text AS stakeholder_id, ruolo FROM pm_raci
      WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY ordinamento, attivita`,
    [req.user.tenant_id, req.user.user_id, projectId]);
  const righe = new Map();
  for (const x of r.rows) {
    if (!righe.has(x.attivita)) righe.set(x.attivita, { attivita: x.attivita, ordinamento: x.ordinamento, ruoli: {} });
    if (x.stakeholder_id && x.ruolo) righe.get(x.attivita).ruoli[x.stakeholder_id] = x.ruolo;
  }
  return [...righe.values()];
}
router.get('/stakeholder', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    res.json({ stakeholder: conPermesso(req, await stakeholder(req, prog.projectId)), raci: await raci(req, prog.projectId), tabelle: await tabellaPresente('pm_stakeholder') });
  } catch (e) { invia(res, e, 'STK'); }
});
// Proposte di nominativi secondo l'Organizzazione scelta (fonte):
//   cliente = i Contatti del cliente del progetto (tabella contacts, ruolo = qualifica);
//   interno = la rubrica, prima le persone del team del Kick-off (proj_componenti);
//   fornitore = nessuna proposta, il nominativo si scrive a mano.
router.get('/stakeholder/proposte', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const q = String(req.query.q || '').trim().toLowerCase();
    const fonte = String(req.query.fonte || 'interno');
    const cerca = (x) => x.nominativo && (!q || `${x.nominativo} ${x.email || ''} ${x.ruolo || ''}`.toLowerCase().includes(q));
    if (fonte === 'fornitore') return res.json([]);
    // team = SOLO le persone del team del progetto (proj_componenti, Kick-off), completate con
    // email della rubrica: elenco «Interno» degli owner nel RAID e nelle Change Request.
    if (fonte === 'team') {
      const t = (await db.query(
        `SELECT nominativo, email FROM proj_componenti
          WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
        [req.user.tenant_id, req.user.user_id, prog.projectId])).rows;
      const visti = new Set();
      return res.json(t.filter((x) => x.nominativo && !visti.has(String(x.nominativo).trim().toLowerCase()) && visti.add(String(x.nominativo).trim().toLowerCase()))
        .filter(cerca)
        .map((x) => ({ nominativo: String(x.nominativo).trim(), email: x.email || '', ruolo: '', team: true }))
        .sort((a, b) => a.nominativo.localeCompare(b.nominativo, 'it')));
    }
    if (fonte === 'cliente') {
      if (!prog.clientId) return res.json([]);
      const cc = await colonneTabella('contacts');
      const colCliente = ['client_id', 'id_cliente'].find((c) => cc.has(c));
      if (!colCliente) return res.json([]);
      const colRuoloC = ['qualifica', 'ruolo', 'bu'].find((c) => cc.has(c));
      const r = (await db.query(
        `SELECT nominativo, ${cc.has('email') ? 'email' : "''"} AS email, ${colRuoloC ? `"${colRuoloC}"` : "''"} AS ruolo FROM contacts
          WHERE tenant_id = $1 AND user_id = $2 AND "${colCliente}"::text = $3
            ${cc.has('scadenza') ? 'AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)' : ''} LIMIT 2000`,
        [req.user.tenant_id, req.user.user_id, prog.clientId])).rows;
      return res.json(r.filter(cerca)
        .map((x) => ({ nominativo: String(x.nominativo).trim(), email: x.email || '', ruolo: x.ruolo || '', team: false }))
        .sort((a, b) => a.nominativo.localeCompare(b.nominativo, 'it')).slice(0, 50));
    }
    const cols = await colonneTabella('rubrica');
    const colRuolo = ['ruolo', 'role', 'ruolo_progetto', 'qualifica', 'funzione'].find((c) => cols.has(c));
    const rb = (await db.query(
      `SELECT nominativo, email${colRuolo ? `, "${colRuolo}" AS ruolo` : ", '' AS ruolo"} FROM rubrica
        WHERE tenant_id = $1 AND user_id = $2 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) LIMIT 3000`,
      [req.user.tenant_id, req.user.user_id])).rows;
    const team = new Set((await db.query(
      `SELECT LOWER(email) AS e FROM proj_componenti WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
      [req.user.tenant_id, req.user.user_id, prog.projectId])).rows.map((x) => x.e));
    const out = rb.filter(cerca)
      .map((x) => ({ nominativo: x.nominativo, email: x.email || '', ruolo: x.ruolo || '', team: team.has(String(x.email || '').toLowerCase()) }))
      .sort((a, b) => (b.team - a.team) || a.nominativo.localeCompare(b.nominativo, 'it')).slice(0, 25);
    res.json(out);
  } catch (e) { invia(res, e, 'STK_PROPOSTE'); }
});
function datiStk(b, parziale = false) {
  const d = {};
  const set = (k, v) => { if (!parziale || Object.prototype.hasOwnProperty.call(b, k)) d[k] = v; };
  set('nominativo', testo(b.nominativo, 300));
  set('email', testo(b.email, 300));
  set('ruolo', testo(b.ruolo, 300));
  set('organizzazione', scelta(b.organizzazione, ['cliente', 'interno', 'fornitore'], 'cliente'));
  set('influenza', intero(b.influenza, 1, 5));
  set('interesse', intero(b.interesse, 1, 5));
  set('strategia', testo(b.strategia));
  set('comunicazione', testo(b.comunicazione, 500));
  if ((!parziale || 'nominativo' in d) && !d.nominativo) throw errore(400, 'Il nominativo è obbligatorio');
  return d;
}
router.post('/stakeholder', async (req, res) => {
  try {
    await richiedeTabella('pm_stakeholder');
    const prog = await progettoUtente(req.user, pid(req));
    const id = await inserisci(db, 'pm_stakeholder', { ...baseRiga(req, prog), ...datiStk(req.body || {}) });
    res.status(201).json({ id });
  } catch (e) { invia(res, e, 'STK_NEW'); }
});
router.put('/stakeholder/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_stakeholder');
    const prog = await progettoUtente(req.user, pid(req));
    await aggiorna(req, 'pm_stakeholder', req.params.id, prog.projectId, datiStk(req.body || {}, true));
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'STK_UPD'); }
});
router.delete('/stakeholder/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_stakeholder');
    const prog = await progettoUtente(req.user, pid(req));
    await chiudi(req, 'pm_stakeholder', req.params.id, prog.projectId);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'STK_DEL'); }
});
// Matrice RACI: si salva tutta insieme. Body: { projectId, righe: [{ attivita, ruoli: { stakeholderId: 'R' } }] }.
// Una sola «A» per attività (regola RACI): il controllo è qui oltre che nella pagina.
router.put('/raci', async (req, res) => {
  let client;
  try {
    await richiedeTabella('pm_raci');
    const prog = await progettoUtente(req.user, pid(req));
    const validi = new Set((await stakeholder(req, prog.projectId)).map((s) => s.id));
    const righe = (Array.isArray(req.body && req.body.righe) ? req.body.righe : []).slice(0, 100)
      .map((r, i) => ({ attivita: testo(r && r.attivita, 300), ordinamento: i, ruoli: (r && r.ruoli) || {} }))
      .filter((r) => r.attivita);
    for (const r of righe) {
      if (Object.values(r.ruoli).filter((v) => v === 'A').length > 1) throw errore(400, `«${r.attivita}»: ci può essere un solo responsabile finale (A)`);
    }
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM pm_raci WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3', [req.user.tenant_id, req.user.user_id, prog.projectId]);
    for (const r of righe) {
      const assegnati = Object.entries(r.ruoli).filter(([sid, v]) => validi.has(sid) && ['R', 'A', 'C', 'I'].includes(v));
      const valori = assegnati.length ? assegnati : [[null, null]];
      for (const [sid, v] of valori) {
        await client.query(
          `INSERT INTO pm_raci (tenant_id, user_id, project_id, attivita, ordinamento, stakeholder_id, ruolo) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.user.tenant_id, req.user.user_id, prog.projectId, r.attivita, r.ordinamento, sid, v]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, righe: righe.length });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    invia(res, e, 'RACI');
  } finally { if (client) client.release(); }
});

// ============================================================================
// CHIUSURA E LESSONS LEARNED
// ============================================================================
async function lessons(req, filtro, params) {
  if (!(await tabellaPresente('pm_lesson'))) return [];
  const r = await db.query(
    `SELECT l.id::text AS id, l.project_id::text AS project_id, l.tipologia, l.tipo, l.categoria, l.testo, l.raccomandazione, l.id_roles_write,
            l.created_at, p.valore2 AS progetto
       FROM pm_lesson l LEFT JOIN projects p ON p.id = l.project_id
      WHERE l.tenant_id = $1 AND l.user_id = $2 AND (l.scadenza IS NULL OR l.scadenza >= CURRENT_DATE) ${filtro}
      ORDER BY l.created_at DESC LIMIT 200`,
    [req.user.tenant_id, req.user.user_id, ...params]);
  return r.rows;
}
router.get('/chiusura', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const scheda = await schedaProgetto(req.user, prog.projectId);
    let ch = null;
    if (await tabellaPresente('pm_chiusura')) {
      ch = (await db.query(
        `SELECT data_accettazione::text AS data_accettazione, accettato_da, soddisfazione, nota_soddisfazione, obiettivi_raggiunti, attivita_residue, id_roles_write
           FROM pm_chiusura WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3`,
        [req.user.tenant_id, req.user.user_id, prog.projectId])).rows[0] || null;
    }
    const proprie = await lessons(req, 'AND l.project_id::text = $3', [prog.projectId]);
    // Lezioni degli altri progetti con la stessa tipologia: da rileggere all'avvio.
    const simili = scheda.tipologia
      ? (await lessons(req, 'AND l.project_id::text <> $3 AND LOWER(BTRIM(l.tipologia)) = LOWER(BTRIM($4))', [prog.projectId, scheda.tipologia])).slice(0, 50)
      : [];
    res.json({
      progetto: prog, tipologia: scheda.tipologia, chiusura: ch ? { ...ch, puoModificare: puoScrivere(req, ch.id_roles_write), id_roles_write: undefined } : null,
      lessons: conPermesso(req, proprie), simili: simili.map((x) => ({ ...x, id_roles_write: undefined })), tabelle: await tabellaPresente('pm_chiusura')
    });
  } catch (e) { invia(res, e, 'CHIUSURA'); }
});
router.put('/chiusura', async (req, res) => {
  try {
    await richiedeTabella('pm_chiusura');
    const prog = await progettoUtente(req.user, pid(req));
    const b = req.body || {};
    const dati = {
      data_accettazione: dataOpz(b.data_accettazione), accettato_da: testo(b.accettato_da, 300),
      soddisfazione: intero(b.soddisfazione, 1, 5), nota_soddisfazione: testo(b.nota_soddisfazione),
      obiettivi_raggiunti: testo(b.obiettivi_raggiunti, 8000), attivita_residue: testo(b.attivita_residue, 8000)
    };
    const esiste = (await db.query('SELECT id::text AS id, id_roles_write FROM pm_chiusura WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3',
      [req.user.tenant_id, req.user.user_id, prog.projectId])).rows[0];
    if (esiste) {
      if (!puoScrivere(req, esiste.id_roles_write)) throw errore(403, READ_ONLY);
      const { data } = await encryptRowForWrite(db, 'pm_chiusura', dati, { id: esiste.id });
      const cols = Object.keys(data);
      await db.query(`UPDATE pm_chiusura SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}, updated_at = now() WHERE id::text = $${cols.length + 1}`,
        [...cols.map((c) => data[c]), esiste.id]);
    } else {
      const base = baseRiga(req, prog);
      await inserisci(db, 'pm_chiusura', { tenant_id: base.tenant_id, user_id: base.user_id, client_id: base.client_id, project_id: base.project_id, id_roles_write: base.id_roles_write, crypto: 1, ...dati });
    }
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'CHIUSURA_SALVA'); }
});
function datiLesson(b, parziale = false) {
  const d = {};
  const set = (k, v) => { if (!parziale || Object.prototype.hasOwnProperty.call(b, k)) d[k] = v; };
  set('tipo', scelta(b.tipo, ['positivo', 'migliorare'], 'migliorare'));
  set('categoria', testo(b.categoria, 50));
  set('testo', testo(b.testo));
  set('raccomandazione', testo(b.raccomandazione));
  if ((!parziale || 'testo' in d) && !d.testo) throw errore(400, 'Scrivi la lezione appresa');
  return d;
}
router.post('/lesson', async (req, res) => {
  try {
    await richiedeTabella('pm_lesson');
    const prog = await progettoUtente(req.user, pid(req));
    const scheda = await schedaProgetto(req.user, prog.projectId);
    const b = baseRiga(req, prog);
    const id = await inserisci(db, 'pm_lesson', { tenant_id: b.tenant_id, user_id: b.user_id, client_id: b.client_id, project_id: b.project_id, id_roles_write: b.id_roles_write, crypto: 1, tipologia: scheda.tipologia || null, ...datiLesson(req.body || {}) });
    res.status(201).json({ id });
  } catch (e) { invia(res, e, 'LESSON_NEW'); }
});
router.put('/lesson/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_lesson');
    const prog = await progettoUtente(req.user, pid(req));
    await aggiorna(req, 'pm_lesson', req.params.id, prog.projectId, datiLesson(req.body || {}, true), { conUpdatedAt: false });
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'LESSON_UPD'); }
});
router.delete('/lesson/:id', async (req, res) => {
  try {
    await richiedeTabella('pm_lesson');
    const prog = await progettoUtente(req.user, pid(req));
    await chiudi(req, 'pm_lesson', req.params.id, prog.projectId);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'LESSON_DEL'); }
});

// ============================================================================
// DOCUMENTI CON L'AI: STATUS REPORT (SAL) E VERBALE DI CHIUSURA
// ============================================================================
const TIPI_DOC = {
  status: { prompt: 'STATUS_REPORT', titolo: 'Status Report' },
  chiusura: { prompt: 'VERBALE_CHIUSURA', titolo: 'Verbale di chiusura' }
};

// Dati del documento + commento AI. dal = inizio del periodo (Status Report, default 14 giorni fa).
async function datiDocumento(req, projectId, tipo, dal, { conAi = true } = {}) {
  const cfg = TIPI_DOC[tipo];
  if (!cfg) throw errore(400, 'Tipo di documento non valido');
  const oggi = oggiIso();
  const inizio = dataIso(dal) || new Date(Date.parse(`${oggi}T00:00:00Z`) - 14 * 86400000).toISOString().slice(0, 10);
  const ctx = await contestoProgetto(req.user, projectId, { riunioni: tipo === 'status' ? 10 : 6, dal: tipo === 'status' ? inizio : null });
  let extra = '';
  let chiusura = null, lezioni = [];
  if (tipo === 'chiusura') {
    if (await tabellaPresente('pm_chiusura')) {
      chiusura = (await db.query(
        `SELECT data_accettazione::text AS data_accettazione, accettato_da, soddisfazione, nota_soddisfazione, obiettivi_raggiunti, attivita_residue
           FROM pm_chiusura WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3`,
        [req.user.tenant_id, req.user.user_id, projectId])).rows[0] || null;
    }
    lezioni = await lessons(req, 'AND l.project_id::text = $3', [projectId]);
    if (chiusura) extra += `\n\nDATI DI CHIUSURA\nAccettazione: ${dataIt(chiusura.data_accettazione) || 'non ancora'}${chiusura.accettato_da ? ` da ${chiusura.accettato_da}` : ''}\nSoddisfazione del cliente: ${chiusura.soddisfazione ? `${chiusura.soddisfazione}/5` : 'non indicata'}${chiusura.nota_soddisfazione ? ` - ${chiusura.nota_soddisfazione}` : ''}\nObiettivi raggiunti: ${chiusura.obiettivi_raggiunti || '-'}\nAttività residue: ${chiusura.attivita_residue || '-'}`;
    if (lezioni.length) extra += `\n\nLESSONS LEARNED\n${lezioni.map((l) => `- (${l.tipo === 'positivo' ? 'ha funzionato' : 'da migliorare'}${l.categoria ? `, ${l.categoria}` : ''}) ${l.testo}${l.raccomandazione ? ` -> ${l.raccomandazione}` : ''}`).join('\n')}`;
  }
  const dati = ctx.testo + extra;
  const utente = String(await speakerName(req.user) || '').trim() || req.user.email || '';
  const vars = { DATI: dati, DAL: dataIt(inizio), DATA: dataIt(oggi), UTENTE: utente };
  let ai = { testo: '', label: '', errore: '' };
  if (conAi) try {
    const tpl = (await getPromptFor(cfg.prompt, req.user)).testo;
    const build = (d) => {
      let t = tpl;
      if (!t.includes('{{DATI}}')) t += '\n\nDATI\n{{DATI}}';
      return t.replace(/\{\{(DATI|DAL|DATA|UTENTE)\}\}/g, (x, k) => (k === 'DATI' ? d : vars[k]));
    };
    const r = await chiediAi(req.user, build, dati);
    ai = { testo: stripMarkdown(r.testo).trim(), label: `${r.label}${r.model ? ` (${r.model})` : ''}`, errore: '' };
  } catch (e) {
    ai.errore = `Commento dell'AI non disponibile (${e.message}): il documento contiene solo i dati.`;
  }
  const s = ctx.salute;
  const prossime = ctx.righe.filter((r) => r.fine && r.fine >= oggi && r.avanzamento < 100 && r.inizio && r.inizio <= new Date(Date.parse(`${oggi}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10))
    .slice(0, 25).map((r) => ({ nome: r.nome, inizio: r.inizio, fine: r.fine, avanzamento: r.avanzamento, owner: r.owner, milestone: r.milestone }));
  const svolte = ctx.righe.filter((r) => r.avanzamento >= 100 && r.fine && r.fine >= inizio).map((r) => ({ nome: r.nome, fine: r.fine, owner: r.owner }));
  return {
    tipo, titolo: cfg.titolo, data: oggi, dal: tipo === 'status' ? inizio : null, utente,
    progetto: ctx.prog, scheda: s.scheda, semaforo: s.semaforo, indicatori: s.indicatori, eac: s.eac,
    gantt: { completamento: s.gantt.completamento, inizio: s.gantt.inizio, fine: s.gantt.fine, baselineFine: s.gantt.baselineFine, scostamentoGiorni: s.gantt.scostamentoGiorni, milestone: s.gantt.milestone, inRitardo: s.gantt.inRitardo },
    prossime, svolte,
    rischi: ctx.raid.filter((x) => x.tipo === 'rischio' && x.stato !== 'chiuso').sort((a, b) => (b.punteggio || 0) - (a.punteggio || 0)).map((x) => ({ titolo: x.titolo, punteggio: x.punteggio, probabilita: x.probabilita, impatto: x.impatto, owner: x.owner, mitigazione: x.mitigazione })),
    decisioni: ctx.raid.filter((x) => x.tipo === 'decisione' && (tipo !== 'status' || !x.data_revisione || x.data_revisione >= inizio)).map((x) => ({ titolo: x.titolo, data: x.data_revisione, decisa_da: x.decisa_da })),
    cr: ctx.cr.map((x) => ({ codice: x.codice, titolo: x.titolo, stato: x.stato, effort: x.effort_delta, importo: x.importo_delta, giorni: x.giorni_delta, data_decisione: x.data_decisione })),
    azioni: ctx.task.map((t) => ({ titolo: t.titolo, assegnato: t.assegnato, scadenza: t.scadenza, scaduta: t.scaduta })),
    issue: ctx.issue.map((i) => ({ descrizione: i.descrizione, priorita: i.priorita, owner: i.owner, stato: i.stato })),
    riunioni: ctx.riunioni.map((m) => ({ data: m.data, oggetto: m.oggetto })),
    chiusura, lessons: lezioni.map((l) => ({ tipo: l.tipo, categoria: l.categoria, testo: l.testo, raccomandazione: l.raccomandazione })),
    ai, datiAi: dati
  };
}

router.get('/documento', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const d = await datiDocumento(req, prog.projectId, String(req.query.tipo || 'status'), req.query.dal);
    delete d.datiAi;
    res.json(d);
  } catch (e) { invia(res, e, 'DOCUMENTO'); }
});

// Versione Word su template (.docx), come l'Offerta economica: il template arriva dal browser,
// l'AI indica le modifiche ai paragrafi e alle tabelle, il file torna al browser (nulla salvato).
const DOCX_FORMATO = `FORMATO DELLA RISPOSTA (obbligatorio)
Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, in questa forma:
{"modifiche": [
  {"id": "P3", "testo": "nuovo testo del paragrafo (\\n per più paragrafi con lo stesso stile)"},
  {"id": "T1", "righe": [["Intestazione 1", "Intestazione 2"], ["cella", "cella"]]},
  {"id": "P9", "elimina": true}
]}
- "id" è il codice tra parentesi quadre del documento qui sotto: P<n> paragrafo del corpo, T<n> tabella, H<n> paragrafo di intestazione o piè di pagina. Tra graffe c'è lo stile del paragrafo (es. {Heading1} = titolo).
- "testo" sostituisce tutto il testo del paragrafo (stile e carattere del template restano).
- "righe" sostituisce tutte le righe della tabella, compresa l'intestazione se c'è: le righe in più copiano lo stile dell'ultima riga.
- "elimina": true toglie il paragrafo o la tabella.
- Compila il template con i dati del progetto e con il commento richiesto dalle istruzioni (sostituisci i segnaposto, riempi le tabelle con rischi, milestone, attività, Change Request se il template le prevede). Includi solo gli elementi da cambiare. Niente Markdown nei testi.`;

router.post('/documento/docx', express.raw({ type: 'application/octet-stream', limit: 40 * 1024 * 1024 }), async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, req.query.projectId);
    const tipo = String(req.query.tipo || 'status');
    const cfg = TIPI_DOC[tipo];
    if (!cfg) throw errore(400, 'Tipo di documento non valido');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw errore(400, 'Scegli il file Template (.docx)');
    const template = await OffertaDocx.leggiTemplate(req.body);
    const descrizione = OffertaDocx.descriviTemplate(template);
    if (descrizione.length > 120000) throw errore(413, 'Il template contiene troppo testo per l\'AI: usa un template più corto');
    const d = await datiDocumento(req, prog.projectId, tipo, req.query.dal, { conAi: false });
    const tpl = (await getPromptFor(cfg.prompt, req.user)).testo;
    const istruzioni = tpl.replace(/\{\{(DATI|DAL|DATA|UTENTE)\}\}/g, (x, k) => (k === 'DATI' ? d.datiAi : k === 'DAL' ? dataIt(d.dal) : k === 'DATA' ? dataIt(d.data) : d.utente));
    const prompt = `${istruzioni}\n\nDOCUMENTO WORD DA COMPILARE: inserisci il commento (con i titoli della STRUTTURA) e i dati nei punti giusti del template.\n\n${DOCX_FORMATO}\n\nDOCUMENTO (testi attuali con i codici):\n${descrizione}`;
    const r = await chiediAi(req.user, () => prompt, '', { json: true });
    const modifiche = leggiRispostaAi(r.testo);
    const esito = await OffertaDocx.applicaModifiche(await OffertaDocx.leggiTemplate(req.body), modifiche);
    if (!esito.applicate) throw errore(502, `${r.label} non ha indicato modifiche applicabili al template: controlla il prompt e riprova`);
    const nomeFile = `${cfg.titolo} ${prog.nome} ${dataIt(d.data).replace(/\//g, '-')}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="documento.docx"; filename*=UTF-8''${encodeURIComponent(nomeFile)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Pm-Ai', encodeURIComponent(`${r.label}${r.model ? ` (${r.model})` : ''}`));
    res.send(esito.buffer);
  } catch (e) { invia(res, e, 'DOCUMENTO_DOCX'); }
});

// ============================================================================
// CHIEDI AL PROGETTO
// ============================================================================
router.post('/chiedi', async (req, res) => {
  try {
    const b = req.body || {};
    const domanda = testo(b.domanda, 2000);
    if (!domanda) throw errore(400, 'Scrivi la domanda');
    const prog = await progettoUtente(req.user, b.projectId);
    const ctx = await contestoProgetto(req.user, prog.projectId, { riunioni: 8, maxRecap: 5000 });
    const storia = (Array.isArray(b.storia) ? b.storia : []).slice(-8)
      .map((x) => `${x && x.ruolo === 'ai' ? 'ASSISTENTE' : 'UTENTE'}: ${String((x && x.testo) || '').slice(0, 3000)}`).join('\n') || '(nessuna)';
    const utente = String(await speakerName(req.user) || '').trim() || req.user.email || '';
    const tpl = (await getPromptFor('CHIEDI_PROGETTO', req.user)).testo;
    const vars = { DOMANDA: domanda, STORIA: storia, DATA: dataIt(oggiIso()), UTENTE: utente };
    const build = (d) => tpl.replace(/\{\{(DATI|DOMANDA|STORIA|DATA|UTENTE)\}\}/g, (x, k) => (k === 'DATI' ? d : vars[k]));
    const r = await chiediAi(req.user, build, ctx.testo, { soloEsterna: true });
    res.json({ risposta: stripMarkdown(r.testo).trim(), ai: `${r.label}${r.model ? ` (${r.model})` : ''}` });
  } catch (e) { invia(res, e, 'CHIEDI'); }
});

// ============================================================================
// BRIEFING PRE-RIUNIONE
// ============================================================================
// Body: { projectId } oppure { id_calendar } di una riunione collegata a un progetto.
router.post('/briefing', async (req, res) => {
  try {
    const b = req.body || {};
    let projectId = b.projectId;
    let riunione = '';
    if (b.id_calendar) {
      const m = (await db.query(
        `SELECT oggetto, data_calendar::text AS d, orario_calendar::text AS o, project_id::text AS p FROM rec_meeting
          WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
        [req.user.tenant_id, req.user.user_id, String(b.id_calendar)])).rows[0];
      if (m) {
        projectId = projectId || m.p;
        riunione = ` «${m.oggetto || 'Riunione'}» del ${dataIt(m.d)}${m.o ? ` alle ${String(m.o).slice(0, 5)}` : ''}`;
      }
    }
    if (!projectId && b.titolo) riunione = ` «${String(b.titolo).slice(0, 200)}»`;
    if (!projectId) throw errore(400, 'Scegli il progetto della riunione');
    const prog = await progettoUtente(req.user, projectId);
    const ctx = await contestoProgetto(req.user, prog.projectId, { riunioni: 3, maxRecap: 6000 });
    const utente = String(await speakerName(req.user) || '').trim() || req.user.email || '';
    const tpl = (await getPromptFor('BRIEFING_RIUNIONE', req.user)).testo;
    const vars = { RIUNIONE: riunione ? `${riunione} sul progetto «${prog.nome}»` : ` sul progetto «${prog.nome}»`, DATA: dataIt(oggiIso()), UTENTE: utente };
    const build = (d) => tpl.replace(/\{\{(DATI|RIUNIONE|DATA|UTENTE)\}\}/g, (x, k) => (k === 'DATI' ? d : vars[k]));
    const r = await chiediAi(req.user, build, ctx.testo);
    res.json({
      progetto: prog, semaforo: ctx.salute.semaforo, briefing: stripMarkdown(r.testo).trim(), ai: `${r.label}${r.model ? ` (${r.model})` : ''}`,
      azioni: ctx.task.slice(0, 30), rischi: ctx.raid.filter((x) => x.tipo === 'rischio' && x.stato !== 'chiuso').slice(0, 10).map((x) => ({ titolo: x.titolo, punteggio: x.punteggio, owner: x.owner }))
    });
  } catch (e) { invia(res, e, 'BRIEFING'); }
});

// ============================================================================
// GANTT: analisi, baseline, completamento del progetto
// ============================================================================
router.get('/gantt', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const righe = await righeGantt(req.user, prog.projectId);
    const cols = await colonneTabella('proj_activity');
    res.json({ ...analisiGantt(righe), baselineDisponibile: cols.has('baseline_fine'), milestoneDisponibile: cols.has('milestone'),
      baseline: righe.filter((r) => r.baselineFine).map((r) => ({ id: r.id, inizio: r.baselineInizio, fine: r.baselineFine })) });
  } catch (e) { invia(res, e, 'GANTT'); }
});

// «Congela baseline»: copia le date attuali di tutte le attività nella baseline.
router.post('/gantt/baseline', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const cols = await colonneTabella('proj_activity');
    if (!cols.has('baseline_fine')) throw errore(503, 'Funzione non ancora attiva: va eseguito lo script Supporto/CreaDB/pm_senior.sql sul database');
    const righe = (await db.query('SELECT id_roles_write FROM proj_activity WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3',
      [req.user.tenant_id, req.user.user_id, prog.projectId])).rows;
    if (!righe.length) throw errore(400, 'Il Gantt del progetto è vuoto');
    if (righe.some((r) => !puoScrivere(req, r.id_roles_write))) throw errore(403, READ_ONLY);
    const r = await db.query(
      `UPDATE proj_activity SET baseline_inizio = data_inizio, baseline_fine = data_fine, baseline_il = now()
        WHERE tenant_id = $1 AND user_id = $2 AND project_id::text = $3`,
      [req.user.tenant_id, req.user.user_id, prog.projectId]);
    res.json({ ok: true, attivita: r.rowCount, il: nowStamp() });
  } catch (e) { invia(res, e, 'GANTT_BASELINE'); }
});

// Scrive nel campo «Completamento» della scheda il completamento calcolato dal Gantt.
// Scrive il campo «Completamento» della scheda (valore3), con i permessi della riga.
async function scriviCompletamento(req, projectId, valore) {
  const campi = await campiProgetto(req.user, projectId);
  const riga = campi.riga('Completamento');
  if (!riga) throw errore(404, 'Il progetto non ha il campo «Completamento»');
  if (!isAdmin(req) && !String(riga.id_roles_write ?? '').split(/[;,\s]+/).includes(ruolo(req))) throw errore(403, READ_ONLY);
  await db.query('UPDATE projects SET valore3 = $1 WHERE id::text = $2 AND tenant_id = $3 AND user_id = $4',
    [valore, riga.id, req.user.tenant_id, req.user.user_id]);
}

router.post('/gantt/completamento', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const a = analisiGantt(await righeGantt(req.user, prog.projectId));
    if (a.completamento == null) throw errore(400, 'Il Gantt non ha attività da cui calcolare il completamento');
    const valore = Math.round(a.completamento);
    await scriviCompletamento(req, prog.projectId, valore);
    res.json({ ok: true, completamento: valore });
  } catch (e) { invia(res, e, 'GANTT_COMPL'); }
});

// Completamento «a consuntivo» (accanto al campo Completamento della scheda): speso ÷ budget,
// con budget = offerta effort dei Costi Progetto + effort delle Change Request approvate,
// stesse regole del Cruscotto. null se il budget è vuoto.
async function consuntivo(user, projectId) {
  const [eco, cr] = await Promise.all([economiaProgetto(user, projectId), crProgetto(user, projectId)]);
  const budget = eco.offerta + cr.filter((x) => x.stato === 'approvata').reduce((s, x) => s + (Number(x.effort_delta) || 0), 0);
  const perc = budget > 0 ? Math.round((eco.speso / budget) * 10000) / 100 : null;
  return { perc, speso: eco.speso, budget, unita: eco.aOre ? 'ore' : 'giorni' };
}
router.get('/consuntivo', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    res.json(await consuntivo(req.user, prog.projectId));
  } catch (e) { invia(res, e, 'CONSUNTIVO'); }
});
// «Aggiorna»: porta nel campo Completamento la percentuale a consuntivo (al massimo 100).
router.post('/consuntivo/completamento', async (req, res) => {
  try {
    const prog = await progettoUtente(req.user, pid(req));
    const c = await consuntivo(req.user, prog.projectId);
    if (c.perc == null) throw errore(400, 'Manca l\'offerta effort nei Costi Progetto: non si può calcolare la percentuale a consuntivo');
    const valore = Math.min(100, c.perc);
    await scriviCompletamento(req, prog.projectId, valore);
    res.json({ ok: true, completamento: valore, ...c });
  } catch (e) { invia(res, e, 'CONSUNTIVO_COMPL'); }
});

// ============================================================================
// PREFERENZE E DIGEST
// ============================================================================
router.get('/preferenze', async (req, res) => {
  try {
    if (!(await tabellaPresente('pm_preferenze'))) return res.json({ digest: false, notifiche_prog: true, tabelle: false });
    const r = (await db.query('SELECT digest, notifiche_prog FROM pm_preferenze WHERE tenant_id = $1 AND user_id = $2', [req.user.tenant_id, req.user.user_id])).rows[0];
    res.json({ ...(r || { digest: false, notifiche_prog: true }), tabelle: true });
  } catch (e) { invia(res, e, 'PREF'); }
});
router.put('/preferenze', async (req, res) => {
  try {
    await richiedeTabella('pm_preferenze');
    const b = req.body || {};
    await db.query(
      `INSERT INTO pm_preferenze (tenant_id, user_id, digest, notifiche_prog) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET digest = EXCLUDED.digest, notifiche_prog = EXCLUDED.notifiche_prog, updated_at = now()`,
      [req.user.tenant_id, req.user.user_id, b.digest === true, b.notifiche_prog !== false]);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'PREF_SALVA'); }
});
// Anteprima del digest (HTML) e invio di prova a sé stessi.
router.get('/digest/anteprima', async (req, res) => {
  try { res.json(await costruisciDigest(req.user)); } catch (e) { invia(res, e, 'DIGEST_ANTEPRIMA'); }
});
router.post('/digest/prova', async (req, res) => {
  try {
    const email = await emailUtente(req.user.user_id);
    if (!email) throw errore(400, 'Email del tuo account non trovata');
    const d = await costruisciDigest(req.user);
    await sendMail({ to: email, subject: d.oggetto, html: d.html, text: d.text, log: { req, tipo: 'digest_settimanale', userId: req.user.user_id, tenantId: req.user.tenant_id } });
    res.json({ ok: true, email });
  } catch (e) { invia(res, e, 'DIGEST_PROVA'); }
});

export default router;
