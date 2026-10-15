// ============================================================================
// IMPORT MYSUPPORT DALLA CARTELLA DEL PC (interruttore «DataBricks», 2026-10-15)
// ----------------------------------------------------------------------------
// Il file «MySupport.xlsx» lo crea sul PC dell'utente uno script schedulato che legge
// Databricks (Documenti\Claude\Report\Programmi). La VM non vede il PC: la cartella la sceglie
// l'utente nel browser (Impostazioni › «DataBricks» acceso -> scelta cartella, il nome finisce in
// settings.valore2) e l'import lo esegue il BROWSER mentre Projexa è aperta
// (sito/js/mysupport-cartella.js), con lo stesso import di Qlik › MySupport.
//
// Il calendario è una riga di job_schedules, job «import_mysupport_cartella», legata al solo
// utente (utente_config) e modificabile dalla pagina Schedulazioni. Predefinito: lun-ven alle
// 10:15 e alle 16:00 (ora_inizio 10:15, ora_fine 16:00, ogni 345 minuti). Lo schedulatore
// del server ne calcola solo la prossima esecuzione (JOBS_BROWSER in jobs/scheduler.js).
//
// File non ancora aggiornato all'ora prevista (lo script delle 16:00 impiega qualche minuto):
// si riprova ogni 5 minuti, fino a 6 volte, poi si passa all'esecuzione successiva.
// ============================================================================
import express from 'express';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { calcolaProssima } from '../jobs/scheduler.js';

const router = express.Router();
const JOB = 'import_mysupport_cartella';
const FILE = 'MySupport.xlsx';
const RIPROVA_MIN = 5;
const MAX_RIPROVE = 6;
const BLOCCO_MIN = 15; // prenotazione di un'esecuzione (altre schede aperte non la ripetono)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rigaUtente(user) {
  try {
    return (await db.query(
      `SELECT * FROM job_schedules WHERE tenant_id = $1 AND job = $2 AND utente_config = $3 ORDER BY created_at LIMIT 1`,
      [user.tenant_id, JOB, user.user_id])).rows[0] || null;
  } catch (e) {
    if (e.code === '42P01') return null; // job_schedules non ancora creata
    throw e;
  }
}

