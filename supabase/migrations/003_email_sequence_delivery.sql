ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS step_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE email_messages
  DROP CONSTRAINT IF EXISTS email_messages_status_check;

ALTER TABLE email_messages
  ADD CONSTRAINT email_messages_status_check
  CHECK (status IN ('queued','sent','failed','bounced','skipped'));

CREATE INDEX IF NOT EXISTS idx_email_messages_campaign_lead_step
  ON email_messages(campaign_id, lead_id, step_number);
