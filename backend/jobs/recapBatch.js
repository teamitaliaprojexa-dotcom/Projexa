// ============================================================================
// RECAP IN MODALITÀ BATCH (Impostazioni › AI › «Esecuzione Recap» = "Batch (50% off)")
// ----------------------------------------------------------------------------
// Il recap non si chiede all'AI "subito" ma con la sua Batch API (ChatGPT, Claude, Gemini,
// Mistral): costa la metà e la risposta arriva entro 24 ore (di solito pochi minuti).
//   inviaRecapBatch -> prepara il prompt come il recap normale, invia il batch e salva la
//                      richiesta in rec_meeting_batch (stato 'in_corso');
//   eseguiRecapBatch -> job "recap_batch" dello schedulatore (ogni 5 minuti, solo sulla VM):
//                      chiede lo stato ai fornitori e salva i recap pronti sulla riunione
//                      (stessa strada del recap normale: correzioni, log, campanella).
// Tabella e job: Supporto/CreaDB/recap_batch.sql. "Recap Projexa (lento)" non ha il batch
// (è già gratuito): con lui il recap parte normalmente.
// ============================================================================
import db from '../config/database.js';
import { inviaBatchAi, statoBatchAi } from '../routes/ai.js';
import { recapSource, buildRecapPrompt, salvaRecap } from './meetingTranscription.js';
import { notificaRiunione } from './notifiche.js';

// Oltre questo tempo senza risposta il batch si considera fallito (i fornitori garantiscono 24 ore).
const SCADENZA_ORE = 26;

// Tipo della richiesta: 'recap' (recap per il cliente) o 'recap_interno' (scheda Recap
// interno, routes/recapInterno.js). La colonna tipo si legge con to_jsonb: se lo script SQL
// che la aggiunge non è ancora stato eseguito, tutte le richieste valgono come 'recap'.
const TIPO = "COALESCE(to_jsonb(b) ->> 'tipo', 'recap')";

function batchNonAttivo(msg) {
  const err = new Error(msg);
  err.status = 503;
  return err;
}

