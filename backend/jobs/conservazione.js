// ============================================================================
// CONSERVAZIONE DEI DATI DELLE RIUNIONI (job «conservazione_riunioni», 2026-10-17)
// ----------------------------------------------------------------------------
// Politica di conservazione decisa dal titolare (documenti Legal, Checklist Retention):
// trascrizioni e recap si conservano 24 mesi dalla data della riunione. Ogni notte questo
// job, per tutti i tenant:
//   - svuota trascrizione, recap (anche la versione formattata) e recap interno delle riunioni
//     più vecchie del limite (la riga della riunione resta: data, oggetto, cliente, progetto);
//   - cancella le attività del recap interno di quelle riunioni (sono ricavate dalla
//     trascrizione). I task già creati dalle attività restano: sono dati di progetto;
//   - cancella le richieste di associazione To-Do e RAID più vecchie del limite (conservazioneAnalisi,
//     2026-10-23). I dati di addestramento dell'AI interna sono stati eliminati il 2026-10-29.
// Il limite si cambia con job_schedules.parametri = {"mesi": N} (minimo 6).
// Gira solo sulla VM (schedulatore). Le variazioni finiscono nel log di audit come le altre.
// ============================================================================
import db from '../config/database.js';

const MESI_PREDEFINITI = 24;

export async function eseguiConservazioneRiunioni({ mesi } = {}) {
  const n = Math.max(6, Math.round(Number(mesi) || MESI_PREDEFINITI));
  const limite = `${n} months`;
  const report = { ok: true, mesi: n, riunioniSvuotate: 0, attivitaCancellate: 0 };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const vecchie = await client.query(
      `UPDATE rec_meeting
          SET trascrizione = NULL, recap = NULL, recap_html = NULL, recap_interno = NULL
        WHERE data_calendar < CURRENT_DATE - $1::interval
          AND (trascrizione IS NOT NULL OR recap IS NOT NULL OR recap_html IS NOT NULL OR recap_interno IS NOT NULL)
        RETURNING tenant_id, user_id, id_calendar`,
      [limite]
    );
    report.riunioniSvuotate = vecchie.rowCount;
    // Attività del recap interno di tutte le riunioni oltre il limite (anche di quelle già
    // svuotate in un giro precedente).
    const att = await client.query(
      `DELETE FROM rec_meeting_attivita a
        USING rec_meeting m
        WHERE m.tenant_id = a.tenant_id AND m.user_id = a.user_id AND m.id_calendar = a.id_calendar
          AND m.data_calendar < CURRENT_DATE - $1::interval`,
      [limite]
    );
    report.attivitaCancellate = att.rowCount;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '42P01') return { ...report, nota: 'Tabelle delle riunioni non presenti' };
    throw e;
  } finally {
    client.release();
  }
  report.analisi = await conservazioneAnalisi(limite);
  const totAnalisi = Object.values(report.analisi).reduce((s, x) => s + (Number(x) || 0), 0);
  if (report.riunioniSvuotate || report.attivitaCancellate || totAnalisi) {
    console.log(`[CONSERVAZIONE] Oltre ${n} mesi: ${report.riunioniSvuotate} riunioni svuotate, ${report.attivitaCancellate} attività cancellate, ${totAnalisi} richieste di associazione cancellate`);
  }
  return report;
}

// Dati ricavati dalle riunioni e mandati all'AI (2026-10-23, richiesta utente). Stesso limite delle
// trascrizioni: si cancellano le righe di riunioni più vecchie del limite (o, se la riunione non
// c'è più o la riga non ne ha una, quelle create prima del limite). Ogni tabella è facoltativa
// (SQL non eseguito = si salta).
const ANALISI = [
  // Associazioni To-Do e RAID (voci e risposta dell'AI): non legate a una riunione.
  { nome: 'associazioni', tabella: 'pm_associazioni', riunione: false }
];

async function conservazioneAnalisi(limite) {
  const out = {};
  for (const a of ANALISI) {
    const sql = a.riunione
      ? `DELETE FROM ${a.tabella} x
          WHERE COALESCE(
                  (SELECT m.data_calendar FROM rec_meeting m
                    WHERE m.tenant_id = x.tenant_id AND m.user_id = x.user_id AND m.id_calendar = x.id_calendar LIMIT 1),
                  x.created_at::date) < CURRENT_DATE - $1::interval`
      : `DELETE FROM ${a.tabella} WHERE created_at < now() - $1::interval ${a.extra || ''}`;
    try {
      out[a.nome] = (await db.query(sql, [limite])).rowCount;
    } catch (e) {
      // Tabella o colonna non ancora create: nulla da conservare.
      if (e.code === '42P01' || e.code === '42703') continue;
      console.error(`[CONSERVAZIONE] ${a.tabella}: ${e.message}`);
      out[a.nome] = `errore: ${e.message}`;
    }
  }
  return out;
}
