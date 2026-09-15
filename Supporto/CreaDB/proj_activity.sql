-- ============================================================================
-- GANTT (tipo_valore = 13): tabella proj_activity + nuovo tipo campo
-- Da eseguire manualmente sul progetto Neon principale (Projexa / DATABASE_URL).
-- ============================================================================

-- Ogni riga è un "pulsante" (nodo) del Gantt: il livello del nodo è dato dal
-- campo argomentoN valorizzato (argomento1 = 1° livello, ... argomento4 = 4°).
-- L'ordinamento gerarchico usa ordinamento1..4: un nodo di livello N ha
-- valorizzati ordinamento1..N (quelli dei livelli superiori sono ereditati
-- dagli antenati), i restanti sono NULL. Lettura: ORDER BY ordinamento1,
-- ordinamento2 NULLS FIRST, ordinamento3 NULLS FIRST, ordinamento4 NULLS FIRST.
CREATE TABLE proj_activity (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    user_id     uuid NOT NULL,
    client_id   uuid NOT NULL,
    project_id  uuid NOT NULL,
    argomento1  text,
    ordinamento1 integer,
    argomento2  text,
    ordinamento2 integer,
    argomento3  text,
    ordinamento3 integer,
    argomento4  text,
    ordinamento4 integer,
    data_inizio date,
    data_fine   date,
	
	nr_mesi VARCHAR(255),
nr_giorni VARCHAR(255),
stato VARCHAR(255),
avanzamento INTEGER DEFAULT 0 ,
rischio VARCHAR(255),
owner VARCHAR(255),
nominativo VARCHAR(255),
note_interne TEXT,
	
	
	-- false = l'attività non compare nella vista "Mostra gantt"
	mostra_cliente BOOLEAN DEFAULT TRUE,
	-- Etichette personalizzate delle 4 colonne (valgono per tutto il progetto:
	-- la pagina gantt.html le scrive su tutte le righe dello stesso progetto)
	name_arg1 VARCHAR(255),
	name_arg2 VARCHAR(255),
	name_arg3 VARCHAR(255),
	name_arg4 VARCHAR(255),

    -- id (uuid) del nodo da cui questa attività dipende (freccia nel Gantt)
    dipendenza  uuid REFERENCES proj_activity(id) ON DELETE SET NULL,
    -- colore di riempimento: usato solo sui nodi di livello 1 (argomento1);
    -- i livelli 2/3/4 mostrano lo stesso colore in tonalità più chiara
    colore      text,
    created_at  timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at  timestamptz DEFAULT CURRENT_TIMESTAMP,
	update_by UUID,
	scadenza DATE DEFAULT'2099-12-31',
id_roles SMALLINT,
id_roles_write SMALLINT,
	

    CONSTRAINT fk_proj_activity_tenant  FOREIGN KEY (tenant_id)  REFERENCES tenants(id),
    CONSTRAINT fk_proj_activity_user    FOREIGN KEY (user_id)    REFERENCES users(id),
    CONSTRAINT fk_proj_activity_client  FOREIGN KEY (client_id)  REFERENCES clients(id),
    CONSTRAINT fk_proj_activity_project FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX idx_proj_activity_ctx ON proj_activity(tenant_id, user_id, client_id, project_id);
CREATE INDEX idx_proj_activity_dipendenza ON proj_activity(dipendenza);

-- Nuovo tipo campo 13: come la griglia (11), ma con "Abilita modifica" attivo
-- mostra solo il pulsante "Modifica" che apre la pagina gantt.html.
-- id_roles = 1: visibile solo agli admin nella scelta del tipo (adeguare se serve).


-- NOTA configurazione campo: nella riga EAV (projects) del campo tipo 13 vanno
-- valorizzati, come per il tipo 11, "tabella" = 'proj_activity' e "colonna" =
-- elenco colonne da mostrare in griglia, es.:
--   'argomento1;argomento2;argomento3;argomento4;data_inizio;data_fine'

-- Se la tabella era già stata creata con il refuso "nomiinativo", rinominare così:
--   ALTER TABLE proj_activity RENAME COLUMN nomiinativo TO nominativo;

-- Colonne aggiunte dopo la creazione iniziale (già incluse nel CREATE TABLE sopra:
-- servono solo se la tabella esisteva già).
alter table proj_activity add column mostra_cliente BOOLEAN DEFAULT TRUE;
alter table proj_activity add column name_arg1 VARCHAR(255);
alter table proj_activity add column name_arg2 VARCHAR(255);
alter table proj_activity add column name_arg3 VARCHAR(255);
alter table proj_activity add column name_arg4 VARCHAR(255);
