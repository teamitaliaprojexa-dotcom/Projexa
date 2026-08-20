-- =====================================================================
-- CLIENT_SHARES — Condivisione "viva" (ACL) di un cliente tra utenti dello stesso tenant.
-- ---------------------------------------------------------------------
-- Il cliente resta UNA sola copia fisica in "clients" (di proprietà del creatore).
-- Ogni riga qui concede a shared_with_user_id l'accesso al cliente client_id, con
-- permesso 'read' o 'write'. La revoca = eliminazione della riga.
-- client_id = id della riga identità del cliente (argument='Cliente', campo='Cliente').
-- =====================================================================
CREATE TABLE IF NOT EXISTS client_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,               -- riga identità del cliente
  shared_with_user_id UUID NOT NULL,     -- destinatario della condivisione
  owner_user_id UUID NOT NULL,           -- proprietario del cliente
  permission VARCHAR(10) NOT NULL DEFAULT 'write',  -- 'read' | 'write'
  created_by UUID,                       -- chi ha creato questa condivisione
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, shared_with_user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (shared_with_user_id) REFERENCES users(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_client_shares_user ON client_shares (shared_with_user_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_client_shares_client ON client_shares (client_id);
