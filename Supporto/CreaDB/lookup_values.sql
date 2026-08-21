-- =====================================================================
-- LOOKUP_VALUES — valori di riferimento (liste/decodifiche) per tabella/campo.
-- FK: tenant_id -> tenants(id), user_id -> users(id), tipo_valore -> tipo_valore(id_code).
-- NB: id_roles è VARCHAR(255) come da specifica, ma roles.id_roles è SMALLINT:
--     non è possibile una FK con tipi diversi, quindi id_roles NON ha FK.
--     Se vuoi la FK verso roles(id_roles), cambia il tipo in SMALLINT (vedi in fondo).
-- =====================================================================
CREATE TABLE lookup_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  user_id UUID,
  tabella VARCHAR(255),
  tipo_valore VARCHAR(255),
  nome_campo VARCHAR(255),
  valore VARCHAR(255),
  ordinamento INTEGER,
  data_inizio DATE,
  scadenza DATE,
  id_roles VARCHAR(255),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code)
);

-- Indice utile per le letture per (tenant, tabella, campo).
CREATE INDEX IF NOT EXISTS idx_lookup_values_lookup ON lookup_values (tenant_id, tabella, nome_campo);

-- (Opzionale) Per abilitare anche la FK su id_roles verso roles(id_roles):
--   ALTER TABLE lookup_values ALTER COLUMN id_roles TYPE SMALLINT USING id_roles::smallint;
--   ALTER TABLE lookup_values ADD CONSTRAINT lookup_values_id_roles_fkey
--     FOREIGN KEY (id_roles) REFERENCES roles(id_roles);
