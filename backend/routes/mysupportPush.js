// ============================================================================
// MYSUPPORT INVIATO DAL PC (interruttore «DataBricks», 2026-10-17)
// ----------------------------------------------------------------------------
// Il file «MySupport.xlsx» lo crea sul PC dell'utente uno script schedulato che legge
// Databricks (Documenti\Claude\Report\Programmi\MySupport-Report.ps1). Subito dopo, lo stesso
// script invia le righe a Projexa (POST /api/mysupport/push, in server.js) con un TOKEN
// dedicato: Projexa non deve più leggere la cartella del PC né restare aperta nel browser.
//
// Il token lo genera l'utente in Impostazioni › «DataBricks» (acceso = token generato e
// mostrato UNA volta sola, da incollare in config.json dello script; spento = token revocato).
// Nella tabella api_token (Supporto/CreaDB/mysupport_push.sql) c'è solo l'impronta SHA-256.
// Il token vale per l'utente che l'ha generato: l'import usa il suo tenant.
//
// 2026-11-19: stesso meccanismo per l'interruttore «Gestione Solleciti tkt» (scopo
// 'solleciti_tkt', token «pxst_…»): lo script invia i solleciti dei ticket
// (POST /api/mysupport/solleciti/push, script Supporto/Script PC/Solleciti-Tkt/Solleciti-Push.ps1
// che legge solleciti_ticket.xlsx) che aggiornano data_sollecito, email_sollecito,
// risposta_interna e risposta_cliente della tabella mysupport (Supporto/CreaDB/mysupport_solleciti.sql).
// ============================================================================
import express from 'express';
import crypto from 'crypto';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { notificaMySupportScript } from '../jobs/notifiche.js';

// Tipi di token: scopo in api_token, prefisso del token, campo dell'interruttore in settings.
export const TOKEN_TIPI = {
  mysupport_push: { prefisso: 'pxms_', interruttore: 'databricks', etichetta: 'Databricks', log: 'MYSUPPORT PUSH' },
  solleciti_tkt: { prefisso: 'pxst_', interruttore: 'gestione solleciti tkt', etichetta: 'Gestione Solleciti tkt', log: 'SOLLECITI TKT' }
};
const SCOPO = 'mysupport_push';

const impronta = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Utente del token (o null). Header «Authorization: Bearer <prefisso>…» dello scopo indicato.
export async function utenteDaTokenPush(req, scopo = SCOPO) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!m || !m[1].startsWith(TOKEN_TIPI[scopo].prefisso)) return null;
  // L'utente deve appartenere ancora al tenant del token (uscito dall'azienda = token inutile).
  const r = await db.query(
    `SELECT t.id, t.tenant_id, t.user_id FROM api_token t
      WHERE t.token_hash = $1 AND t.scopo = $2
        AND EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = t.user_id AND ut.tenant_id = t.tenant_id)`,
    [impronta(m[1]), scopo]);
  return r.rows[0] || null;
}

// Limite di richieste per /api/mysupport/push (in memoria, finestra di 10 minuti): un invio
// normale sono pochi blocchi da 5000 righe, quindi 120 richieste per IP bastano e avanzano.
const PUSH_FINESTRA_MS = 10 * 60 * 1000;
const PUSH_MAX = 120;
const pushContatori = new Map();
export function pushLimitato(chiave) {
  const ora = Date.now();
  let c = pushContatori.get(chiave);
  if (!c || ora - c.inizio > PUSH_FINESTRA_MS) { c = { inizio: ora, n: 0 }; pushContatori.set(chiave, c); }
  c.n += 1;
  if (pushContatori.size > 5000) {
    for (const [k, v] of pushContatori) if (ora - v.inizio > PUSH_FINESTRA_MS) pushContatori.delete(k);
  }
  return c.n > PUSH_MAX;
}

// Esito di un blocco inviato: i totali di un invio (blocchi 1..n) si sommano in ultimo_report.
export async function registraInvioPush(tokenId, blocco, blocchi, esito) {
  const r = (await db.query('SELECT ultimo_report FROM api_token WHERE id = $1', [tokenId])).rows[0];
  const prec = blocco > 1 && r && r.ultimo_report ? r.ultimo_report : {};
  const somma = (k) => (Number(prec[k]) || 0) + (Number(esito[k]) || 0);
  const report = {
    blocchi, ricevuti: blocco,
    totale: somma('totale'), inserted: somma('inserted'), updated: somma('updated'),
    unchanged: somma('unchanged'), invalid: somma('invalid'),
    nonTrovati: somma('nonTrovati'), ambigui: somma('ambigui'),
    creati: somma('creati'), senzaCliente: somma('senzaCliente') // solo solleciti
  };
  await db.query('UPDATE api_token SET ultimo_uso = now(), ultimo_report = $2 WHERE id = $1', [tokenId, JSON.stringify(report)]);
}

