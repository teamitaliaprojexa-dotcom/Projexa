

CREATE TABLE proj_worker_cost (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID ,
  user_id UUID ,
  client_id UUID,
  desc_worker VARCHAR(255),
  cost_worker NUMERIC(12,2),
  data_inizio DATE,
  scadenza DATE,
  id_roles SMALLINT,
 
   FOREIGN KEY (client_id) REFERENCES clients(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
 );
 


CREATE TABLE proj_worker (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    client_id UUID NOT NULL,
    project_id UUID NOT NULL,
    worker_cost_id UUID NOT NULL,

    effort_hh NUMERIC(12,2),
    effort_gg NUMERIC(12,2),

    tariffa_hh NUMERIC(12,2),
    tariffa_gg NUMERIC(12,2),

    costo_hh NUMERIC(12,2)
        GENERATED ALWAYS AS (
            ROUND(effort_hh * tariffa_hh, 2)
        ) STORED,

    costo_gg NUMERIC(12,2)
        GENERATED ALWAYS AS (
            ROUND(effort_gg * tariffa_gg, 2)
        ) STORED,

    time_spent_hh NUMERIC(12,2),
    time_spent_gg NUMERIC(12,2),
	
	cost_time_spent_hh NUMERIC(12,2)
	        GENERATED ALWAYS AS (
            ROUND(time_spent_hh * tariffa_hh, 2)
        ) STORED,
		
	cost_time_spent_gg NUMERIC(12,2)
	        GENERATED ALWAYS AS (
            ROUND(time_spent_gg * tariffa_gg, 2)
        ) STORED,	
		
    diff_hh NUMERIC(12,2)
        GENERATED ALWAYS AS (
            ROUND(
                (effort_hh * tariffa_hh)
                - (time_spent_hh * tariffa_hh),
                2
            )
        ) STORED,

    diff_gg NUMERIC(12,2)
        GENERATED ALWAYS AS (
            ROUND(
                (effort_gg * tariffa_gg)
                - (time_spent_gg * tariffa_gg),
                2
            )
        ) STORED,	
		
		
		data_inizio DATE,
		scadenza DATE,
    id_roles SMALLINT,

    CONSTRAINT fk_proj_worker_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id),

    CONSTRAINT fk_proj_worker_user
        FOREIGN KEY (user_id)
        REFERENCES users(id),

    CONSTRAINT fk_proj_worker_client
        FOREIGN KEY (client_id)
        REFERENCES clients(id),

    CONSTRAINT fk_proj_worker_project
        FOREIGN KEY (project_id)
        REFERENCES projects(id),

    CONSTRAINT fk_proj_worker_cost
        FOREIGN KEY (worker_cost_id)
        REFERENCES proj_worker_cost(id),

    CONSTRAINT uq_proj_worker_assignment
        UNIQUE (
            tenant_id,
            user_id,
            client_id,
            project_id,
            worker_cost_id
        )


);




ALTER TABLE projects ADD COLUMN IF NOT EXISTS id_roles_write VARCHAR(255);


ALTER TABLE settings ADD COLUMN IF NOT EXISTS id_roles_write VARCHAR(255);


ALTER TABLE clients ADD COLUMN IF NOT EXISTS id_roles_write VARCHAR(255);


ALTER TABLE proj_worker ALTER COLUMN id_roles TYPE SMALLINT  USING NULLIF(TRIM(id_roles), '')::SMALLINT;
ALTER TABLE proj_worker_cost ALTER COLUMN id_roles TYPE SMALLINT  USING NULLIF(TRIM(id_roles), '')::SMALLINT;







ALTER TABLE proj_worker
ADD CONSTRAINT fk_proj_worker_roles
FOREIGN KEY (id_roles)
REFERENCES roles(id_roles);

ALTER TABLE proj_worker_cost
ADD CONSTRAINT fk_proj_worker_cost_roles
FOREIGN KEY (id_roles)
REFERENCES roles(id_roles);

CREATE INDEX idx_proj_worker_id_roles ON proj_worker(id_roles);
CREATE INDEX idx_proj_worker_cost_id_roles ON proj_worker_cost(id_roles);


ALTER TABLE proj_worker
ADD CONSTRAINT fk_proj_worker_roles
FOREIGN KEY (id_roles)
REFERENCES roles(id_roles);

ALTER TABLE proj_worker
ADD CONSTRAINT fk_proj_worker_worker_cost
FOREIGN KEY (worker_cost_id)
REFERENCES proj_worker_cost(id);