// Invia un prompt già pronto in modalità Batch e registra la richiesta.
export async function inviaPromptBatch(user, idCalendar, providerName, prompt, { tipo = 'recap', origine = null } = {}) {
  // Controlli PRIMA dell'invio: se tabella o colonna mancano ci si ferma senza aver mandato
  // (e pagato) una richiesta all'AI che poi nessuno raccoglierebbe.
  if (tipo !== 'recap') {
    const c = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'rec_meeting_batch' AND column_name = 'tipo'`
    );
    if (!c.rowCount) throw batchNonAttivo('Modalità Batch per il recap interno non ancora attiva: va rieseguito lo script Supporto/CreaDB/recap_batch.sql');
  }
  // Un nuovo batch dello stesso tipo per la stessa riunione sostituisce quello in attesa.
  try {
    await db.query(
      `UPDATE rec_meeting_batch b SET stato = 'sostituito', concluso_il = now()
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 AND stato = 'in_corso' AND ${TIPO} = $4`,
      [user.tenant_id, user.user_id, idCalendar, tipo]
    );
  } catch (e) {
    if (e.code === '42P01') throw batchNonAttivo('Modalità Batch non ancora attiva: va eseguito lo script Supporto/CreaDB/recap_batch.sql');
    throw e;
  }
  const { batchId, model, label } = await inviaBatchAi(user.user_id, providerName, prompt);
  const conTipo = tipo !== 'recap';
  await db.query(
    `INSERT INTO rec_meeting_batch (tenant_id, user_id, id_calendar, provider, model, batch_id, origine${conTipo ? ', tipo' : ''})
     VALUES ($1, $2, $3, $4, $5, $6, $7${conTipo ? ', $8' : ''})`,
    [user.tenant_id, user.user_id, idCalendar, providerName, model, batchId, origine, ...(conTipo ? [tipo] : [])]
  );
  console.log(`[RECAP BATCH] ${tipo} inviato a ${label} (${model}) per la riunione ${idCalendar}: ${batchId}`);
  return { provider: label, model, batchId };
}

// Recap per il cliente in modalità Batch: stesso prompt del recap normale (RECAP_EMAIL).
export async function inviaRecapBatch(user, idCalendar, providerName, { origine = null } = {}) {
  const { transcript, vars } = await recapSource(user, idCalendar);
  const prompt = await buildRecapPrompt(user, { ...vars, TRASCRIZIONE: transcript });
  return inviaPromptBatch(user, idCalendar, providerName, prompt, { tipo: 'recap', origine });
}

// Conclude la richiesta solo se è ancora "in corso" (un altro server può averla già chiusa).
async function concludi(riga, stato, errore = null) {
  await db.query(
    `UPDATE rec_meeting_batch SET stato = $2, errore = $3, controllato_il = now(), concluso_il = now()
      WHERE id = $1 AND stato = 'in_corso'`,
    [riga.id, stato, errore ? String(errore).slice(0, 1000) : null]
  );
}

// "Prenota" il controllo di una richiesta: con più server sullo stesso database (la VM e il
// backend locale) e con il controllo dalla dashboard, la stessa richiesta non si controlla
// (e quindi non si salva) due volte nello stesso minuto.
const PAUSA_CONTROLLO = '45 seconds';
async function prenota(id) {
  const r = await db.query(
    `UPDATE rec_meeting_batch SET controllato_il = now()
      WHERE id = $1 AND stato = 'in_corso'
        AND (controllato_il IS NULL OR controllato_il < now() - $2::interval)
      RETURNING id`,
    [id, PAUSA_CONTROLLO]
  );
  return r.rowCount > 0;
}

const SELECT_RIGHE = `SELECT id::text AS id, tenant_id, user_id, id_calendar, provider, model, batch_id, origine,
       ${TIPO} AS tipo, inviato_il < now() - ($1 || ' hours')::interval AS scaduto
  FROM rec_meeting_batch b`;

// Controlla una richiesta presso il fornitore e, se pronta, salva il recap.
// Restituisce 'completato' | 'fallito' | 'in_attesa' | 'saltato' (controllata da poco).
async function controllaRiga(riga, report) {
  if (!(await prenota(riga.id))) return 'saltato';
  const user = { tenant_id: riga.tenant_id, user_id: riga.user_id };
  const interno = riga.tipo === 'recap_interno';
  // Import dinamico: routes/recapInterno.js importa a sua volta questo file.
  const modInterno = () => import('../routes/recapInterno.js');
  const fallito = async (errore) => {
    await concludi(riga, 'fallito', errore);
    if (interno) await (await modInterno()).erroreRecapInternoBatch(user, riga.id_calendar, errore).catch(() => {});
    await notificaRiunione({ tenantId: riga.tenant_id, userId: riga.user_id, idCalendar: riga.id_calendar, tipo: 'recap_fallito' });
    if (report) report.errori.push(`${riga.id_calendar}: ${errore}`);
    return 'fallito';
  };
  try {
    const esito = await statoBatchAi(riga.user_id, riga.provider, riga.batch_id);
    if (esito.stato === 'in_corso') {
      if (riga.scaduto) return fallito(`Nessuna risposta da ${riga.provider} entro ${SCADENZA_ORE} ore`);
      await db.query(`UPDATE rec_meeting_batch SET errore = NULL WHERE id = $1`, [riga.id]);
      return 'in_attesa';
    }
    if (esito.stato === 'pronto' && interno) {
      await (await modInterno()).completaRecapInternoBatch(user, riga.id_calendar, esito.text, esito.label || riga.provider);
      await concludi(riga, 'completato');
      console.log(`[RECAP BATCH] ✓ Recap interno pronto (${riga.provider}) per la riunione ${riga.id_calendar}`);
      return 'completato';
    }
    if (esito.stato === 'pronto') {
      // Correzioni e intestazione si rileggono ora: valgono anche quelle aggiunte nel frattempo.
      const { vars, rules } = await recapSource(user, riga.id_calendar);
      await salvaRecap(user, riga.id_calendar, { text: esito.text, label: esito.label || riga.provider, model: riga.model },
        { rules, vars, origine: 'job:recap_batch' });
      await concludi(riga, 'completato');
      console.log(`[RECAP BATCH] ✓ Recap pronto (${riga.provider}) per la riunione ${riga.id_calendar}`);
      return 'completato';
    }
    return fallito(esito.errore);
  } catch (error) {
    // Chiave non valida o riunione/trascrizione sparita: inutile riprovare. Altri errori
    // (rete, fornitore momentaneamente non raggiungibile): si riprova al prossimo giro.
    // 502 da salvataggio del recap interno = risposta dell'AI non leggibile: definitivo anche quello.
    if (error.status === 400 || error.status === 404 || error.status === 428 || (interno && error.status === 502 && /leggibile/.test(error.message || ''))) {
      return fallito(error.message);
    }
    await db.query(`UPDATE rec_meeting_batch SET errore = $2 WHERE id = $1`, [riga.id, String(error.message || error).slice(0, 1000)]);
    if (report) report.errori.push(`${riga.id_calendar}: ${error.message}`);
    return 'in_attesa';
  }
}

// Job "recap_batch": controlla tutte le richieste in attesa. Restituisce il report del job.
export async function eseguiRecapBatch() {
  const report = { ok: true, controllati: 0, completati: 0, falliti: 0, inAttesa: 0, errori: [] };
  let righe;
  try {
    righe = (await db.query(`${SELECT_RIGHE} WHERE stato = 'in_corso' ORDER BY inviato_il LIMIT 200`, [String(SCADENZA_ORE)])).rows;
  } catch (e) {
    if (e.code === '42P01') return { ...report, nota: 'Tabella rec_meeting_batch non ancora creata (Supporto/CreaDB/recap_batch.sql)' };
    throw e;
  }
  for (const riga of righe) {
    const esito = await controllaRiga(riga, report);
    if (esito === 'saltato') continue;
    report.controllati += 1;
    if (esito === 'completato') report.completati += 1;
    else if (esito === 'fallito') report.falliti += 1;
    else report.inAttesa += 1;
  }
  if (report.falliti) report.ok = false;
  return report;
}

// Controllo "su richiesta" dalla dashboard (aggiornamento della lista riunioni): le richieste
// in attesa dell'utente si controllano subito, senza aspettare il job (che gira solo sulla VM).
// Non si attende il risultato: il recap compare al prossimo aggiornamento della lista.
const inControllo = new Set();
export function controllaRecapBatchUtente(user) {
  const k = `${user.tenant_id}|${user.user_id}`;
  if (inControllo.has(k)) return;
  inControllo.add(k);
  (async () => {
    const righe = (await db.query(
      `${SELECT_RIGHE} WHERE stato = 'in_corso' AND tenant_id = $2 AND user_id = $3 ORDER BY inviato_il LIMIT 20`,
      [String(SCADENZA_ORE), user.tenant_id, user.user_id]
    )).rows;
    for (const riga of righe) await controllaRiga(riga, null);
  })()
    .catch((e) => { if (e.code !== '42P01') console.error('❌ [RECAP BATCH] controllo dalla dashboard:', e.message); })
    .finally(() => inControllo.delete(k));
}
