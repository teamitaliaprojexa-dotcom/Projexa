// ============================================================================
// CHI STA MODIFICANDO: utente e tenant per i trigger del log variazioni
// ----------------------------------------------------------------------------
// I trigger audit_registra (Supporto/CreaDB/audit_log.sql) leggono utente, tenant e
// origine da current_setting('projexa.user_id' / 'projexa.tenant_id' / 'projexa.origine').
// Qui li impostiamo senza toccare le centinaia di query esistenti:
//
// - requireAuth apre un contesto (AsyncLocalStorage) con i dati della richiesta;
// - pool.query di una scrittura (INSERT/UPDATE/DELETE/...) dentro un contesto viene
//   eseguita in una piccola transazione con set_config(..., true): i valori valgono
//   solo per quella transazione e non restano sulla connessione del pool;
// - i client presi con pool.connect() (transazioni dell'app) ricevono i valori a
//   livello di sessione all'uscita dal pool e li perdono al rilascio.
// Letture e query fuori contesto (worker, avvio) restano esattamente come prima.
// ============================================================================
import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

export function contestoAudit() {
  return storage.getStore() || null;
}

// Esegue fn con il contesto indicato (userId, tenantId, origine).
export function conContestoAudit(ctx, fn) {
  return storage.run({
    userId: ctx.userId ? String(ctx.userId) : '',
    tenantId: ctx.tenantId ? String(ctx.tenantId) : '',
    origine: String(ctx.origine || '').slice(0, 400)
  }, fn);
}

// Middleware: da usare dopo che req.user è stato impostato.
export function contestoDaRichiesta(req, next) {
  const u = req.user || {};
  return conContestoAudit({
    userId: u.user_id,
    tenantId: u.tenant_id,
    origine: `${req.method} ${(req.originalUrl || req.url || '').split('?')[0]}`
  }, next);
}

const SCRITTURA_RE = /^\s*(insert|update|delete|merge|with)\b/i;
const TRANSAZIONE_RE = /\b(begin|commit|rollback|start\s+transaction)\b/i;
const IMPOSTA_SQL =
  "SELECT set_config('projexa.user_id', $1, $4), set_config('projexa.tenant_id', $2, $4), set_config('projexa.origine', $3, $4)";

function testoQuery(arg) {
  if (typeof arg === 'string') return arg;
  return arg && typeof arg.text === 'string' ? arg.text : '';
}

export function withAuditContext(pool) {
  if (pool.__auditWrapped) return pool;
  const queryInterna = pool.query.bind(pool);
  const connectInterna = pool.connect.bind(pool);

  pool.connect = async function (...args) {
    // Forma con callback: la usa pg-pool dentro pool.query, va lasciata com'è.
    if (typeof args[args.length - 1] === 'function') return connectInterna(...args);
    const client = await connectInterna(...args);
    const ctx = contestoAudit();
    if (ctx && client && !client.__auditRelease) {
      await client.query(IMPOSTA_SQL, [ctx.userId, ctx.tenantId, ctx.origine, false]);
      const release = client.release.bind(client);
      client.release = function (...r) {
        // Le query di un client sono in coda: l'azzeramento parte prima di qualsiasi
        // query del prossimo utilizzatore della connessione.
        client.query(IMPOSTA_SQL, ['', '', '', false]).catch(() => {});
        client.release = release;
        client.__auditRelease = false;
        return release(...r);
      };
      client.__auditRelease = true;
    }
    return client;
  };

  pool.query = async function (...args) {
    const ctx = contestoAudit();
    const testo = testoQuery(args[0]);
    if (!ctx || typeof args[args.length - 1] === 'function' ||
        !SCRITTURA_RE.test(testo) || TRANSAZIONE_RE.test(testo)) {
      return queryInterna(...args);
    }
    const client = await connectInterna();
    let errore;
    try {
      await client.query('BEGIN');
      await client.query(IMPOSTA_SQL, [ctx.userId, ctx.tenantId, ctx.origine, true]);
      const risultato = await client.query(...args);
      await client.query('COMMIT');
      return risultato;
    } catch (e) {
      errore = e;
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release(errore && errore.code === undefined ? errore : undefined);
    }
  };

  pool.__auditWrapped = true;
  return pool;
}
