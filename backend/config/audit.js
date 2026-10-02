// ============================================================================
// LOG DEGLI ACCESSI
// ----------------------------------------------------------------------------
// Ogni login (riuscito o no) finisce nella coda audit_outbox del database Projexa
// (Supporto/CreaDB/audit_log.sql); jobs/auditShipper.js la invia a Oracle
// (tabella AUDIT_OWNER.LOG_ACCESSI). La scrittura non viene attesa e un errore non
// blocca mai il login: al massimo quell'accesso non viene registrato.
// Il logout non passa dal server (il browser cancella il token), quindi non c'è.
// ============================================================================
import db from './database.js';

let codaMancanteSegnalata = false;

/**
 * evento: 'login' | 'magic_link' | 'google' | 'microsoft' | 'impersonazione' | 'cambio_password'
 * esito:  'ok' | 'ko'
 */
export function registraAccesso(req, { evento, esito = 'ok', userId = null, email = null, tenantId = null, dettaglio = null }) {
  const dati = {
    evento,
    esito,
    user_id: userId ? String(userId) : null,
    email: email ? String(email).trim().toLowerCase().slice(0, 320) : null,
    tenant_id: tenantId ? String(tenantId) : null,
    ip: (req && req.ip) || null,
    user_agent: req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 500) || null : null,
    dettaglio: dettaglio ? String(dettaglio).slice(0, 1000) : null
  };
  db.query("INSERT INTO audit_outbox (tipo, dati) VALUES ('accesso', $1)", [JSON.stringify(dati)])
    .catch((e) => {
      if (e.code === '42P01') { // tabella non ancora creata
        if (!codaMancanteSegnalata) console.warn('[AUDIT] Tabella audit_outbox assente: eseguire Supporto/CreaDB/audit_log.sql');
        codaMancanteSegnalata = true;
        return;
      }
      console.error('[AUDIT] Accesso non registrato:', e.message);
    });
}
