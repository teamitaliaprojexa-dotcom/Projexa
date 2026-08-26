-- ============================================================
-- PostgreSQL schema reconstruction - UPDATED
-- Generated from supplied CSV metadata extractions
-- Includes the latest function extraction uploaded 25/08/2026.
-- IMPORTANT: this script reconstructs schema/DDL only; no data.
-- ============================================================

BEGIN;

-- ============================================================
-- SCHEMAS
-- ============================================================
CREATE SCHEMA IF NOT EXISTS "auth";
CREATE SCHEMA IF NOT EXISTS "public";

-- ============================================================
-- SEQUENCES
-- ============================================================
CREATE SEQUENCE "public"."activity_log_id_seq"
    INCREMENT BY 1
    MINVALUE 1
    MAXVALUE 2147483647
    START WITH 1
    CACHE 1
    NO CYCLE;

CREATE SEQUENCE "public"."email_recaps_id_seq"
    INCREMENT BY 1
    MINVALUE 1
    MAXVALUE 2147483647
    START WITH 1
    CACHE 1
    NO CYCLE;

-- ============================================================
-- TABLES
-- ============================================================
CREATE TABLE "public"."activity_log" (
    "id" integer NOT NULL DEFAULT nextval('activity_log_id_seq'::regclass),
    "project_id" integer NOT NULL,
    "user_id" integer,
    "action" text NOT NULL,
    "entity_type" text,
    "entity_id" integer,
    "description" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."activity_logs" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "action" character varying(255),
    "resource_type" character varying(100),
    "resource_id" uuid,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."client_shares" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "client_id" uuid NOT NULL,
    "shared_with_user_id" uuid NOT NULL,
    "owner_user_id" uuid NOT NULL,
    "permission" character varying(10) NOT NULL DEFAULT 'write'::character varying,
    "created_by" uuid,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."clients" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "argument" character varying(255),
    "campo" character varying(255),
    "valore1" boolean,
    "valore2" text,
    "valore3" numeric(12,2),
    "tabella" character varying(255),
    "colonna" character varying(255),
    "tipo_valore" character varying(255),
    "id_roles" smallint,
    "data_inizio" date,
    "scadenza" date,
    "ordinamento" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "layout_col" integer,
    "VariabDB" character varying(500),
    "layout_span" integer DEFAULT 1,
    "id_roles_write" character varying(255)
);

CREATE TABLE "public"."contacts" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "id_cliente" uuid,
    "nome" character varying(255),
    "cognome" character varying(255),
    "nominativo" character varying(511) DEFAULT TRIM(BOTH FROM (((COALESCE(nome, ''::character varying))::text || ' '::text) || (COALESCE(cognome, ''::character varying))::text)),
    "bu" character varying(255),
    "qualifica" character varying(255),
    "email" character varying(255),
    "telefono" character varying(50),
    "cellulare" character varying(50),
    "responsabile" uuid,
    "sede" character varying(255),
    "note" text,
    "ordinamento" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "data_nascita" date,
    "eta" integer
);

CREATE TABLE "public"."documents" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "project_id" uuid NOT NULL,
    "title" character varying(255) NOT NULL,
    "file_url" character varying(512),
    "file_type" character varying(50),
    "uploaded_by" uuid NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."email_recaps" (
    "id" integer NOT NULL DEFAULT nextval('email_recaps_id_seq'::regclass),
    "project_id" integer NOT NULL,
    "recipient_email" text NOT NULL,
    "subject" text NOT NULL,
    "body" text NOT NULL,
    "sent" boolean DEFAULT false,
    "sent_at" timestamp without time zone,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."function_db" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid,
    "cod_istruzione" integer,
    "istruzione" character varying(255),
    "funzione" character varying(255),
    "fun_tenant" character varying(255),
    "fun_user" character varying(255),
    "fun_tabella" character varying(255),
    "fun_colonna" character varying(255)
);

CREATE TABLE "public"."lookup_values" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid,
    "user_id" uuid,
    "tabella" character varying(255),
    "tipo_valore" character varying(255),
    "nome_campo" character varying(255),
    "valore" character varying(255),
    "ordinamento" integer,
    "data_inizio" date,
    "scadenza" date,
    "id_roles" character varying(255)
);

CREATE TABLE "public"."meetings" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "project_id" uuid NOT NULL,
    "title" character varying(255) NOT NULL,
    "description" text,
    "meeting_date" timestamp without time zone,
    "location" character varying(255),
    "created_by" uuid NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."proj_anno_fatt" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "client_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    "anno" integer NOT NULL,
    "gennaio" numeric(12,2),
    "febbraio" numeric(12,2),
    "marzo" numeric(12,2),
    "aprile" numeric(12,2),
    "maggio" numeric(12,2),
    "giugno" numeric(12,2),
    "luglio" numeric(12,2),
    "agosto" numeric(12,2),
    "settembre" numeric(12,2),
    "ottobre" numeric(12,2),
    "novembre" numeric(12,2),
    "dicembre" numeric(12,2),
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint,
    "id_roles_write" smallint
);

CREATE TABLE "public"."proj_componenti" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "client_id" uuid,
    "project_id" uuid,
    "email" character varying(255) NOT NULL,
    "nominativo" character varying(255) NOT NULL,
    "team_pro" uuid,
    "time_spent_hh" numeric(12,2),
    "time_spent_gg" numeric(12,2),
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint,
    "id_roles_write" smallint
);