// Riga «DataBricks» del settings dell'utente (anche «(*) DataBricks»).
async function settingUtente(user, id) {
  return (await db.query(
    `SELECT id, valore1, valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2 AND ($3::text IS NULL OR id::text = $3)
        AND lower(btrim(regexp_replace(campo, '^\\(\\*\\)\\s*', ''))) = 'databricks'
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, id || null])).rows[0] || null;
}

// Interruttore acceso con la cartella scelta: salva il nome nel settings e crea (o riattiva)
// la schedulazione dell'utente. Body: { settingId, cartella }.
router.post('/attiva', requireAuth, async (req, res) => {
  try {
    const cartella = String((req.body && req.body.cartella) || '').trim().slice(0, 255);
    if (!cartella) return res.status(400).json({ error: 'Cartella non indicata' });
    const sid = req.body && req.body.settingId ? String(req.body.settingId) : null;
    const st = await settingUtente(req.user, sid);
    if (!st) return res.status(404).json({ error: 'Campo «DataBricks» non trovato nelle tue Impostazioni' });
    await db.query('UPDATE settings SET valore1 = true, valore2 = $2 WHERE id = $1', [st.id, cartella]);
    const r = await rigaUtente(req.user);
    const parametri = { ...((r && r.parametri) || {}), cartella, file: FILE, tentativi: 0 };
    if (r) {
      await db.query(
        `UPDATE job_schedules SET attivo = true, parametri = $2, prossima_esecuzione = NULL, in_esecuzione_dal = NULL, updated_at = now() WHERE id = $1`,
        [r.id, JSON.stringify(parametri)]);
    } else {
      await db.query(
        `INSERT INTO job_schedules (tenant_id, job, descrizione, parametri, attivo, giorni_settimana, ora_inizio, ora_fine,
                                    intervallo_minuti, fuso_orario, utente_config)
         VALUES ($1, $2, $3, $4, true, '{1,2,3,4,5}', '10:15', '16:00', 345, 'Europe/Rome', $5)`,
        [req.user.tenant_id, JOB, `Import MySupport dalla cartella «${cartella}» (${req.user.email || 'utente'})`,
          JSON.stringify(parametri), req.user.user_id]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[MYSUPPORT CARTELLA] attiva:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Interruttore spento: schedulazione sospesa (la riga resta, con i suoi orari).
router.post('/disattiva', requireAuth, async (req, res) => {
  try {
    const sid = req.body && req.body.settingId ? String(req.body.settingId) : null;
    const st = await settingUtente(req.user, sid);
    if (st) await db.query('UPDATE settings SET valore1 = false WHERE id = $1', [st.id]);
    const r = await rigaUtente(req.user);
    if (r) await db.query('UPDATE job_schedules SET attivo = false, in_esecuzione_dal = NULL, updated_at = now() WHERE id = $1', [r.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[MYSUPPORT CARTELLA] disattiva:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stato per il browser (controllo ogni minuto). Con prenota=1 e un'esecuzione dovuta la
// prenota (una sola scheda la esegue) e risponde eseguire: true.
router.get('/stato', requireAuth, async (req, res) => {
  try {
    const st = await settingUtente(req.user, null);
    let r = await rigaUtente(req.user);
    const attiva = !!st && (st.valore1 === true || st.valore1 === 'true') && !!r && r.attivo;
    if (!attiva) {
      if (req.query.prenota === '1' && r && r.attivo) console.log(`[MYSUPPORT CARTELLA] ${req.user.email || req.user.user_id}: schedulazione attiva ma interruttore «DataBricks» ${st ? 'spento' : 'non trovato'}`);
      return res.json({ attiva: false, cartella: st ? st.valore2 || '' : '' });
    }
    if (!r.prossima_esecuzione) {
      // Riga nuova o calendario cambiato dalla pagina Schedulazioni.
      const prossima = calcolaProssima(r);
      r = (await db.query('UPDATE job_schedules SET prossima_esecuzione = $2, updated_at = now() WHERE id = $1 RETURNING *', [r.id, prossima])).rows[0];
    }
    let eseguire = false;
    // subito=1 (clic su «Consenti accesso»): se l'ultimo giro si era fermato per il permesso della
    // cartella, si riparte adesso invece di aspettare il tentativo successivo (5 minuti).
    const subito = req.query.subito === '1' && r.ultimo_esito === 'permesso';
    if (req.query.prenota === '1' && r.prossima_esecuzione && (subito || new Date(r.prossima_esecuzione) <= new Date())) {
      const p = await db.query(
        `UPDATE job_schedules SET in_esecuzione_dal = now(), updated_at = now()
          WHERE id = $1 AND (prossima_esecuzione <= now() OR $2::boolean)
            AND (in_esecuzione_dal IS NULL OR in_esecuzione_dal < now() - interval '${BLOCCO_MIN} minutes')
          RETURNING id`, [r.id, subito]);
      eseguire = p.rowCount > 0;
    }
    if (req.query.prenota === '1') {
      const dovuta = subito || (!!r.prossima_esecuzione && new Date(r.prossima_esecuzione) <= new Date());
      if (dovuta || eseguire) console.log(`[MYSUPPORT CARTELLA] ${req.user.email || req.user.user_id}: esecuzione dovuta (${new Date(r.prossima_esecuzione).toISOString()}), ${eseguire ? 'assegnata a questo browser' : `non assegnata (in esecuzione dal ${r.in_esecuzione_dal ? new Date(r.in_esecuzione_dal).toISOString() : '-'})`}`);
    }
    const par = r.parametri || {};
    res.json({
      attiva: true, eseguire, id: r.id, cartella: st.valore2 || par.cartella || '', file: par.file || FILE,
      ultimoFileMs: par.ultimo_file_ms || null, prossima: r.prossima_esecuzione, ultima: r.ultima_esecuzione,
      ultimoEsito: r.ultimo_esito
    });
  } catch (e) {
    console.error('[MYSUPPORT CARTELLA] stato:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Esito dell'esecuzione dal browser. Body: { id, esito: 'ok'|'errori'|'fallito'|'invariato'|'permesso',
// errore?, report?, fileMs? }. 'invariato' = il file non è cambiato dall'ultimo import (si riprova
// fra 5 minuti, fino a 6 volte); 'permesso' = il browser deve riconfermare l'accesso alla cartella.
router.post('/esito', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!UUID_RE.test(String(b.id || ''))) return res.status(400).json({ error: 'Schedulazione non valida' });
    const r = (await db.query('SELECT * FROM job_schedules WHERE id = $1 AND tenant_id = $2 AND utente_config = $3 AND job = $4',
      [b.id, req.user.tenant_id, req.user.user_id, JOB])).rows[0];
    if (!r) return res.status(404).json({ error: 'Schedulazione non trovata' });
    const par = { ...(r.parametri || {}) };
    const ora = new Date();
    let prossima, esito = String(b.esito || 'ok');
    if ((esito === 'invariato' || esito === 'permesso') && (Number(par.tentativi) || 0) < MAX_RIPROVE) {
      par.tentativi = (Number(par.tentativi) || 0) + 1;
      prossima = new Date(ora.getTime() + RIPROVA_MIN * 60000);
      esito = esito === 'invariato' ? 'in attesa' : 'permesso';
    } else {
      par.tentativi = 0;
      prossima = calcolaProssima(r, ora);
      if (esito === 'invariato') esito = 'saltato';
    }
    if (Number.isFinite(Number(b.fileMs)) && (b.esito === 'ok' || b.esito === 'errori')) par.ultimo_file_ms = Number(b.fileMs);
    const errore = b.errore ? String(b.errore).slice(0, 2000)
      : b.esito === 'invariato' ? 'File non ancora aggiornato dall\'ultimo import'
      : b.esito === 'permesso' ? 'Il browser deve riconfermare l\'accesso alla cartella (Impostazioni › DataBricks)' : null;
    await db.query(
      `UPDATE job_schedules SET ultima_esecuzione = $2, ultimo_esito = $3, ultimo_errore = $4, ultima_durata_ms = $5,
              ultimo_report = $6, prossima_esecuzione = $7, parametri = $8, in_esecuzione_dal = NULL, updated_at = now()
        WHERE id = $1`,
      [r.id, ora, esito.slice(0, 20), errore, Number(b.durataMs) || null, b.report ? JSON.stringify(b.report) : null, prossima, JSON.stringify(par)]);
    console.log(`[MYSUPPORT CARTELLA] ${req.user.email || req.user.user_id}: esito ${esito}${errore ? ` - ${errore}` : ''}; prossima ${prossima ? prossima.toISOString() : 'nessuna'}`);
    res.json({ ok: true, prossima });
  } catch (e) {
    console.error('[MYSUPPORT CARTELLA] esito:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
