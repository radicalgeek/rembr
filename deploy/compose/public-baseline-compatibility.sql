-- Public self-host compatibility prelude.
--
-- The original OSS schema predates four tables that later MCP/auth migrations
-- assume already exist. Create their current public baseline definitions before
-- applying the numbered migrations. Fresh installs already have these objects,
-- so every statement is deliberately idempotent.

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(100) NOT NULL,
  user_identifier VARCHAR(255),
  provider VARCHAR(50),
  success BOOLEAN NOT NULL DEFAULT true,
  ip_address VARCHAR(45),
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id UUID,
  user_id UUID,
  api_key_id UUID,
  agent_id TEXT,
  event_type TEXT,
  resource_type TEXT,
  resource_id UUID,
  action_result TEXT CHECK (action_result IN ('success', 'failure', 'denied')),
  error_message TEXT,
  payload_before JSONB,
  payload_after JSONB,
  query_parameters JSONB,
  session_id TEXT,
  request_id TEXT,
  seq_num BIGSERIAL,
  tenant_seq_num BIGINT,
  entry_hash TEXT,
  prev_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_logs(type);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_identifier ON audit_logs(user_identifier);
CREATE INDEX IF NOT EXISTS idx_audit_log_provider ON audit_logs(provider);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_success ON audit_logs(success);

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  added_by UUID NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_role ON project_members(role);

CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  invited_by UUID NOT NULL REFERENCES users(id),
  token VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invitations_tenant_id ON invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at);

CREATE TABLE IF NOT EXISTS email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID,
  template VARCHAR(50) NOT NULL,
  resend_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'sent',
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_sends_tenant ON email_sends(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_template ON email_sends(template);
CREATE INDEX IF NOT EXISTS idx_email_sends_sent_at ON email_sends(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_tenant_template
  ON email_sends(tenant_id, template);
