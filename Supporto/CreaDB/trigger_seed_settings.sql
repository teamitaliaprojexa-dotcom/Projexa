-- =====================================================================
-- Seeding automatico di SETTINGS alla creazione di un'associazione utente-tenant
-- ---------------------------------------------------------------------
-- Quando viene inserita una riga in user_tenants (nuovo utente associato a un tenant),
-- il trigger copia per quel (user_id, tenant_id) le DEFINIZIONI STANDARD di settings
-- già presenti per lo stesso tenant, con i valori VUOTI (NULL).
--
-- - Copia anche le righe "marker" (campo IS NULL) così gli argomenti compaiono subito.
-- - Esclude i campi custom: filtro  campo NOT LIKE '(*)%'.
-- - È "a prova di futuro": legge dinamicamente il catalogo standard esistente, quindi
--   i campi standard aggiunti in seguito verranno inclusi per i nuovi utenti creati dopo,
--   senza modificare il trigger.
-- - Non fa nulla per i CLIENTS: i campi standard dei clienti vengono già replicati alla
--   creazione di ogni cliente (POST /api/clients).
-- - Idempotente: la guardia NOT EXISTS evita di duplicare righe già presenti.
--
-- NB: per il PRIMO utente di un tenant nuovo non c'è ancora un catalogo da cui copiare,
--     quindi non viene seminato nulla; i campi standard verranno definiti dopo (ambito
--     "tutti i tenant") e propagati anche a quel primo utente.
-- =====================================================================

CREATE OR REPLACE FUNCTION seed_settings_new_user_tenant()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO settings (tenant_id, user_id, argument, campo, tipo_valore,
                        id_roles, ordinamento, tabella, colonna, layout_col, "VariabDB")
  SELECT DISTINCT NEW.tenant_id, NEW.user_id, s.argument, s.campo, s.tipo_valore,
         s.id_roles, s.ordinamento, s.tabella, s.colonna, s.layout_col, s."VariabDB"
  FROM settings s
  WHERE s.tenant_id = NEW.tenant_id
    AND s.user_id <> NEW.user_id
    AND (s.campo IS NULL OR s.campo NOT LIKE '(*)%')   -- righe marker + campi standard (no custom)
    AND NOT EXISTS (                                    -- non duplicare righe già presenti
      SELECT 1 FROM settings x
      WHERE x.tenant_id = NEW.tenant_id AND x.user_id = NEW.user_id
        AND x.argument IS NOT DISTINCT FROM s.argument
        AND x.campo    IS NOT DISTINCT FROM s.campo);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_settings_new_user_tenant ON user_tenants;
CREATE TRIGGER trg_seed_settings_new_user_tenant
AFTER INSERT ON user_tenants
FOR EACH ROW EXECUTE FUNCTION seed_settings_new_user_tenant();
