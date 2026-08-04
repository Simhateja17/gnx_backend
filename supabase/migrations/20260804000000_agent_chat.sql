-- Server-side persistence for the AI agent chat, replacing browser-only localStorage.
CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','agent')),
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','stats','draft_review')),
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_org_created
  ON agent_messages(organization_id, created_at);

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_messages_org_isolation ON agent_messages
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

-- Lets the agent hold an early-generated follow-up for human review before it
-- sends, instead of auto-sending or reusing the 'queued' status (which the
-- send-email job would pick up immediately).
ALTER TABLE email_messages
  DROP CONSTRAINT IF EXISTS email_messages_status_check;

ALTER TABLE email_messages
  ADD CONSTRAINT email_messages_status_check
  CHECK (status IN ('queued','sent','failed','bounced','skipped','pending_review'));