CREATE TABLE proj_anno_fatt (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    client_id UUID NOT NULL,
    project_id UUID NOT NULL,
	anno INTEGER NOT NULL,
	gennaio NUMERIC(12,2),
	febbraio NUMERIC(12,2),
	marzo NUMERIC(12,2),
	aprile NUMERIC(12,2),
	maggio NUMERIC(12,2),
	giugno NUMERIC(12,2),
	luglio NUMERIC(12,2),
	agosto NUMERIC(12,2),
	settembre NUMERIC(12,2),
	ottobre NUMERIC(12,2),
	novembre NUMERIC(12,2),
	dicembre NUMERIC(12,2),
	  		data_inizio DATE,
		scadenza DATE,
    id_roles SMALLINT,
	id_roles_write SMALLINT,

FOREIGN KEY (client_id)   REFERENCES clients(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id)   REFERENCES users(id),
FOREIGN KEY (id_roles)    REFERENCES roles(id_roles),
 FOREIGN KEY (project_id) REFERENCES projects(id)
 );
 
 CREATE TABLE proj_componenti (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    client_id UUID NOT NULL,
    project_id UUID NOT NULL,
	 email VARCHAR(255) NOT NULL,
	 nominativo VARCHAR(255) NOT NULL,
	 team_pro VARCHAR(255) NOT NULL,
	 Licenza  VARCHAR(255) NOT NULL,
	 time_spent_hh NUMERIC(12,2),
	 time_spent_gg NUMERIC(12,2),
	
	
	
	data_inizio DATE,
	scadenza DATE,
    id_roles SMALLINT,
	id_roles_write SMALLINT,
	
	FOREIGN KEY (client_id)   REFERENCES clients(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id)   REFERENCES users(id),
FOREIGN KEY (id_roles)    REFERENCES roles(id_roles),
 FOREIGN KEY (project_id) REFERENCES projects(id)
 );
 
  CREATE TABLE set_label (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID ,
    user_id UUID ,
	tabella VARCHAR(255) ,
	colonna VARCHAR(255) ,
	da_pagina BOOLEAN DEFAULT FALSE,
	valore VARCHAR(255) NOT NULL,
	new_valore VARCHAR(255) NOT NULL,
	data_inizio DATE,
	scadenza DATE,
    id_roles SMALLINT,
	id_roles_write SMALLINT,
	id_lingua VARCHAR(3) DEFAULT 'IT',
	
	  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id)   REFERENCES users(id),
FOREIGN KEY (id_roles)    REFERENCES roles(id_roles),
FOREIGN KEY (id_roles_write)    REFERENCES roles(id_roles)
 );


 CREATE TABLE set_var_layout (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID ,
	tabella VARCHAR(255),
	tipo_valore VARCHAR(255),
	colonna VARCHAR(255),
	valori TEXT,
	tabella_lookup TEXT,
	colonna_lookup TEXT,
	descrizione_lookup TEXT,
	appo1 TEXT,
	appo2 TEXT,
	appo3 TEXT,
	ordinamento INTEGER,
	data_inizio DATE,
	scadenza DATE,
    id_roles SMALLINT,
	id_roles_write SMALLINT,
	 FOREIGN KEY (tenant_id) REFERENCES tenants(id),
	 FOREIGN KEY (id_roles)    REFERENCES roles(id_roles),
	 FOREIGN KEY (id_roles_write)    REFERENCES roles(id_roles),
	 FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code)
 );
 
 
  CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    client_id UUID,
    project_id UUID ,
	tipo_task VARCHAR(50) DEFAULT 'manual',
	titile VARCHAR(255) NOT NULL,
	description TEXT,
	status VARCHAR(50) DEFAULT 'todo',
	priority VARCHAR(50) DEFAULT 'medium',
   assigned_to UUID,
   due_date DATE,
   appo_task_1 VARCHAR(255),
   appo_task_2 TEXT,
   appo_task_3 INTEGER,
   appo_task_4 TEXT,
   
created_by UUID,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   
   
   
		data_inizio DATE,
	scadenza DATE,
    id_roles SMALLINT,
	id_roles_write SMALLINT,
	
	FOREIGN KEY (client_id)   REFERENCES clients(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id)   REFERENCES users(id),
FOREIGN KEY (id_roles)    REFERENCES roles(id_roles),
 FOREIGN KEY (id_roles_write)    REFERENCES roles(id_roles),
 FOREIGN KEY (project_id) REFERENCES projects(id)
 );
 
 
 ALTER TABLE tasks
ADD CONSTRAINT fk_tasks_assigned_to
FOREIGN KEY (assigned_to)
REFERENCES proj_componenti(id);



ALTER TABLE proj_componenti ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE proj_componenti ALTER COLUMN project_id DROP NOT NULL;


 ALTER TABLE tasks
ADD CONSTRAINT fk_client_id
FOREIGN KEY (client_id)
REFERENCES clients(id);

ALTER TABLE proj_componenti ALTER COLUMN licenza TYPE uuid USING licenza::uuid;

ALTER TABLE proj_componenti
ADD CONSTRAINT fk_proj_componenti_licenza
FOREIGN KEY (licenza)
REFERENCES proj_worker_cost(id);

ALTER TABLE proj_componenti drop COLUMN licenza;
ALTER TABLE proj_componenti ALTER COLUMN team_pro DROP NOT NULL;

ALTER TABLE proj_componenti ALTER COLUMN team_pro TYPE uuid USING team_pro::uuid;

 ALTER TABLE proj_componenti
ADD CONSTRAINT fk_proj_componenti_team_pro
FOREIGN KEY (team_pro)
REFERENCES proj_worker_cost(id);

ALTER TABLE tasks RENAME COLUMN titile TO title;
