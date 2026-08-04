-- Globonexo Sales AI foundation
-- Adds durable Apollo, context, Retell phone, Calendar, and idempotency
-- records without removing legacy fields or changing existing customer data.

CREATE TABLE IF NOT EXISTS public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  apollo_organization_id TEXT,
  apollo_account_id TEXT,
  name TEXT NOT NULL,
  domain TEXT,
  normalized_domain TEXT,
  website TEXT,
  linkedin_url TEXT,
  twitter_url TEXT,
  facebook_url TEXT,
  logo_url TEXT,
  industry TEXT,
  industries JSONB NOT NULL DEFAULT '[]'::jsonb,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  raw_address TEXT,
  street_address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  estimated_num_employees INTEGER,
  annual_revenue NUMERIC,
  annual_revenue_printed TEXT,
  total_funding NUMERIC,
  total_funding_printed TEXT,
  latest_funding_stage TEXT,
  funding_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  technology_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_technologies JSONB NOT NULL DEFAULT '[]'::jsonb,
  departmental_headcount JSONB NOT NULL DEFAULT '{}'::jsonb,
  headcount_growth_six_months NUMERIC,
  headcount_growth_twelve_months NUMERIC,
  headcount_growth_twenty_four_months NUMERIC,
  parent_apollo_organization_id TEXT,
  suborganizations JSONB NOT NULL DEFAULT '[]'::jsonb,
  intent_summary JSONB,
  source TEXT NOT NULL DEFAULT 'apollo'
    CHECK (source IN ('apollo', 'manual', 'csv', 'website')),
  enrichment_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (enrichment_status IN ('not_started', 'queued', 'running', 'completed', 'failed', 'stale')),
  enrichment_error TEXT,
  last_enriched_at TIMESTAMPTZ,
  next_refresh_at TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.apollo_enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES public.leads(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE,
  enrichment_kind TEXT NOT NULL
    CHECK (enrichment_kind IN (
      'people_search',
      'person_match',
      'organization_enrich',
      'organization_info',
      'phone_waterfall'
    )),
  idempotency_key TEXT NOT NULL,
  provider_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'awaiting_webhook', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  credit_cost NUMERIC,
  provider_status TEXT,
  error_code TEXT,
  error_message TEXT,
  webhook_expected BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_received_at TIMESTAMPTZ,
  raw_payload JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.apollo_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  enrichment_run_id UUID REFERENCES public.apollo_enrichment_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT
);

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS apollo_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS headline TEXT,
  ADD COLUMN IF NOT EXISTS department TEXT,
  ADD COLUMN IF NOT EXISTS job_function TEXT,
  ADD COLUMN IF NOT EXISTS seniority TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS email_status TEXT,
  ADD COLUMN IF NOT EXISTS email_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS employment_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dnc_status TEXT,
  ADD COLUMN IF NOT EXISTS email_unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS do_not_email BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS do_not_call BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS manual_field_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_apollo_enriched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS context_refreshed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'leads_account_id_fkey'
       AND conrelid = 'public.leads'::regclass
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_account_id_fkey
      FOREIGN KEY (account_id)
      REFERENCES public.accounts(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.lead_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'voice')),
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('draft', 'ready', 'expired', 'invalidated')),
  context_version INTEGER NOT NULL DEFAULT 1 CHECK (context_version > 0),
  snapshot_hash TEXT,
  customer_context_version TEXT,
  factual_summary TEXT,
  pain_hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,
  discovery_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  solution_angle TEXT,
  do_not_claim JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_snapshot_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS retell_conversation_flow_id TEXT,
  ADD COLUMN IF NOT EXISTS retell_knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retell_agent_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS retell_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_disclosure_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS recording_consent_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_language TEXT NOT NULL DEFAULT 'en-US',
  ADD COLUMN IF NOT EXISTS default_voice_id TEXT;

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS context_snapshot_id UUID;

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS context_snapshot_id UUID;

CREATE TABLE IF NOT EXISTS public.retell_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_config_id UUID REFERENCES public.agent_configs(id) ON DELETE SET NULL,
  provider_phone_id TEXT,
  phone_number TEXT,
  country TEXT NOT NULL CHECK (country IN ('US', 'CA')),
  number_type TEXT NOT NULL CHECK (number_type IN ('local', 'toll_free')),
  area_code TEXT,
  entitlement_kind TEXT NOT NULL CHECK (entitlement_kind IN ('included', 'addon')),
  entitlement_id TEXT,
  provisioning_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'provisioning', 'active', 'failed', 'released')),
  inbound_agent_id TEXT,
  outbound_agent_id TEXT,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provisioned_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google'
    CHECK (provider IN ('google')),
  provider_account_id TEXT,
  connected_email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_calendar_id TEXT,
  selected_calendar_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked', 'disconnected')),
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider)
);