CREATE TABLE "public"."proj_worker" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "client_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    "worker_cost_id" uuid NOT NULL,
    "effort_hh" numeric(12,2),
    "effort_gg" numeric(12,2),
    "tariffa_hh" numeric(12,2),
    "tariffa_gg" numeric(12,2),
    "costo_hh" numeric(12,2) DEFAULT round((effort_hh * tariffa_hh), 2),
    "costo_gg" numeric(12,2) DEFAULT round((effort_gg * tariffa_gg), 2),
    "time_spent_hh" numeric(12,2),
    "time_spent_gg" numeric(12,2),
    "cost_time_spent_hh" numeric(12,2) DEFAULT round((time_spent_hh * tariffa_hh), 2),
    "cost_time_spent_gg" numeric(12,2) DEFAULT round((time_spent_gg * tariffa_gg), 2),
    "diff_hh" numeric(12,2) DEFAULT round(((effort_hh * tariffa_hh) - (time_spent_hh * tariffa_hh)), 2),
    "diff_gg" numeric(12,2) DEFAULT round(((effort_gg * tariffa_gg) - (time_spent_gg * tariffa_gg)), 2),
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint
);

CREATE TABLE "public"."proj_worker_cost" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid,
    "user_id" uuid,
    "client_id" uuid,
    "desc_worker" character varying(255),
    "cost_worker" numeric(12,2),
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint,
    "cod_billing" character varying(255)
);

CREATE TABLE "public"."projects" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "client_id" uuid,
    "argument" character varying(255),
    "campo" character varying(255),
    "valore1" boolean,
    "valore2" text,
    "valore3" numeric(12,2),
    "tabella" character varying(255),
    "colonna" character varying(255),
    "tipo_valore" character varying(255),
    "id_roles" smallint,
    "data_inizio" date,
    "scadenza" date,
    "ordinamento" integer,
    "layout_col" integer,
    "VariabDB" character varying(500),
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "layout_span" integer DEFAULT 1,
    "id_roles_write" character varying(255)
);

CREATE TABLE "public"."risks" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "project_id" uuid NOT NULL,
    "title" character varying(255) NOT NULL,
    "description" text,
    "probability" character varying(50),
    "impact" character varying(50),
    "status" character varying(50) DEFAULT 'open'::character varying,
    "created_by" uuid NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."roles" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "name" character varying(50) NOT NULL,
    "description" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "id_roles" smallint NOT NULL DEFAULT 0
);

CREATE TABLE "public"."set_label" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid,
    "user_id" uuid,
    "tabella" character varying(255),
    "colonna" character varying(255),
    "da_pagina" boolean DEFAULT false,
    "valore" character varying(255) NOT NULL,
    "new_valore" character varying(255) NOT NULL,
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint,
    "id_roles_write" smallint,
    "id_lingua" character varying(3) DEFAULT 'IT'::character varying
);

CREATE TABLE "public"."set_var_layout" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid,
    "tabella" character varying(255),
    "tipo_valore" character varying(255),
    "colonna" character varying(255),
    "valori" text,
    "tabella_lookup" text,
    "colonna_lookup" text,
    "descrizione_lookup" text,
    "appo1" text,
    "appo2" text,
    "appo3" text,
    "ordinamento" integer,
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint,
    "id_roles_write" smallint
);

CREATE TABLE "public"."settings" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "argument" character varying(255),
    "campo" character varying(255),
    "valore1" boolean,
    "valore2" text,
    "valore3" numeric(12,2),
    "tabella" character varying(255),
    "colonna" character varying(255),
    "tipo_valore" character varying(255),
    "data_inizio" date,
    "scadenza" date,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "id_roles" smallint,
    "ordinamento" integer,
    "layout_col" integer,
    "VariabDB" character varying(500),
    "layout_span" integer DEFAULT 1,
    "id_roles_write" character varying(255)
);

CREATE TABLE "public"."stakeholders" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "project_id" uuid NOT NULL,
    "name" character varying(255) NOT NULL,
    "role" character varying(255),
    "email" character varying(255),
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."table_structures" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "table_name" character varying(255) NOT NULL,
    "display_name" character varying(255) NOT NULL,
    "description" text,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."tasks" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "client_id" uuid,
    "project_id" uuid,
    "tipo_task" character varying(50) DEFAULT 'manual'::character varying,
    "titile" character varying(255) NOT NULL,
    "description" text,
    "status" character varying(50) DEFAULT 'todo'::character varying,
    "priority" character varying(50) DEFAULT 'medium'::character varying,
    "assigned_to" uuid,
    "due_date" date,
    "appo_task_1" character varying(255),
    "appo_task_2" text,
    "appo_task_3" integer,
    "appo_task_4" text,
    "created_by" uuid,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "data_inizio" date,
    "scadenza" date,
    "id_roles" smallint,
    "id_roles_write" smallint
);

CREATE TABLE "public"."tenants" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "name" character varying(255) NOT NULL,
    "slug" character varying(255) NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."tipo_valore" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "id_code" character varying(255) NOT NULL,
    "description" text,
    "tooltip" text,
    "id_roles" smallint
);

CREATE TABLE "public"."user_roles" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "role_id" uuid NOT NULL,
    "tenant_id" uuid,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "public"."user_tenants" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "role_id" character varying(50) DEFAULT 'member'::character varying,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "id_roles" smallint NOT NULL
);

