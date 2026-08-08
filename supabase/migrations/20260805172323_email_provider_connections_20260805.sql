-- Email provider support for non-Gmail mailboxes.
-- Gmail rows remain in connected_accounts; SMTP rows use the same table with
-- encrypted SMTP/IMAP secrets stored in access_token/refresh_token.

ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;

ALTER TABLE email_replies
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;

-- Backfill the provider-neutral identifiers for existing Gmail data while
-- retaining the legacy Gmail columns for API compatibility.
UPDATE email_messages
SET provider_message_id = gmail_message_id,
    provider_thread_id = gmail_thread_id
WHERE provider_message_id IS NULL
  AND (gmail_message_id IS NOT NULL OR gmail_thread_id IS NOT NULL);

UPDATE email_replies
SET provider_message_id = gmail_message_id
WHERE provider_message_id IS NULL
  AND gmail_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_messages_provider_thread_idx
  ON email_messages (organization_id, provider_thread_id);

CREATE INDEX IF NOT EXISTS email_replies_provider_message_idx
  ON email_replies (organization_id, provider_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS email_replies_provider_message_unique_idx
  ON email_replies (organization_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_one_active_email_idx
  ON connected_accounts (organization_id)
  WHERE provider IN ('gmail', 'smtp') AND is_active = TRUE;
