-- First-class inbound Retell calling. Inbound calls exist before Retell assigns
-- a call_id and may never identify a lead, so the call record itself is the
-- durable correlation and audit boundary.

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS inbound_retell_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS inbound_retell_llm_id TEXT,
  ADD COLUMN IF NOT EXISTS inbound_daily_minute_limit INTEGER,
  ADD COLUMN IF NOT EXISTS inbound_max_call_duration_seconds INTEGER NOT NULL DEFAULT 1200;

ALTER TABLE public.retell_phone_numbers
  ADD COLUMN IF NOT EXISTS inbound_webhook_url TEXT;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS outbound_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outbound_pause_reason TEXT,
  ADD COLUMN IF NOT EXISTS outbound_resume_at TIMESTAMPTZ;

ALTER TABLE public.calls
  ALTER COLUMN lead_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound',
  ADD COLUMN IF NOT EXISTS identity_status TEXT,
  ADD COLUMN IF NOT EXISTS identity_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dnc_at_call BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS substantive_conversation BOOLEAN,
  ADD COLUMN IF NOT EXISTS requested_no_future_contact BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS max_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_configs_inbound_daily_minute_limit_check'
      AND conrelid = 'public.agent_configs'::regclass
  ) THEN
    ALTER TABLE public.agent_configs
      ADD CONSTRAINT agent_configs_inbound_daily_minute_limit_check
      CHECK (inbound_daily_minute_limit IS NULL OR inbound_daily_minute_limit BETWEEN 1 AND 1440);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_configs_inbound_max_duration_check'
      AND conrelid = 'public.agent_configs'::regclass
  ) THEN
    ALTER TABLE public.agent_configs
      ADD CONSTRAINT agent_configs_inbound_max_duration_check
      CHECK (inbound_max_call_duration_seconds BETWEEN 60 AND 1200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calls_direction_check'
      AND conrelid = 'public.calls'::regclass
  ) THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_direction_check
      CHECK (direction IN ('inbound', 'outbound'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calls_identity_status_check'
      AND conrelid = 'public.calls'::regclass
  ) THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_identity_status_check
      CHECK (identity_status IS NULL OR identity_status IN (
        'phone_match', 'tool_match', 'unknown', 'created_inbound', 'mismatch'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calls_duration_seconds_check'
      AND conrelid = 'public.calls'::regclass
  ) THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_duration_seconds_check
      CHECK (duration_seconds IS NULL OR duration_seconds >= 0);
  END IF;
END
$$;

-- Replace the original closed enums with their inbound-aware forms.
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE public.calls
  ADD CONSTRAINT calls_status_check
  CHECK (status IN ('queued', 'in_progress', 'completed', 'failed', 'voicemail', 'rejected'));

ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_disposition_check;
ALTER TABLE public.calls
  ADD CONSTRAINT calls_disposition_check
  CHECK (disposition IS NULL OR disposition IN (
    'interested', 'not_interested', 'meeting_booked', 'voicemail', 'callback',
    'no_answer', 'message_taken', 'no_connect', 'wrong_person', 'technical_failure'
  ));

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_source_check
  CHECK (source IN ('apollo', 'csv', 'manual', 'inbound'));

CREATE INDEX IF NOT EXISTS calls_org_direction_started_idx
  ON public.calls (organization_id, direction, started_at DESC)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS calls_org_inbound_caller_idx
  ON public.calls (organization_id, from_number, created_at DESC)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS calls_inbound_lead_idx
  ON public.calls (lead_id, created_at DESC)
  WHERE direction = 'inbound' AND lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_org_outbound_pause_idx
  ON public.leads (organization_id, outbound_resume_at)
  WHERE outbound_paused_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_org_phone_last10_idx
  ON public.leads (
    organization_id,
    right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
  )
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_phone_numbers_gin_idx
  ON public.leads USING GIN (phone_numbers jsonb_path_ops);

-- Ranked reverse lookup: exact stored phone, normalized/last-10 primary phone,
-- then Apollo phone_numbers variants. Return up to two rows so callers can
-- treat duplicate matches as ambiguous rather than guessing.
CREATE OR REPLACE FUNCTION public.find_inbound_leads_by_phone(
  p_organization_id UUID,
  p_e164 TEXT,
  p_last10 TEXT
)
RETURNS TABLE (
  id UUID,
  campaign_id UUID,
  first_name TEXT,
  last_name TEXT,
  name TEXT,
  title TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  account_id UUID,
  headline TEXT,
  department TEXT,
  job_function TEXT,
  seniority TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  dnc_status TEXT,
  do_not_call BOOLEAN,
  last_apollo_enriched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  match_rank INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      l.*,
      CASE
        WHEN l.phone = p_e164 THEN 1
        WHEN right(regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g'), 10) = p_last10 THEN 2
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(l.phone_numbers) = 'array' THEN l.phone_numbers
              ELSE '[]'::jsonb
            END
          ) AS item(value)
          WHERE right(
            regexp_replace(
              coalesce(
                item.value->>'sanitized_number',
                item.value->>'raw_number',
                item.value->>'number',
                CASE WHEN jsonb_typeof(item.value) = 'string' THEN trim(both '"' from item.value::text) END,
                ''
              ),
              '[^0-9]', '', 'g'
            ),
            10
          ) = p_last10
        ) THEN 3
        ELSE NULL
      END AS phone_match_rank
    FROM public.leads l
    WHERE l.organization_id = p_organization_id
  )
  SELECT
    ranked.id, ranked.campaign_id, ranked.first_name, ranked.last_name,
    ranked.name, ranked.title, ranked.company, ranked.email, ranked.phone,
    ranked.account_id, ranked.headline, ranked.department,
    ranked.job_function, ranked.seniority, ranked.city, ranked.state,
    ranked.country, ranked.dnc_status, ranked.do_not_call,
    ranked.last_apollo_enriched_at, ranked.updated_at, ranked.created_at,
    ranked.phone_match_rank
  FROM ranked
  WHERE ranked.phone_match_rank IS NOT NULL
  ORDER BY ranked.phone_match_rank, ranked.updated_at DESC NULLS LAST
  LIMIT 2;
$$;

CREATE OR REPLACE FUNCTION public.find_inbound_leads_by_identity(
  p_organization_id UUID,
  p_name TEXT,
  p_company TEXT
)
RETURNS TABLE (
  id UUID,
  campaign_id UUID,
  first_name TEXT,
  last_name TEXT,
  name TEXT,
  title TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  dnc_status TEXT,
  do_not_call BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id, l.campaign_id, l.first_name, l.last_name, l.name, l.title,
    l.company, l.email, l.phone, l.dnc_status, l.do_not_call
  FROM public.leads l
  WHERE l.organization_id = p_organization_id
    AND regexp_replace(lower(coalesce(l.name, concat_ws(' ', l.first_name, l.last_name))), '[^a-z0-9]', '', 'g')
        = regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]', '', 'g')
    AND regexp_replace(lower(coalesce(l.company, '')), '[^a-z0-9]', '', 'g')
        = regexp_replace(lower(coalesce(p_company, '')), '[^a-z0-9]', '', 'g')
  ORDER BY l.updated_at DESC NULLS LAST
  LIMIT 2;
$$;

REVOKE ALL ON FUNCTION public.find_inbound_leads_by_phone(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.find_inbound_leads_by_identity(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_inbound_leads_by_phone(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.find_inbound_leads_by_identity(UUID, TEXT, TEXT) TO service_role;
