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