// Riga dell'interruttore nel settings dell'utente (anche «(*) …»): valore1 = acceso/spento.
async function impostaInterruttore(user, campo, acceso) {
  await db.query(
    `UPDATE settings SET valore1 = $3, valore2 = NULL
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(regexp_replace(campo, '^\\(\\*\\)\\s*', ''))) = $4`,
    [user.tenant_id, user.user_id, acceso, campo]);
}

function tabellaMancante(res, e) {
  if (e.code !== '42P01') return false;
  res.status(503).json({ error: 'Tabella api_token mancante: eseguire Supporto/CreaDB/mysupport_push.sql' });
  return true;
}

// GET/POST/DELETE /token per uno scopo: stato, genera (o rigenera), revoca.
function rotteToken(router, scopo) {
  const t = TOKEN_TIPI[scopo];

  // Stato per Impostazioni: token presente, quando è stato creato, ultimo invio ricevuto.
  router.get('/token', requireAuth, async (req, res) => {
    try {
      const r = (await db.query(
        'SELECT creato_il, ultimo_uso, ultimo_report FROM api_token WHERE tenant_id = $1 AND user_id = $2 AND scopo = $3',
        [req.user.tenant_id, req.user.user_id, scopo])).rows[0];
      res.json(r ? { attivo: true, creatoIl: r.creato_il, ultimoUso: r.ultimo_uso, ultimoReport: r.ultimo_report } : { attivo: false });
    } catch (e) {
      if (tabellaMancante(res, e)) return;
      console.error(`[${t.log}] stato:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Genera (o rigenera: il precedente smette di funzionare) il token e lo restituisce in chiaro,
  // l'unica volta in cui si vede. Accende anche l'interruttore.
  router.post('/token', requireAuth, async (req, res) => {
    try {
      const token = t.prefisso + crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO api_token (tenant_id, user_id, scopo, token_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id, scopo) DO UPDATE
           SET token_hash = EXCLUDED.token_hash, creato_il = now(), ultimo_uso = NULL, ultimo_report = NULL`,
        [req.user.tenant_id, req.user.user_id, scopo, impronta(token)]);
      await impostaInterruttore(req.user, t.interruttore, true);
      console.log(`[${t.log}] ${req.user.email || req.user.user_id}: token generato`);
      res.json({ token });
    } catch (e) {
      if (tabellaMancante(res, e)) return;
      console.error(`[${t.log}] genera token:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Interruttore spento: token revocato (lo script del PC riceverà 401).
  router.delete('/token', requireAuth, async (req, res) => {
    try {
      await db.query('DELETE FROM api_token WHERE tenant_id = $1 AND user_id = $2 AND scopo = $3',
        [req.user.tenant_id, req.user.user_id, scopo]);
      await impostaInterruttore(req.user, t.interruttore, false);
      console.log(`[${t.log}] ${req.user.email || req.user.user_id}: token revocato`);
      res.json({ ok: true });
    } catch (e) {
      if (tabellaMancante(res, e)) return;
      console.error(`[${t.log}] revoca token:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Router «DataBricks»: /api/mysupport/push (token + avvisi; il push è in server.js)
// ---------------------------------------------------------------------------
const router = express.Router();
rotteToken(router, SCOPO);

// Avviso dallo script del PC (2026-10-23): oggi solo «login Databricks scaduto», che prima si
// vedeva soltanto nel log del PC (e ci si accorgeva giorni dopo dal file vecchio). Stesso token
// del push. Body: { tipo: 'login_databricks', dettaglio? } -> notifica in campanella.
const AVVISI = {
  login_databricks: {
    titolo: 'MySupport: login Databricks scaduto',
    messaggio: 'Il report MySupport del PC non riesce più ad accedere a Databricks e i dati MySupport non si aggiornano. Rifai il login dal PC: comando «databricks auth login» nel file LEGGIMI.md dello script (Documenti\\Claude\\Report\\Programmi).'
  }
};
router.post('/avviso', async (req, res) => {
  try {
    if (pushLimitato('ip:' + (req.ip || ''))) return res.status(429).json({ error: 'Troppe richieste: riprova tra qualche minuto' });
    const tok = await utenteDaTokenPush(req);
    if (!tok) return res.status(401).json({ error: 'Token non valido o revocato: generane uno nuovo in Impostazioni › Databricks' });
    const tipo = String((req.body && req.body.tipo) || '');
    const a = AVVISI[tipo];
    if (!a) return res.status(400).json({ error: 'Avviso sconosciuto' });
    const dettaglio = String((req.body && req.body.dettaglio) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    await notificaMySupportScript({ tenantId: tok.tenant_id, userId: tok.user_id, tipo, titolo: a.titolo, messaggio: dettaglio ? `${a.messaggio} Errore: ${dettaglio}` : a.messaggio });
    console.warn(`[MYSUPPORT PUSH] utente ${tok.user_id}: avviso dallo script del PC (${tipo})`);
    res.json({ ok: true });
  } catch (e) {
    if (tabellaMancante(res, e)) return;
    console.error('[MYSUPPORT PUSH] avviso:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;

// ---------------------------------------------------------------------------
// Router «Gestione Solleciti tkt»: /api/mysupport/solleciti
// ---------------------------------------------------------------------------
// POST /push con «Authorization: Bearer pxst_…». Body: { rows, blocco, blocchi } (max 5000
// righe per blocco), ogni riga { codice_quesito, data_sollecito, email_sollecito,
// risposta_interna, risposta_cliente }. Chiave: (tenant del token, codice_quesito). Un campo
// assente nella riga resta com'è, un campo presente ma vuoto viene svuotato.
// Ticket non ancora in mysupport (2026-11-19, richiesta dell'utente): la riga viene CREATA con
//   tenant_id / user_id = utente del token,
//   client_id = cliente del contatto (tabella contacts) con email = email_sollecito
//               (email cifrata: abbinamento fatto qui dopo la lettura; nessun contatto o
//               contatti di clienti diversi -> client_id vuoto),
//   codice_quesito + le 4 colonne dei solleciti; gli altri dati arrivano dal successivo import
//   MySupport (importaRigheMySupport, upsert sulla stessa chiave: aggiorna tutte le colonne del
//   file MySupport, cliente e proprietario compresi, e non tocca le 4 dei solleciti).
// Esito:
//   inserted     = sollecito nuovo: ticket creato o ticket che prima non aveva solleciti/risposte
//   updated      = ticket con solleciti/risposte già presenti e cambiati
//   unchanged    = nessuna differenza
//   creati       = di cui ticket creati qui; senzaCliente = creati senza cliente abbinato.
export const sollecitiRouter = express.Router();
const SCOPO_SOLLECITI = 'solleciti_tkt';
rotteToken(sollecitiRouter, SCOPO_SOLLECITI);

const SOLLECITI_COLONNE = ['data_sollecito', 'email_sollecito', 'risposta_interna', 'risposta_cliente'];

// Cliente «radice» (riga clients con argument = 'Cliente') di una riga clients: stessa
// risalita di resolveClientRoot in server.js. null se non trovato.
async function clienteRadice(id, tenantId) {
  let cur = id, guard = 0;
  while (cur && guard++ < 60) {
    const r = (await db.query('SELECT id, argument FROM clients WHERE id::text = $1 AND tenant_id = $2', [String(cur), tenantId])).rows[0];
    if (!r) return null;
    if (r.argument === 'Cliente') return String(r.id);
    cur = r.argument;
  }
  return null;
}

// email (minuscola) -> client_id radice, dai contatti del tenant. Le email in contacts sono
// cifrate: db.query le restituisce in chiaro e il confronto si fa qui. Un'email presente su
// contatti di clienti diversi non viene abbinata (valore null).
async function clientiPerEmail(tenantId) {
  const mappa = new Map();
  const righe = (await db.query(
    'SELECT DISTINCT client_id::text AS client_id, email FROM contacts WHERE tenant_id = $1 AND client_id IS NOT NULL AND email IS NOT NULL',
    [tenantId])).rows;
  const radici = new Map();
  for (const r of righe) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email || email.startsWith('enc:')) continue;
    if (!radici.has(r.client_id)) radici.set(r.client_id, await clienteRadice(r.client_id, tenantId));
    const cid = radici.get(r.client_id);
    if (!cid) continue;
    if (!mappa.has(email)) mappa.set(email, cid);
    else if (mappa.get(email) !== cid) mappa.set(email, null); // stessa email su clienti diversi
  }
  return mappa;
}

async function importaSolleciti(tenantId, userId, rowsIn) {
  const errore400 = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
  if (!rowsIn.length) throw errore400('Nessuna riga da importare');
  if (rowsIn.length > 5000) throw errore400('Troppe righe in una sola richiesta (massimo 5000)');
  const testo = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };
  // Data e ora: 'AAAA-MM-GG[ HH:MM[:SS]]' (anche con la T) o 'GG/MM/AAAA[ HH:MM[:SS]]'
  // (formato del file solleciti_ticket.xlsx) -> 'AAAA-MM-GG HH:MM:SS'.
  const data = (v) => {
    const s = String(v == null ? '' : v).trim();
    const ora = (h, mi, se) => (h ? ` ${h.padStart(2, '0')}:${mi}:${se || '00'}` : ' 00:00:00');
    let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}${ora(m[4], m[5], m[6])}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}${ora(m[4], m[5], m[6])}` : null;
  };
  const conv = { data_sollecito: data, email_sollecito: (v) => testo(v, 255), risposta_interna: (v) => testo(v, 255), risposta_cliente: (v) => testo(v, 255) };

  let inserted = 0, updated = 0, unchanged = 0, invalid = 0, creati = 0, senzaCliente = 0;
  let perEmail = null; // caricata solo se serve creare almeno un ticket
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const r of rowsIn) {
      const codice = testo(r && r.codice_quesito, 50);
      if (!codice) { invalid += 1; continue; }
      const presenti = SOLLECITI_COLONNE.filter((k) => Object.prototype.hasOwnProperty.call(r, k));
      if (!presenti.length) { invalid += 1; continue; }
      const params = [tenantId, codice];
      const set = presenti.map((k) => {
        params.push(conv[k](r[k]));
        return `${k} = $${params.length}${k === 'data_sollecito' ? '::timestamp' : ''}`;
      });
      const nuovi = presenti.map((k) => `$${presenti.indexOf(k) + 3}${k === 'data_sollecito' ? '::timestamp' : ''}`);
      // vuoto = prima dell'aggiornamento il ticket non aveva né solleciti né risposte.
      const out = await client.query(
        `WITH prima AS (
           SELECT id, (data_sollecito IS NULL AND email_sollecito IS NULL AND risposta_interna IS NULL AND risposta_cliente IS NULL) AS vuoto
             FROM mysupport WHERE tenant_id = $1 AND codice_quesito = $2
         ), agg AS (
           UPDATE mysupport m SET ${set.join(', ')}
             FROM prima p
            WHERE m.id = p.id
              AND (${presenti.map((k) => `m.${k}`).join(', ')}) IS DISTINCT FROM (${nuovi.join(', ')})
           RETURNING m.id
         )
         SELECT p.vuoto, EXISTS (SELECT 1 FROM agg) AS cambiato FROM prima p`,
        params);
      if (!out.rows.length) {
        // Ticket non ancora in mysupport: si crea con i dati del sollecito.
        if (!perEmail) perEmail = await clientiPerEmail(tenantId);
        const email = String(conv.email_sollecito(r.email_sollecito) || '').toLowerCase();
        const clientId = (email && perEmail.get(email)) || null;
        const ins = await client.query(
          `INSERT INTO mysupport (tenant_id, user_id, client_id, codice_quesito, ${presenti.join(', ')})
           VALUES ($1, $${params.length + 1}, $${params.length + 2}, $2, ${nuovi.join(', ')})
           ON CONFLICT (tenant_id, codice_quesito) DO NOTHING
           RETURNING id`,
          [...params, userId, clientId]);
        if (ins.rows.length) {
          creati += 1; inserted += 1;
          if (!clientId) senzaCliente += 1;
        } else unchanged += 1; // creato nel frattempo da un altro invio
        continue;
      }
      if (!out.rows[0].cambiato) unchanged += 1;
      else if (out.rows[0].vuoto) inserted += 1;
      else updated += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { totale: rowsIn.length, inserted, updated, unchanged, invalid, creati, senzaCliente };
}

sollecitiRouter.post('/push', async (req, res) => {
  try {
    if (pushLimitato('ip:' + (req.ip || ''))) return res.status(429).json({ error: 'Troppe richieste: riprova tra qualche minuto' });
    const tok = await utenteDaTokenPush(req, SCOPO_SOLLECITI);
    if (!tok) return res.status(401).json({ error: 'Token non valido o revocato: generane uno nuovo in Impostazioni › Gestione Solleciti tkt' });
    const blocco = Math.max(1, parseInt(req.body?.blocco, 10) || 1);
    const blocchi = Math.max(blocco, parseInt(req.body?.blocchi, 10) || 1);
    const esito = await importaSolleciti(tok.tenant_id, tok.user_id, Array.isArray(req.body?.rows) ? req.body.rows : []);
    await registraInvioPush(tok.id, blocco, blocchi, esito);
    if (blocco === blocchi) console.log(`[SOLLECITI TKT] utente ${tok.user_id}: invio completato (${blocchi} blocchi)`);
    res.json(esito);
  } catch (error) {
    if (error.code === '42P01') return res.status(503).json({ error: 'Tabella api_token mancante: eseguire Supporto/CreaDB/mysupport_push.sql' });
    if (error.code === '42703') return res.status(503).json({ error: 'Colonne dei solleciti mancanti: eseguire Supporto/CreaDB/mysupport_solleciti.sql' });
    if (error.statusCode >= 400 && error.statusCode < 500) console.warn(`[SOLLECITI TKT] ${error.message}`);
    else console.error('[SOLLECITI TKT]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});