CREATE TABLE IF NOT EXISTS public.integration_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  request_payload_hash TEXT,
  provider_resource_id TEXT,
  response_payload JSONB,
  error_code TEXT,
  error_message TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider, operation, idempotency_key)
);

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_calendar_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS conference_url TEXT,
  ADD COLUMN IF NOT EXISTS attendee_email TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS external_etag TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS context_snapshot_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'meetings_account_id_fkey'
       AND conrelid = 'public.meetings'::regclass
  ) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_account_id_fkey
      FOREIGN KEY (account_id)
      REFERENCES public.accounts(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'meetings_context_snapshot_id_fkey'
       AND conrelid = 'public.meetings'::regclass
  ) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_context_snapshot_id_fkey
      FOREIGN KEY (context_snapshot_id)
      REFERENCES public.lead_context_snapshots(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'email_messages_context_snapshot_id_fkey'
       AND conrelid = 'public.email_messages'::regclass
  ) THEN
    ALTER TABLE public.email_messages
      ADD CONSTRAINT email_messages_context_snapshot_id_fkey
      FOREIGN KEY (context_snapshot_id)
      REFERENCES public.lead_context_snapshots(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'calls_context_snapshot_id_fkey'
       AND conrelid = 'public.calls'::regclass
  ) THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_context_snapshot_id_fkey
      FOREIGN KEY (context_snapshot_id)
      REFERENCES public.lead_context_snapshots(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_source_check;
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_source_check
  CHECK (source IN ('booking_link', 'calendar', 'manual', 'call', 'email'));

ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('proposed', 'scheduled', 'completed', 'cancelled', 'rescheduled', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_apollo_organization_uidx
  ON public.accounts (organization_id, apollo_organization_id)
  WHERE apollo_organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_normalized_domain_uidx
  ON public.accounts (organization_id, normalized_domain)
  WHERE normalized_domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS accounts_organization_idx
  ON public.accounts (organization_id);

CREATE INDEX IF NOT EXISTS accounts_enrichment_refresh_idx
  ON public.accounts (organization_id, enrichment_status, next_refresh_at);

CREATE INDEX IF NOT EXISTS apollo_runs_org_status_idx
  ON public.apollo_enrichment_runs (organization_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS apollo_runs_lead_idx
  ON public.apollo_enrichment_runs (lead_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS apollo_runs_account_idx
  ON public.apollo_enrichment_runs (account_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS apollo_webhook_events_target_idx
  ON public.apollo_webhook_events (organization_id, received_at DESC);

CREATE INDEX IF NOT EXISTS leads_account_idx
  ON public.leads (account_id);

CREATE INDEX IF NOT EXISTS leads_org_apollo_person_idx
  ON public.leads (organization_id, apollo_id)
  WHERE apollo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_snapshots_lead_created_idx
  ON public.lead_context_snapshots (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS context_snapshots_campaign_channel_idx
  ON public.lead_context_snapshots (campaign_id, channel, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS retell_phone_numbers_provider_id_uidx
  ON public.retell_phone_numbers (provider_phone_id)
  WHERE provider_phone_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS retell_phone_numbers_number_uidx
  ON public.retell_phone_numbers (phone_number)
  WHERE phone_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS retell_phone_numbers_included_org_uidx
  ON public.retell_phone_numbers (organization_id)
  WHERE entitlement_kind = 'included'
    AND status IN ('requested', 'provisioning', 'active', 'failed');

CREATE INDEX IF NOT EXISTS retell_phone_numbers_org_status_idx
  ON public.retell_phone_numbers (organization_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS meetings_provider_event_uidx
  ON public.meetings (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS meetings_org_idempotency_uidx
  ON public.meetings (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS meetings_org_status_scheduled_idx
  ON public.meetings (organization_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS email_messages_context_idx
  ON public.email_messages (context_snapshot_id);

CREATE INDEX IF NOT EXISTS calls_context_idx
  ON public.calls (context_snapshot_id);

CREATE INDEX IF NOT EXISTS integration_idempotency_status_idx
  ON public.integration_idempotency_keys (organization_id, provider, operation, status);

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apollo_enrichment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apollo_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retell_phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_org_isolation ON public.accounts;
CREATE POLICY account_org_isolation ON public.accounts
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS apollo_run_org_isolation ON public.apollo_enrichment_runs;
CREATE POLICY apollo_run_org_isolation ON public.apollo_enrichment_runs
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS apollo_webhook_org_isolation ON public.apollo_webhook_events;
CREATE POLICY apollo_webhook_org_isolation ON public.apollo_webhook_events
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS context_snapshot_org_isolation ON public.lead_context_snapshots;
CREATE POLICY context_snapshot_org_isolation ON public.lead_context_snapshots
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS retell_phone_org_isolation ON public.retell_phone_numbers;
CREATE POLICY retell_phone_org_isolation ON public.retell_phone_numbers
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS calendar_connection_org_isolation ON public.calendar_connections;
CREATE POLICY calendar_connection_org_isolation ON public.calendar_connections
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS integration_idempotency_org_isolation ON public.integration_idempotency_keys;
CREATE POLICY integration_idempotency_org_isolation ON public.integration_idempotency_keys
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

REVOKE ALL ON TABLE public.apollo_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_idempotency_keys FROM PUBLIC;
GRANT ALL ON TABLE public.accounts TO service_role;
GRANT ALL ON TABLE public.apollo_enrichment_runs TO service_role;
GRANT ALL ON TABLE public.apollo_webhook_events TO service_role;
GRANT ALL ON TABLE public.lead_context_snapshots TO service_role;
GRANT ALL ON TABLE public.retell_phone_numbers TO service_role;
GRANT ALL ON TABLE public.calendar_connections TO service_role;
GRANT ALL ON TABLE public.integration_idempotency_keys TO service_role;