CREATE TABLE "public"."users" (
    "id" uuid NOT NULL,
    "name" character varying(255) NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "cognome" character varying(255),
    "updated_by" uuid
);

-- ============================================================
-- CONSTRAINTS
-- ============================================================
ALTER TABLE "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."client_shares"
    ADD CONSTRAINT "client_shares_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE "public"."client_shares"
    ADD CONSTRAINT "client_shares_client_id_shared_with_user_id_key" UNIQUE (client_id, shared_with_user_id);

ALTER TABLE "public"."client_shares"
    ADD CONSTRAINT "client_shares_owner_user_id_fkey" FOREIGN KEY (owner_user_id) REFERENCES users(id);

ALTER TABLE "public"."client_shares"
    ADD CONSTRAINT "client_shares_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."client_shares"
    ADD CONSTRAINT "client_shares_shared_with_user_id_fkey" FOREIGN KEY (shared_with_user_id) REFERENCES users(id);

ALTER TABLE "public"."client_shares"
    ADD CONSTRAINT "client_shares_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."clients"
    ADD CONSTRAINT "clients_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."clients"
    ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."clients"
    ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."clients"
    ADD CONSTRAINT "fk_clients_tipo_valore" FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code);

ALTER TABLE "public"."contacts"
    ADD CONSTRAINT "contacts_id_cliente_fkey" FOREIGN KEY (id_cliente) REFERENCES clients(id) ON DELETE SET NULL;

ALTER TABLE "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."contacts"
    ADD CONSTRAINT "contacts_responsabile_fkey" FOREIGN KEY (responsabile) REFERENCES contacts(id) ON DELETE SET NULL;

ALTER TABLE "public"."contacts"
    ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."contacts"
    ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."documents"
    ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."documents"
    ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES users(id);

ALTER TABLE "public"."email_recaps"
    ADD CONSTRAINT "email_recaps_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."function_db"
    ADD CONSTRAINT "function_db_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."function_db"
    ADD CONSTRAINT "function_db_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."lookup_values"
    ADD CONSTRAINT "lookup_values_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."lookup_values"
    ADD CONSTRAINT "lookup_values_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."lookup_values"
    ADD CONSTRAINT "lookup_values_tipo_valore_fkey" FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code);

ALTER TABLE "public"."lookup_values"
    ADD CONSTRAINT "lookup_values_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."meetings"
    ADD CONSTRAINT "meetings_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE "public"."meetings"
    ADD CONSTRAINT "meetings_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."meetings"
    ADD CONSTRAINT "meetings_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."proj_anno_fatt"
    ADD CONSTRAINT "proj_anno_fatt_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."proj_anno_fatt"
    ADD CONSTRAINT "proj_anno_fatt_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."proj_anno_fatt"
    ADD CONSTRAINT "proj_anno_fatt_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."proj_anno_fatt"
    ADD CONSTRAINT "proj_anno_fatt_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."proj_anno_fatt"
    ADD CONSTRAINT "proj_anno_fatt_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."proj_anno_fatt"
    ADD CONSTRAINT "proj_anno_fatt_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "fk_proj_componenti_team_pro" FOREIGN KEY (team_pro) REFERENCES proj_worker_cost(id);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "proj_componenti_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "proj_componenti_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "proj_componenti_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "proj_componenti_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "proj_componenti_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."proj_componenti"
    ADD CONSTRAINT "proj_componenti_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "fk_proj_worker_client" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "fk_proj_worker_cost" FOREIGN KEY (worker_cost_id) REFERENCES proj_worker_cost(id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "fk_proj_worker_project" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "fk_proj_worker_roles" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "fk_proj_worker_tenant" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "fk_proj_worker_user" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "proj_worker_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."proj_worker"
    ADD CONSTRAINT "uq_proj_worker_assignment" UNIQUE (tenant_id, user_id, client_id, project_id, worker_cost_id);

ALTER TABLE "public"."proj_worker_cost"
    ADD CONSTRAINT "fk_proj_worker_cost_roles" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."proj_worker_cost"
    ADD CONSTRAINT "proj_worker_cost_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."proj_worker_cost"
    ADD CONSTRAINT "proj_worker_cost_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."proj_worker_cost"
    ADD CONSTRAINT "proj_worker_cost_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."proj_worker_cost"
    ADD CONSTRAINT "proj_worker_cost_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_tipo_valore_fkey" FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code);

ALTER TABLE "public"."projects"
    ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."risks"
    ADD CONSTRAINT "risks_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE "public"."risks"
    ADD CONSTRAINT "risks_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."risks"
    ADD CONSTRAINT "risks_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."roles"
    ADD CONSTRAINT "roles_name_key" UNIQUE (name);

ALTER TABLE "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."roles"
    ADD CONSTRAINT "unique_id_roles" UNIQUE (id_roles);

ALTER TABLE "public"."set_label"
    ADD CONSTRAINT "set_label_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."set_label"
    ADD CONSTRAINT "set_label_id_roles_write_fkey" FOREIGN KEY (id_roles_write) REFERENCES roles(id_roles);

ALTER TABLE "public"."set_label"
    ADD CONSTRAINT "set_label_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."set_label"
    ADD CONSTRAINT "set_label_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."set_label"
    ADD CONSTRAINT "set_label_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."set_var_layout"
    ADD CONSTRAINT "set_var_layout_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."set_var_layout"
    ADD CONSTRAINT "set_var_layout_id_roles_write_fkey" FOREIGN KEY (id_roles_write) REFERENCES roles(id_roles);

