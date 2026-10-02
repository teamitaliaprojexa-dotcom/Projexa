// ============================================================================
// LOG DEGLI ACCESSI E DELLE EMAIL
// ----------------------------------------------------------------------------
// Ogni login (riuscito o no) e ogni email finiscono nella coda audit_outbox del database
// Projexa (Supporto/CreaDB/audit_log.sql); jobs/auditShipper.js la invia a Oracle
// (tabelle AUDIT_OWNER.LOG_ACCESSI e LOG_EMAIL). La scrittura non viene attesa e un
// errore non blocca mai il login o l'invio: al massimo quell'evento non viene registrato.
// Il logout non passa dal server (il browser cancella il token), quindi non c'è.
// ============================================================================
import db from './database.js';

let codaMancanteSegnalata = false;

const breve = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));
const ipDi = (req) => (req && req.ip) || null;

function accoda(tipo, dati) {
  db.query('INSERT INTO audit_outbox (tipo, dati) VALUES ($1, $2)', [tipo, JSON.stringify(dati)])
    .catch((e) => {
      if (e.code === '42P01') { // tabella non ancora creata
        if (!codaMancanteSegnalata) console.warn('[AUDIT] Tabella audit_outbox assente: eseguire Supporto/CreaDB/audit_log.sql');
        codaMancanteSegnalata = true;
        return;
      }
      console.error(`[AUDIT] Evento "${tipo}" non registrato:`, e.message);
    });
}

/**
 * evento: 'login' | 'magic_link' | 'google' | 'microsoft' | 'impersonazione' | 'cambio_password'
 * esito:  'ok' | 'ko'
 */
export function registraAccesso(req, { evento, esito = 'ok', userId = null, email = null, tenantId = null, dettaglio = null }) {
  accoda('accesso', {
    evento,
    esito,
    user_id: userId ? String(userId) : null,
    email: email ? String(email).trim().toLowerCase().slice(0, 320) : null,
    tenant_id: tenantId ? String(tenantId) : null,
    ip: ipDi(req),
    user_agent: req && req.headers ? breve(req.headers['user-agent'], 500) : null,
    dettaglio: breve(dettaglio, 1000)
  });
}

// ----------------------------------------------------------------------------
// TRASCRIZIONE E RECAP: una riga del log variazioni ciascuno, con il testo completo
// ----------------------------------------------------------------------------
// Il testo della trascrizione cresce blocco per blocco: il trigger registrerebbe una riga
// per blocco, con il testo cifrato troncato e quindi illeggibile. Queste scritture accendono
// projexa.audit_salta (il trigger le salta, Supporto/CreaDB/audit_trascrizione_recap.sql) e
// a lavoro finito si registra qui UN evento con il testo completo, cifrato come sulla
// tabella: la pagina Log lo decifra solo per mostrarlo.
export const SALTA_LOG_ON = "SELECT set_config('projexa.audit_salta', '1', true)";
export const SALTA_LOG_OFF = "SELECT set_config('projexa.audit_salta', '', true)";

let chiavePkRecMeeting = null; // colonne della chiave primaria di rec_meeting (dal catalogo)

async function colonnePkRecMeeting() {
  if (chiavePkRecMeeting) return chiavePkRecMeeting;
  const r = await db.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'public.rec_meeting'::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`
  );
  chiavePkRecMeeting = r.rows.map((x) => x.attname);
  if (!chiavePkRecMeeting.length) chiavePkRecMeeting = ['tenant_id', 'user_id', 'id_calendar'];
  return chiavePkRecMeeting;
}

/**
 * campo:   'trascrizione' | 'recap'
 * testoCifrato: valore come salvato su rec_meeting (encRec)
 * userId:  chi ha fatto l'operazione (di norma il proprietario della riunione)
 * origine: es. 'job:trascrizione', 'job:recap' o il percorso della richiesta
 */
export async function registraTestoRiunione({ tenantId, userId, ownerId, idCalendar, campo, testoCifrato, origine }) {
  try {
    const pk = await colonnePkRecMeeting();
    const r = await db.query(
      `SELECT ${pk.map((c) => `"${c}"::text AS "${c}"`).join(', ')} FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
      [tenantId, ownerId || userId, idCalendar]
    );
    if (!r.rows[0]) return;
    accoda('variazione', {
      tabella: 'rec_meeting',
      operazione: 'UPDATE',
      chiave: pk.map((c) => r.rows[0][c] ?? '').join('|'),
      tenant_id: tenantId ? String(tenantId) : null,
      user_id: userId ? String(userId) : null,
      origine: breve(origine, 400),
      campi: [campo],
      prima: null,
      dopo: { [campo]: testoCifrato }
    });
  } catch (e) {
    console.error(`[AUDIT] Evento "${campo}" della riunione ${idCalendar} non registrato:`, e.message);
  }
}

const elenco = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,]/))
  .map((x) => String(x).trim()).filter(Boolean).join(', ');

/**
 * tipo:      'conferma_iscrizione' | 'reset_password' | 'magic_link' | 'recap' | 'trascrizione'
 * modalita:  'server'  = inviata da Projexa (Gmail del team)
 *            'client'  = preparata da Projexa e aperta nel programma di posta dell'utente
 *                        (Gmail web o Outlook): l'invio vero lo fa l'utente
 * Il testo dell'email non viene salvato: solo destinatari, oggetto ed esito.
 */
export function registraEmail(req, {
  tipo, modalita = 'server', esito = 'ok', a, cc = null, mittente = null, oggetto = null,
  riferimento = null, servizio = null, errore = null, userId = null, tenantId = null
}) {
  const u = (req && req.user) || {};
  accoda('email', {
    tipo,
    modalita,
    esito,
    destinatari: breve(elenco(a), 2000),
    cc: breve(elenco(cc), 2000),
    mittente: breve(mittente, 320),
    oggetto: breve(oggetto, 500),
    riferimento: breve(riferimento, 200),
    servizio: breve(servizio, 40),
    errore: breve(errore, 1000),
    user_id: userId ? String(userId) : (u.user_id ? String(u.user_id) : null),
    tenant_id: tenantId ? String(tenantId) : (u.tenant_id ? String(u.tenant_id) : null),
    ip: ipDi(req)
  });
}
