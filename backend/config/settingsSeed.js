// Impostazioni iniziali di un nuovo tenant (registrazione "Prova gratuita" e fallback OAuth).
// Il trigger trg_seed_settings_new_user_tenant copia le settings dagli altri utenti dello
// stesso tenant: per un tenant appena creato non c'è nessuno da cui copiare. In quel caso
// si parte dalle settings dell'utente modello del tenant PROJEXA.
export const SETTINGS_TEMPLATE_USER_ID = '0cffb615-27fc-4b52-aa13-a98cbcd16c5e';

// Colonne che non si copiano: l'id è nuovo, argument viene rimappato, contesto e date
// tecniche sono quelli del nuovo utente.
const SKIP = new Set(['id', 'tenant_id', 'user_id', 'argument', 'created_at', 'updated_at']);

// Copia tutte le righe settings dell'utente modello sul nuovo (tenant, utente), con tutti i
// valori. Ogni riga riceve un id nuovo; argument che punta all'id di un'altra riga copiata
// (figlio di un Nodo Padre) viene rimappato sul nuovo id del padre, altrimenti (nome
// dell'argomento) resta invariato. dbClient = client di transazione. Restituisce le righe create.
export async function seedSettingsFromTemplate(dbClient, tenantId, userId) {
  const colsRes = await dbClient.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'settings'
        AND is_generated = 'NEVER' AND is_identity = 'NO'
      ORDER BY ordinal_position`
  );
  const copyCols = colsRes.rows.map((r) => r.column_name).filter((c) => !SKIP.has(c));
  const q = (c) => `"${String(c).replace(/"/g, '""')}"`;

  // Tenant sorgente: quello PROJEXA dell'utente modello (se ne ha più d'uno).
  const r = await dbClient.query(
    `WITH src_tenant AS (
       SELECT s.tenant_id FROM settings s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.user_id = $1
        ORDER BY (UPPER(BTRIM(t.name)) = 'PROJEXA') DESC
        LIMIT 1
     ), src AS MATERIALIZED (
       SELECT s.*, gen_random_uuid() AS __new_id
         FROM settings s
        WHERE s.user_id = $1 AND s.tenant_id = (SELECT tenant_id FROM src_tenant)
     )
     INSERT INTO settings (id, tenant_id, user_id, argument${copyCols.map((c) => ', ' + q(c)).join('')})
     SELECT src.__new_id, $2::uuid, $3::uuid, COALESCE(parent.__new_id::text, src.argument)
            ${copyCols.map((c) => ', src.' + q(c)).join('')}
       FROM src
       LEFT JOIN src parent ON parent.id::text = src.argument`,
    [SETTINGS_TEMPLATE_USER_ID, tenantId, userId]
  );
  if (!r.rowCount) console.warn(`[SETTINGS_SEED] Nessuna impostazione trovata per l'utente modello ${SETTINGS_TEMPLATE_USER_ID}`);
  return r.rowCount;
}