ALTER TABLE "public"."set_var_layout"
    ADD CONSTRAINT "set_var_layout_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."set_var_layout"
    ADD CONSTRAINT "set_var_layout_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."set_var_layout"
    ADD CONSTRAINT "set_var_layout_tipo_valore_fkey" FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code);

ALTER TABLE "public"."settings"
    ADD CONSTRAINT "fk_settings_id_roles" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."settings"
    ADD CONSTRAINT "fk_settings_tipo_valore" FOREIGN KEY (tipo_valore) REFERENCES tipo_valore(id_code);

ALTER TABLE "public"."settings"
    ADD CONSTRAINT "settings_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."settings"
    ADD CONSTRAINT "settings_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."settings"
    ADD CONSTRAINT "settings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."stakeholders"
    ADD CONSTRAINT "stakeholders_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."stakeholders"
    ADD CONSTRAINT "stakeholders_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."table_structures"
    ADD CONSTRAINT "table_structures_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."table_structures"
    ADD CONSTRAINT "table_structures_table_name_key" UNIQUE (table_name);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "fk_client_id" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "fk_tasks_assigned_to" FOREIGN KEY (assigned_to) REFERENCES proj_componenti(id);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_id_roles_fkey" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_id_roles_write_fkey" FOREIGN KEY (id_roles_write) REFERENCES roles(id_roles);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE "public"."tasks"
    ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE "public"."tenants"
    ADD CONSTRAINT "tenants_name_key" UNIQUE (name);

ALTER TABLE "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."tenants"
    ADD CONSTRAINT "tenants_slug_key" UNIQUE (slug);

ALTER TABLE "public"."tipo_valore"
    ADD CONSTRAINT "fk_tipo_valore_id_roles" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."tipo_valore"
    ADD CONSTRAINT "tipo_valore_id_code_key" UNIQUE (id_code);

ALTER TABLE "public"."tipo_valore"
    ADD CONSTRAINT "tipo_valore_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."user_roles"
    ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_roles"
    ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_role_id_tenant_id_key" UNIQUE (user_id, role_id, tenant_id);

ALTER TABLE "public"."user_tenants"
    ADD CONSTRAINT "fk_user_tenants_id_roles" FOREIGN KEY (id_roles) REFERENCES roles(id_roles);

ALTER TABLE "public"."user_tenants"
    ADD CONSTRAINT "user_tenants_pkey" PRIMARY KEY (id);

ALTER TABLE "public"."user_tenants"
    ADD CONSTRAINT "user_tenants_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_tenants"
    ADD CONSTRAINT "user_tenants_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_tenants"
    ADD CONSTRAINT "user_tenants_user_id_tenant_id_key" UNIQUE (user_id, tenant_id);

ALTER TABLE "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY (id);

-- ============================================================
-- INDEXES
-- ============================================================
-- NOTE: the original index CSV labels ci.relname as table_name; pg_get_indexdef() is preserved verbatim.
CREATE UNIQUE INDEX activity_log_pkey ON public.activity_log USING btree (id);

CREATE UNIQUE INDEX activity_logs_pkey ON public.activity_logs USING btree (id);

CREATE UNIQUE INDEX client_shares_client_id_shared_with_user_id_key ON public.client_shares USING btree (client_id, shared_with_user_id);

CREATE UNIQUE INDEX client_shares_pkey ON public.client_shares USING btree (id);

CREATE UNIQUE INDEX clients_pkey ON public.clients USING btree (id);

CREATE UNIQUE INDEX contacts_pkey ON public.contacts USING btree (id);

CREATE UNIQUE INDEX documents_pkey ON public.documents USING btree (id);

CREATE UNIQUE INDEX email_recaps_pkey ON public.email_recaps USING btree (id);

CREATE UNIQUE INDEX function_db_pkey ON public.function_db USING btree (id);

CREATE INDEX idx_activity_logs_tenant_id ON public.activity_logs USING btree (tenant_id);

CREATE INDEX idx_activity_logs_user_id ON public.activity_logs USING btree (user_id);

CREATE INDEX idx_client_shares_client ON public.client_shares USING btree (client_id);

CREATE INDEX idx_client_shares_user ON public.client_shares USING btree (shared_with_user_id, tenant_id);

CREATE INDEX idx_clients_data_inizio ON public.clients USING btree (data_inizio);

CREATE INDEX idx_clients_id_roles ON public.clients USING btree (id_roles);

CREATE INDEX idx_clients_scadenza ON public.clients USING btree (scadenza);

CREATE INDEX idx_clients_tenant_id ON public.clients USING btree (tenant_id);

CREATE INDEX idx_clients_tenant_user ON public.clients USING btree (tenant_id, user_id);

CREATE INDEX idx_clients_tipo_valore ON public.clients USING btree (tipo_valore);

CREATE INDEX idx_clients_user_id ON public.clients USING btree (user_id);

CREATE INDEX idx_contacts_cliente ON public.contacts USING btree (id_cliente);

CREATE INDEX idx_contacts_responsabile ON public.contacts USING btree (responsabile);

CREATE INDEX idx_contacts_tenant ON public.contacts USING btree (tenant_id);

