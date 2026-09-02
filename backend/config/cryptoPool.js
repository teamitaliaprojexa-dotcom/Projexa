// ============================================================================
// DECIFRATURA AUTOMATICA IN LETTURA
// ----------------------------------------------------------------------------
// Avvolge un pool pg in modo che OGNI risultato di SELECT passi da decryptDeep:
// i valori con prefisso "enc:v1:" tornano in chiaro prima di arrivare agli
// endpoint. Così l'intera applicazione (dashboard, flyout, gantt, viewer,
// SQL editor, integrazioni) continua a lavorare sui valori leggibili senza
// dover modificare le decine di query esistenti.
//
// Il pool espone anche `rawQuery` (query non decifrata): la usa la migrazione,
// che deve poter leggere il testo cifrato così com'è sul database.
// ============================================================================
import { decryptDeep } from './crypto.js';

function decryptResult(result) {
  if (!result) return result;
  // pg restituisce un array di risultati quando la query contiene più statement.
  if (Array.isArray(result)) return result.map(decryptResult);
  if (Array.isArray(result.rows) && result.rows.length > 0) {
    result.rows = result.rows.map((row) => decryptDeep(row));
  }
  return result;
}

function wrapQuery(target) {
  const original = target.query.bind(target);
  target.rawQuery = original;
  target.query = function (...args) {
    // Forma con callback (pool.query(text, params, cb)): non usata dall'app,
    // viene inoltrata invariata per sicurezza.
    if (typeof args[args.length - 1] === 'function') return original(...args);
    const promise = original(...args);
    return promise && typeof promise.then === 'function'
      ? promise.then(decryptResult)
      : promise;
  };
}

export function withDecryption(pool) {
  if (pool.__cryptoWrapped) return pool;
  wrapQuery(pool);

  // I client presi da pool.connect() (transazioni: import CSV, SQL editor,
  // saveIntegration) hanno un loro metodo query: va avvolto anch'esso.
  const originalConnect = pool.connect.bind(pool);
  pool.rawConnect = originalConnect;
  pool.connect = async function (...args) {
    const client = await originalConnect(...args);
    if (client && !client.__cryptoWrapped) {
      wrapQuery(client);
      client.__cryptoWrapped = true;
    }
    return client;
  };

  pool.__cryptoWrapped = true;
  return pool;
}
