-- Runtime defaults and indexes for the first automated Retell/Apollo slice.
-- This migration is additive and keeps the legacy agent-config fields intact.

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS retell_phone_country TEXT NOT NULL DEFAULT 'US';

ALTER TABLE public.agent_configs
  DROP CONSTRAINT IF EXISTS agent_configs_retell_phone_country_check;

ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_retell_phone_country_check
  CHECK (retell_phone_country IN ('US', 'CA'));

CREATE INDEX IF NOT EXISTS apollo_webhook_events_lead_idx
  ON public.apollo_webhook_events (lead_id, received_at DESC)
  WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS apollo_webhook_events_account_idx
  ON public.apollo_webhook_events (account_id, received_at DESC)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS apollo_webhook_events_run_idx
  ON public.apollo_webhook_events (enrichment_run_id, received_at DESC)
  WHERE enrichment_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_snapshots_org_channel_idx
  ON public.lead_context_snapshots (organization_id, channel, status, created_at DESC);

CREATE INDEX IF NOT EXISTS retell_phone_numbers_agent_config_idx
  ON public.retell_phone_numbers (agent_config_id)
  WHERE agent_config_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS meetings_account_idx
  ON public.meetings (account_id)
  WHERE account_id IS NOT NULL;

-- These functions are called only by the service-role backend after it has
-- verified the provider signature. Explicitly remove the default PUBLIC
-- execute privilege from both anon and authenticated roles as well.
REVOKE ALL ON FUNCTION public.finalize_billing_charge(UUID, UUID, TEXT, TEXT)
  FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.apply_razorpay_subscription_event(
  TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ,
  TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, JSONB
) FROM anon, authenticated;