CREATE INDEX idx_documents_project_id ON public.documents USING btree (project_id);

CREATE INDEX idx_lookup_values_lookup ON public.lookup_values USING btree (tenant_id, tabella, nome_campo);

CREATE INDEX idx_meetings_project_id ON public.meetings USING btree (project_id);

CREATE INDEX idx_proj_worker_cost_id_roles ON public.proj_worker_cost USING btree (id_roles);

CREATE INDEX idx_proj_worker_id_roles ON public.proj_worker USING btree (id_roles);

CREATE INDEX idx_risks_project_id ON public.risks USING btree (project_id);

CREATE INDEX idx_settings_data_inizio ON public.settings USING btree (data_inizio);

CREATE INDEX idx_settings_id_roles ON public.settings USING btree (id_roles);

CREATE INDEX idx_settings_scadenza ON public.settings USING btree (scadenza);

CREATE INDEX idx_settings_tenant_id ON public.settings USING btree (tenant_id);

CREATE INDEX idx_settings_tenant_user ON public.settings USING btree (tenant_id, user_id);

CREATE INDEX idx_settings_tipo_valore ON public.settings USING btree (tipo_valore);

CREATE INDEX idx_settings_user_id ON public.settings USING btree (user_id);

CREATE INDEX idx_stakeholders_project_id ON public.stakeholders USING btree (project_id);

CREATE INDEX idx_tipo_valore_id_roles ON public.tipo_valore USING btree (id_roles);

CREATE INDEX idx_user_roles_tenant_id ON public.user_roles USING btree (tenant_id);

CREATE INDEX idx_user_roles_user_id ON public.user_roles USING btree (user_id);

CREATE INDEX idx_user_tenants_tenant_id ON public.user_tenants USING btree (tenant_id);

CREATE INDEX idx_user_tenants_user_id ON public.user_tenants USING btree (user_id);

CREATE UNIQUE INDEX lookup_values_pkey ON public.lookup_values USING btree (id);

CREATE UNIQUE INDEX meetings_pkey ON public.meetings USING btree (id);

CREATE UNIQUE INDEX proj_anno_fatt_pkey ON public.proj_anno_fatt USING btree (id);

CREATE UNIQUE INDEX proj_componenti_pkey ON public.proj_componenti USING btree (id);

CREATE UNIQUE INDEX proj_worker_cost_pkey ON public.proj_worker_cost USING btree (id);

CREATE UNIQUE INDEX proj_worker_pkey ON public.proj_worker USING btree (id);

CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id);

CREATE UNIQUE INDEX risks_pkey ON public.risks USING btree (id);

CREATE UNIQUE INDEX roles_name_key ON public.roles USING btree (name);

CREATE UNIQUE INDEX roles_pkey ON public.roles USING btree (id);

CREATE UNIQUE INDEX set_label_pkey ON public.set_label USING btree (id);

CREATE UNIQUE INDEX set_var_layout_pkey ON public.set_var_layout USING btree (id);

CREATE UNIQUE INDEX settings_pkey ON public.settings USING btree (id);

CREATE UNIQUE INDEX stakeholders_pkey ON public.stakeholders USING btree (id);

CREATE UNIQUE INDEX table_structures_pkey ON public.table_structures USING btree (id);

CREATE UNIQUE INDEX table_structures_table_name_key ON public.table_structures USING btree (table_name);

CREATE UNIQUE INDEX tasks_pkey ON public.tasks USING btree (id);

CREATE UNIQUE INDEX tenants_name_key ON public.tenants USING btree (name);

CREATE UNIQUE INDEX tenants_pkey ON public.tenants USING btree (id);

CREATE UNIQUE INDEX tenants_slug_key ON public.tenants USING btree (slug);

CREATE UNIQUE INDEX tipo_valore_id_code_key ON public.tipo_valore USING btree (id_code);

CREATE UNIQUE INDEX tipo_valore_pkey ON public.tipo_valore USING btree (id);

CREATE UNIQUE INDEX unique_id_roles ON public.roles USING btree (id_roles);

CREATE UNIQUE INDEX uq_proj_worker_assignment ON public.proj_worker USING btree (tenant_id, user_id, client_id, project_id, worker_cost_id);

CREATE UNIQUE INDEX user_roles_pkey ON public.user_roles USING btree (id);

CREATE UNIQUE INDEX user_roles_user_id_role_id_tenant_id_key ON public.user_roles USING btree (user_id, role_id, tenant_id);

CREATE UNIQUE INDEX user_tenants_pkey ON public.user_tenants USING btree (id);

CREATE UNIQUE INDEX user_tenants_user_id_tenant_id_key ON public.user_tenants USING btree (user_id, tenant_id);

CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id);

-- ============================================================
-- FUNCTIONS
-- ============================================================
CREATE OR REPLACE FUNCTION auth.init()
 RETURNS void
 LANGUAGE c
 STRICT
AS '$libdir/pg_session_jwt', $function$init_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_session_jwt', $function$jwt_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.jwt_session_init(jwt text)
 RETURNS void
 LANGUAGE c
 STRICT
AS '$libdir/pg_session_jwt', $function$jwt_session_init_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.organization()
 RETURNS jsonb
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_session_jwt', $function$organization_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.organization_id()
 RETURNS uuid
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_session_jwt', $function$organization_id_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.session()
 RETURNS jsonb
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_session_jwt', $function$session_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_session_jwt', $function$uid_wrapper$function$;

