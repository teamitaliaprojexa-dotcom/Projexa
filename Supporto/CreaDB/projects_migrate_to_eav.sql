-- =====================================================================
-- RICREAZIONE tabella "projects" alla struttura EAV, con l'ORDINE colonne voluto
-- (client_id subito dopo user_id). In PostgreSQL non si può posizionare una colonna
-- con ALTER (va sempre in fondo), quindi si ricrea la tabella.
-- La tabella projects è vuota; i dipendenti (tasks/risks/meetings/documents/stakeholders)
-- referenziano projects.id: si rimuovono le loro FK, si ricrea projects, si ripristinano.
-- Tutto in transazione: se qualcosa fallisce, nulla viene applicato.
-- =====================================================================

BEGIN;

-- 1) Rimuove dinamicamente TUTTE le FK che puntano a projects (qualunque sia il loro nome).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'projects'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
  END LOOP;
END $$;

-- 2) Elimina e ricrea projects con l'ordine colonne desiderato.
DROP TABLE projects;

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,          -- FK -> tenants.id
  user_id UUID NOT NULL,            -- FK -> users.id
  client_id UUID,                   -- FK -> clients.id  (subito dopo user_id)
  argument VARCHAR(255),            -- argomento (alfanumerico)
  campo VARCHAR(255),               -- alfanumerico
  valore1 BOOLEAN,                  -- booleano
  valore2 VARCHAR(255),             -- alfanumerico
  valore3 INTEGER,                  -- numerico intero
  tabella VARCHAR(255),             -- alfanumerico
  colonna VARCHAR(255),             -- alfanumerico
  tipo_valore VARCHAR(255),         -- alfanumerico
  id_roles SMALLINT,                -- FK -> roles.id_roles
  data_inizio DATE,                 -- data
  scadenza DATE,                    -- data
  ordinamento INTEGER,              -- numerico intero (ordine di visualizzazione)
  layout_col INTEGER,               -- numerico intero (colonna di layout)
  "VariabDB" VARCHAR(500),          -- alfanumerico
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (client_id) REFERENCES clients(id),
  FOREIGN KEY (id_roles) REFERENCES roles(id_roles),
  FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code)
);

-- 3) Ripristina le FK dei dipendenti verso il nuovo projects (colonna project_id).
ALTER TABLE tasks        ADD CONSTRAINT tasks_project_id_fkey        FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE risks        ADD CONSTRAINT risks_project_id_fkey        FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE meetings     ADD CONSTRAINT meetings_project_id_fkey     FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE documents    ADD CONSTRAINT documents_project_id_fkey    FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE stakeholders ADD CONSTRAINT stakeholders_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

COMMIT;
