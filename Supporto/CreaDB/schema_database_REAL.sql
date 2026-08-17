-- ==========================================
-- PROJEXA v1.0.0 - DATABASE SCHEMA (REAL)
-- PostgreSQL on Neon
-- ==========================================
-- This file documents the ACTUAL database structure
-- Last Updated: 2026-08-07
-- Do NOT insert test data here - this is schema only
-- ==========================================

-- ==========================================
-- 1. TENANTS TABLE
-- ==========================================
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2. ROLES TABLE
-- ==========================================
CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  id_roles SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reference: id_roles values
-- Admin = 1
-- Super User = 2
-- Project Manager = 3
-- Team Member = 4
-- Viewer = 5

-- ==========================================
-- 3. USERS TABLE
-- ==========================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  cognome VARCHAR(255),
  scadenza DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 4. USER_TENANTS TABLE (User-Tenant Relationships)
-- ==========================================
CREATE TABLE user_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  role_id VARCHAR(255) DEFAULT 'member'::character varying,
  id_roles SMALLINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (id_roles) REFERENCES roles(id_roles)
);

-- ==========================================
-- 5. USER_ROLES TABLE
-- ==========================================
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role_id UUID NOT NULL,
  tenant_id UUID,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- ==========================================
-- 6. TABLE_STRUCTURES TABLE (Dynamic Table Metadata)
-- ==========================================
CREATE TABLE table_structures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 7. PROJECTS TABLE
-- ==========================================
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(255) DEFAULT 'active'::character varying,
  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ==========================================
-- 8. TASKS TABLE
-- ==========================================
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(255) DEFAULT 'todo'::character varying,
  priority VARCHAR(255) DEFAULT 'medium'::character varying,
  assigned_to UUID,
  due_date DATE,
  tenant_id UUID,
  client_id UUID,
  link_meet TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ==========================================
-- 9. DOCUMENTS TABLE
-- ==========================================
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  file_url VARCHAR(255),
  file_type VARCHAR(255),
  uploaded_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

-- ==========================================
-- 10. MEETINGS TABLE
-- ==========================================
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  meeting_date TIMESTAMP,
  location VARCHAR(255),
  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ==========================================
-- 11. RISKS TABLE
-- ==========================================
CREATE TABLE risks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  probability VARCHAR(255),
  impact VARCHAR(255),
  status VARCHAR(255) DEFAULT 'open'::character varying,
  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ==========================================
-- 12. STAKEHOLDERS TABLE
-- ==========================================
CREATE TABLE stakeholders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(255),
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- ==========================================
-- 13. ACTIVITY_LOGS TABLE (UUID version - newer)
-- ==========================================
CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  action VARCHAR(255),
  resource_type VARCHAR(255),
  resource_id UUID,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ==========================================
-- 14. ACTIVITY_LOG TABLE (INT version - legacy)
-- ==========================================
-- NOTE: This appears to be legacy. Consider consolidating with activity_logs
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 15. EMAIL_RECAPS TABLE
-- ==========================================
CREATE TABLE email_recaps (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent BOOLEAN DEFAULT false,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- FOREIGN KEY RELATIONSHIPS
-- ==========================================
-- activity_logs → users (user_id)
-- activity_logs → tenants (tenant_id)
-- documents → projects (project_id)
-- documents → users (uploaded_by)
-- meetings → projects (project_id)
-- meetings → users (created_by)
-- projects → tenants (tenant_id)
-- projects → users (created_by)
-- risks → projects (project_id)
-- risks → users (created_by)
-- stakeholders → projects (project_id)
-- tasks → projects (project_id)
-- tasks → tenants (tenant_id)
-- tasks → users (assigned_to, created_by)
-- user_roles → users (user_id)
-- user_roles → roles (role_id)
-- user_roles → tenants (tenant_id)
-- user_tenants → users (user_id)
-- user_tenants → tenants (tenant_id)
-- user_tenants → roles (id_roles)
-- settings → tenants (tenant_id)
-- settings → users (user_id)
-- settings → roles (id_roles)
-- clients → tenants (tenant_id)
-- clients → users (user_id)
-- clients → roles (id_roles)

-- ==========================================
-- SETTINGS TABLE
-- ==========================================
-- Nomi in snake_case minuscolo: non serve citarli tra apici nelle query.
-- tenant_id abilita l'isolamento automatico per tenant degli endpoint /api/data.
CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,          -- FK -> tenants.id
  user_id UUID NOT NULL,            -- FK -> users.id
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (id_roles) REFERENCES roles(id_roles)
);