CREATE OR REPLACE FUNCTION auth.user_id()
 RETURNS text
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_session_jwt', $function$user_id_wrapper$function$;

CREATE OR REPLACE FUNCTION public.contacts_calc_eta()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.eta := CASE
    WHEN NEW.data_nascita IS NULL THEN NULL
    ELSE EXTRACT(YEAR FROM AGE(CURRENT_DATE, NEW.data_nascita))::int
  END;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.seed_settings_new_user_tenant()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO settings (tenant_id, user_id, argument, campo, tipo_valore,
                        id_roles, ordinamento, tabella, colonna, layout_col)
  SELECT DISTINCT NEW.tenant_id, NEW.user_id, s.argument, s.campo, s.tipo_valore,
         s.id_roles, s.ordinamento, s.tabella, s.colonna, s.layout_col
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
$function$;

-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW "public"."ele_clienti" AS
SELECT tenant_id,
    user_id,
    id AS client_id,
    valore2 AS description
   FROM clients
  WHERE (((argument)::text = 'Cliente'::text) AND ((campo)::text = 'Cliente'::text));;

CREATE OR REPLACE VIEW "public"."ele_progetti" AS
SELECT tenant_id,
    user_id,
    client_id,
    id AS project_id,
    valore2 AS description
   FROM projects
  WHERE (((argument)::text = 'Progetto'::text) AND ((campo)::text = 'Progetto'::text));;

