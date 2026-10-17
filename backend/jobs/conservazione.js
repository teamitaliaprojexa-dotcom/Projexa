// ============================================================================
// CONSERVAZIONE DEI DATI DELLE RIUNIONI (job «conservazione_riunioni», 2026-10-17)
// ----------------------------------------------------------------------------
// Politica di conservazione decisa dal titolare (documenti Legal, Checklist Retention):
// trascrizioni e recap si conservano 24 mesi dalla data della riunione. Ogni notte questo
// job, per tutti i tenant:
//   - svuota trascrizione, recap (anche la versione formattata) e recap interno delle riunioni
//     più vecchie del limite (la riga della riunione resta: data, oggetto, cliente, progetto);
//   - cancella le attività del recap interno di quelle riunioni (sono ricavate dalla
//     trascrizione). I task già creati dalle attività restano: sono dati di progetto.
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
  if (report.riunioniSvuotate || report.attivitaCancellate) {
    console.log(`[CONSERVAZIONE] Riunioni oltre ${n} mesi: ${report.riunioniSvuotate} svuotate, ${report.attivitaCancellate} attività cancellate`);
  }
  return report;
}