-- ==========================================
-- CLIENTS TABLE (stessa struttura e nomi di settings)
-- ==========================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,          -- FK -> tenants.id
  user_id UUID NOT NULL,            -- FK -> users.id
  argument VARCHAR(255),
  campo VARCHAR(255),
  valore1 BOOLEAN,
  valore2 VARCHAR(255),
  valore3 INTEGER,
  tabella VARCHAR(255),
  colonna VARCHAR(255),
  tipo_valore VARCHAR(255),
  id_roles SMALLINT,                -- FK -> roles.id_roles
  data_inizio DATE,
  scadenza DATE,
  ordinamento INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (id_roles) REFERENCES roles(id_roles)
);

-- ==========================================
-- INDEXES
-- ==========================================
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_scadenza ON users(scadenza);
CREATE INDEX idx_user_tenants_user_id ON user_tenants(user_id);
CREATE INDEX idx_user_tenants_tenant_id ON user_tenants(tenant_id);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_tenant_id ON user_roles(tenant_id);
CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_tasks_tenant_id ON tasks(tenant_id);
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX idx_documents_project_id ON documents(project_id);
CREATE INDEX idx_meetings_project_id ON meetings(project_id);
CREATE INDEX idx_risks_project_id ON risks(project_id);
CREATE INDEX idx_stakeholders_project_id ON stakeholders(project_id);
CREATE INDEX idx_activity_logs_tenant_id ON activity_logs(tenant_id);
CREATE INDEX idx_table_structures_active ON table_structures(is_active);
CREATE INDEX idx_settings_tenant_id ON settings(tenant_id);
CREATE INDEX idx_settings_user_id ON settings(user_id);
CREATE INDEX idx_settings_tenant_user ON settings(tenant_id, user_id);
CREATE INDEX idx_settings_data_inizio ON settings(data_inizio);
CREATE INDEX idx_settings_scadenza ON settings(scadenza);
CREATE INDEX idx_settings_id_roles ON settings(id_roles);
CREATE INDEX idx_clients_tenant_id ON clients(tenant_id);
CREATE INDEX idx_clients_user_id ON clients(user_id);
CREATE INDEX idx_clients_tenant_user ON clients(tenant_id, user_id);
CREATE INDEX idx_clients_data_inizio ON clients(data_inizio);
CREATE INDEX idx_clients_scadenza ON clients(scadenza);
CREATE INDEX idx_clients_id_roles ON clients(id_roles);

-- ==========================================
-- ARCHITECTURE NOTES
-- ==========================================
-- Multi-tenant design:
--   - tenants: root organization
--   - projects: tenant-specific projects
--   - tasks: project tasks with tenant_id
--   - user_tenants: user membership in tenants with roles
--
-- Role management:
--   - roles: system roles with id_roles scale (1-5)
--   - user_roles: explicit role assignments
--   - user_tenants.id_roles: FK to roles.id_roles
--
-- Audit trails:
--   - activity_logs: new UUID-based activity tracking
--   - activity_log: legacy INT-based (consider deprecating)
--
-- Legacy tables (INT-based IDs):
--   - activity_log (should migrate to activity_logs)
--   - email_recaps (should migrate to UUID)
--
-- ==========================================
-- VERIFICATION QUERIES
-- ==========================================
-- All tables: SELECT * FROM information_schema.tables WHERE table_schema = 'public';
-- All columns: SELECT * FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name;
-- All constraints: SELECT * FROM information_schema.table_constraints WHERE table_schema = 'public';