CREATE OR REPLACE VIEW "public"."kpi_fatturazione" AS
SELECT tenant_id,
    client_id,
    user_id,
    anno,
    sum(
        CASE
            WHEN ((anno)::numeric < EXTRACT(year FROM CURRENT_DATE)) THEN (((((((((((COALESCE(gennaio, (0)::numeric) + COALESCE(febbraio, (0)::numeric)) + COALESCE(marzo, (0)::numeric)) + COALESCE(aprile, (0)::numeric)) + COALESCE(maggio, (0)::numeric)) + COALESCE(giugno, (0)::numeric)) + COALESCE(luglio, (0)::numeric)) + COALESCE(agosto, (0)::numeric)) + COALESCE(settembre, (0)::numeric)) + COALESCE(ottobre, (0)::numeric)) + COALESCE(novembre, (0)::numeric)) + COALESCE(dicembre, (0)::numeric))
            WHEN ((anno)::numeric = EXTRACT(year FROM CURRENT_DATE)) THEN (((((((((((COALESCE(gennaio, (0)::numeric) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (2)::numeric) THEN COALESCE(febbraio, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (3)::numeric) THEN COALESCE(marzo, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (4)::numeric) THEN COALESCE(aprile, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (5)::numeric) THEN COALESCE(maggio, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (6)::numeric) THEN COALESCE(giugno, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (7)::numeric) THEN COALESCE(luglio, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (8)::numeric) THEN COALESCE(agosto, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (9)::numeric) THEN COALESCE(settembre, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (10)::numeric) THEN COALESCE(ottobre, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (11)::numeric) THEN COALESCE(novembre, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) >= (12)::numeric) THEN COALESCE(dicembre, (0)::numeric)
                ELSE (0)::numeric
            END)
            ELSE (0)::numeric
        END) AS totale,
    sum(
        CASE
            WHEN ((anno)::numeric = EXTRACT(year FROM CURRENT_DATE)) THEN (((((((((((
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (1)::numeric) THEN COALESCE(gennaio, (0)::numeric)
                ELSE (0)::numeric
            END +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (2)::numeric) THEN COALESCE(febbraio, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (3)::numeric) THEN COALESCE(marzo, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (4)::numeric) THEN COALESCE(aprile, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (5)::numeric) THEN COALESCE(maggio, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (6)::numeric) THEN COALESCE(giugno, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (7)::numeric) THEN COALESCE(luglio, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (8)::numeric) THEN COALESCE(agosto, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (9)::numeric) THEN COALESCE(settembre, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (10)::numeric) THEN COALESCE(ottobre, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (11)::numeric) THEN COALESCE(novembre, (0)::numeric)
                ELSE (0)::numeric
            END) +
            CASE
                WHEN (EXTRACT(month FROM CURRENT_DATE) < (12)::numeric) THEN COALESCE(dicembre, (0)::numeric)
                ELSE (0)::numeric
            END)
            ELSE (0)::numeric
        END) AS forecast
   FROM proj_anno_fatt
  GROUP BY tenant_id, client_id, user_id, anno
  ORDER BY anno;;
  
   create OR REPLACE view invoice as
select a.tenant_id,a.user_id, a.client_id,a.project_id,b.cod_billing ,
 sum( offerta_hh) as offerta_hh,	sum(offerta_gg) as offerta_gg , sum(cost_time_spent_hh) as consuntivo_hh,	sum(cost_time_spent_gg) as consuntivo_gg
  from proj_worker a, proj_worker_cost b
  where a.client_id=b.client_id and a.worker_cost_id=b.id
    group by a.tenant_id,a.user_id, a.client_id,a.project_id,b.cod_billing 
  
  

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE TRIGGER trg_contacts_eta BEFORE INSERT OR UPDATE OF data_nascita ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_calc_eta();

CREATE TRIGGER trg_seed_settings_new_user_tenant AFTER INSERT ON user_tenants FOR EACH ROW EXECUTE FUNCTION seed_settings_new_user_tenant();

-- ============================================================
-- TABLE GRANTS
-- ============================================================
GRANT DELETE ON TABLE "public"."activity_log" TO "anonymous";
GRANT INSERT ON TABLE "public"."activity_log" TO "anonymous";
GRANT SELECT ON TABLE "public"."activity_log" TO "anonymous";
GRANT UPDATE ON TABLE "public"."activity_log" TO "anonymous";

GRANT DELETE ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."activity_log" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."activity_logs" TO "anonymous";
GRANT INSERT ON TABLE "public"."activity_logs" TO "anonymous";
GRANT SELECT ON TABLE "public"."activity_logs" TO "anonymous";
GRANT UPDATE ON TABLE "public"."activity_logs" TO "anonymous";

GRANT DELETE ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."activity_logs" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."client_shares" TO "anonymous";
GRANT INSERT ON TABLE "public"."client_shares" TO "anonymous";
GRANT SELECT ON TABLE "public"."client_shares" TO "anonymous";
GRANT UPDATE ON TABLE "public"."client_shares" TO "anonymous";

GRANT DELETE ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."client_shares" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."clients" TO "anonymous";
GRANT INSERT ON TABLE "public"."clients" TO "anonymous";
GRANT SELECT ON TABLE "public"."clients" TO "anonymous";
GRANT UPDATE ON TABLE "public"."clients" TO "anonymous";

GRANT DELETE ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."clients" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."contacts" TO "anonymous";
GRANT INSERT ON TABLE "public"."contacts" TO "anonymous";
GRANT SELECT ON TABLE "public"."contacts" TO "anonymous";
GRANT UPDATE ON TABLE "public"."contacts" TO "anonymous";

GRANT DELETE ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."contacts" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."documents" TO "anonymous";
GRANT INSERT ON TABLE "public"."documents" TO "anonymous";
GRANT SELECT ON TABLE "public"."documents" TO "anonymous";
GRANT UPDATE ON TABLE "public"."documents" TO "anonymous";

GRANT DELETE ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."documents" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."ele_clienti" TO "anonymous";
GRANT INSERT ON TABLE "public"."ele_clienti" TO "anonymous";
GRANT SELECT ON TABLE "public"."ele_clienti" TO "anonymous";
GRANT UPDATE ON TABLE "public"."ele_clienti" TO "anonymous";

GRANT DELETE ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."ele_clienti" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."ele_progetti" TO "anonymous";
GRANT INSERT ON TABLE "public"."ele_progetti" TO "anonymous";
GRANT SELECT ON TABLE "public"."ele_progetti" TO "anonymous";
GRANT UPDATE ON TABLE "public"."ele_progetti" TO "anonymous";

GRANT DELETE ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."ele_progetti" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."email_recaps" TO "anonymous";
GRANT INSERT ON TABLE "public"."email_recaps" TO "anonymous";
GRANT SELECT ON TABLE "public"."email_recaps" TO "anonymous";
GRANT UPDATE ON TABLE "public"."email_recaps" TO "anonymous";

GRANT DELETE ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."email_recaps" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."function_db" TO "anonymous";
GRANT INSERT ON TABLE "public"."function_db" TO "anonymous";
GRANT SELECT ON TABLE "public"."function_db" TO "anonymous";
GRANT UPDATE ON TABLE "public"."function_db" TO "anonymous";

GRANT DELETE ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."function_db" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."kpi_fatturazione" TO "anonymous";
GRANT INSERT ON TABLE "public"."kpi_fatturazione" TO "anonymous";
GRANT SELECT ON TABLE "public"."kpi_fatturazione" TO "anonymous";
GRANT UPDATE ON TABLE "public"."kpi_fatturazione" TO "anonymous";

GRANT DELETE ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."kpi_fatturazione" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."lookup_values" TO "anonymous";
GRANT INSERT ON TABLE "public"."lookup_values" TO "anonymous";
GRANT SELECT ON TABLE "public"."lookup_values" TO "anonymous";
GRANT UPDATE ON TABLE "public"."lookup_values" TO "anonymous";

GRANT DELETE ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."lookup_values" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."meetings" TO "anonymous";
GRANT INSERT ON TABLE "public"."meetings" TO "anonymous";
GRANT SELECT ON TABLE "public"."meetings" TO "anonymous";
GRANT UPDATE ON TABLE "public"."meetings" TO "anonymous";

GRANT DELETE ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."meetings" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."proj_anno_fatt" TO "anonymous";
GRANT INSERT ON TABLE "public"."proj_anno_fatt" TO "anonymous";
GRANT SELECT ON TABLE "public"."proj_anno_fatt" TO "anonymous";
GRANT UPDATE ON TABLE "public"."proj_anno_fatt" TO "anonymous";

GRANT DELETE ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."proj_anno_fatt" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."proj_componenti" TO "anonymous";
GRANT INSERT ON TABLE "public"."proj_componenti" TO "anonymous";
GRANT SELECT ON TABLE "public"."proj_componenti" TO "anonymous";
GRANT UPDATE ON TABLE "public"."proj_componenti" TO "anonymous";

GRANT DELETE ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."proj_componenti" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."proj_worker" TO "anonymous";
GRANT INSERT ON TABLE "public"."proj_worker" TO "anonymous";
GRANT SELECT ON TABLE "public"."proj_worker" TO "anonymous";
GRANT UPDATE ON TABLE "public"."proj_worker" TO "anonymous";

GRANT DELETE ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."proj_worker" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."proj_worker_cost" TO "anonymous";
GRANT INSERT ON TABLE "public"."proj_worker_cost" TO "anonymous";
GRANT SELECT ON TABLE "public"."proj_worker_cost" TO "anonymous";
GRANT UPDATE ON TABLE "public"."proj_worker_cost" TO "anonymous";

GRANT DELETE ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."proj_worker_cost" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."projects" TO "anonymous";
GRANT INSERT ON TABLE "public"."projects" TO "anonymous";
GRANT SELECT ON TABLE "public"."projects" TO "anonymous";
GRANT UPDATE ON TABLE "public"."projects" TO "anonymous";

GRANT DELETE ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."projects" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."risks" TO "anonymous";
GRANT INSERT ON TABLE "public"."risks" TO "anonymous";
GRANT SELECT ON TABLE "public"."risks" TO "anonymous";
GRANT UPDATE ON TABLE "public"."risks" TO "anonymous";

GRANT DELETE ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."risks" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."roles" TO "anonymous";
GRANT INSERT ON TABLE "public"."roles" TO "anonymous";
GRANT SELECT ON TABLE "public"."roles" TO "anonymous";
GRANT UPDATE ON TABLE "public"."roles" TO "anonymous";

GRANT DELETE ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."roles" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."set_label" TO "anonymous";
GRANT INSERT ON TABLE "public"."set_label" TO "anonymous";
GRANT SELECT ON TABLE "public"."set_label" TO "anonymous";
GRANT UPDATE ON TABLE "public"."set_label" TO "anonymous";

GRANT DELETE ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."set_label" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."set_var_layout" TO "anonymous";
GRANT INSERT ON TABLE "public"."set_var_layout" TO "anonymous";
GRANT SELECT ON TABLE "public"."set_var_layout" TO "anonymous";
GRANT UPDATE ON TABLE "public"."set_var_layout" TO "anonymous";

GRANT DELETE ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."set_var_layout" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."settings" TO "anonymous";
GRANT INSERT ON TABLE "public"."settings" TO "anonymous";
GRANT SELECT ON TABLE "public"."settings" TO "anonymous";
GRANT UPDATE ON TABLE "public"."settings" TO "anonymous";

GRANT DELETE ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."settings" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."stakeholders" TO "anonymous";
GRANT INSERT ON TABLE "public"."stakeholders" TO "anonymous";
GRANT SELECT ON TABLE "public"."stakeholders" TO "anonymous";
GRANT UPDATE ON TABLE "public"."stakeholders" TO "anonymous";

GRANT DELETE ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."stakeholders" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."table_structures" TO "anonymous";
GRANT INSERT ON TABLE "public"."table_structures" TO "anonymous";
GRANT SELECT ON TABLE "public"."table_structures" TO "anonymous";
GRANT UPDATE ON TABLE "public"."table_structures" TO "anonymous";

GRANT DELETE ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."table_structures" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."tasks" TO "anonymous";
GRANT INSERT ON TABLE "public"."tasks" TO "anonymous";
GRANT SELECT ON TABLE "public"."tasks" TO "anonymous";
GRANT UPDATE ON TABLE "public"."tasks" TO "anonymous";

GRANT DELETE ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."tasks" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."tenants" TO "anonymous";
GRANT INSERT ON TABLE "public"."tenants" TO "anonymous";
GRANT SELECT ON TABLE "public"."tenants" TO "anonymous";
GRANT UPDATE ON TABLE "public"."tenants" TO "anonymous";

GRANT DELETE ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."tenants" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."tipo_valore" TO "anonymous";
GRANT INSERT ON TABLE "public"."tipo_valore" TO "anonymous";
GRANT SELECT ON TABLE "public"."tipo_valore" TO "anonymous";
GRANT UPDATE ON TABLE "public"."tipo_valore" TO "anonymous";

GRANT DELETE ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."tipo_valore" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."user_roles" TO "anonymous";
GRANT INSERT ON TABLE "public"."user_roles" TO "anonymous";
GRANT SELECT ON TABLE "public"."user_roles" TO "anonymous";
GRANT UPDATE ON TABLE "public"."user_roles" TO "anonymous";

GRANT DELETE ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."user_roles" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."user_tenants" TO "anonymous";
GRANT INSERT ON TABLE "public"."user_tenants" TO "anonymous";
GRANT SELECT ON TABLE "public"."user_tenants" TO "anonymous";
GRANT UPDATE ON TABLE "public"."user_tenants" TO "anonymous";

GRANT DELETE ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."user_tenants" TO "neondb_owner" WITH GRANT OPTION;

GRANT DELETE ON TABLE "public"."users" TO "anonymous";
GRANT INSERT ON TABLE "public"."users" TO "anonymous";
GRANT SELECT ON TABLE "public"."users" TO "anonymous";
GRANT UPDATE ON TABLE "public"."users" TO "anonymous";

GRANT DELETE ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;
GRANT INSERT ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;
GRANT REFERENCES ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRIGGER ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;
GRANT TRUNCATE ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;
GRANT UPDATE ON TABLE "public"."users" TO "neondb_owner" WITH GRANT OPTION;

-- ============================================================
-- END OF RECONSTRUCTION SCRIPT
-- ============================================================
COMMIT;
