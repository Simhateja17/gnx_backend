-- Allow a campaign to run email and voice at the same time.
-- Existing 'email' / 'voice' rows stay valid; 'both' means the campaign
-- queues an email sequence AND outbound calls when it is launched.

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_channel_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_channel_check
  CHECK (channel IN ('email', 'voice', 'both'));
