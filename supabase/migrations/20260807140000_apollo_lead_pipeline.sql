-- Apollo lead pipeline: import runs, qualification, context scoring, and the
-- draft -> approved -> queued -> sent message lifecycle.
--
-- Two records answer two different questions and both are kept:
--   lead_import_runs      - "how is this import going" (orchestration state)
--   apollo_enrichment_runs - "what did we ask Apollo and what did it cost"
--
-- A lead's *lifecycle* stays in leads.status. Its *eligibility* is separate
-- (qualification_status), because a lead can be perfectly alive in the CRM
-- sense while being permanently ineligible to email.

-- ---------------------------------------------------------------------------
-- Import runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lead_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'apollo' CHECK (source IN ('apollo', 'csv', 'manual')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'searching',
      'candidates_found',
      'enriching',
      'waiting_for_enrichment',
      'completed',
      'partial',
      'timed_out',
      'failed'
    )),

  -- A snapshot of the criteria this run used, so later ICP edits never
  -- retroactively change what an existing run claims it searched for.
  search_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,

  requested_limit INTEGER NOT NULL DEFAULT 10 CHECK (requested_limit > 0),
  candidate_cap INTEGER NOT NULL DEFAULT 100 CHECK (candidate_cap > 0),

  candidates_found INTEGER NOT NULL DEFAULT 0,
  candidates_attempted INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  pages_searched INTEGER NOT NULL DEFAULT 0,

  -- Average context score across qualified leads. A whole import scoring low
  -- is an ICP problem, not a lead problem, and this is what surfaces that.
  average_context_score NUMERIC,

  deadline_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error TEXT,
  progress_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_import_runs_org_status_idx
  ON public.lead_import_runs (organization_id, status);
CREATE INDEX IF NOT EXISTS lead_import_runs_campaign_idx
  ON public.lead_import_runs (campaign_id)
  WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Generation runs
-- ---------------------------------------------------------------------------

-- Generation is auto-triggered, so the customer never pressed a button they
-- can watch. This table is the only thing that can answer "is it still
-- working, and what failed" - and it must always reach a terminal state.
CREATE TABLE IF NOT EXISTS public.campaign_generation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  import_run_id UUID REFERENCES public.lead_import_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'timed_out')),
  trigger TEXT NOT NULL DEFAULT 'leads_ready'
    CHECK (trigger IN ('leads_ready', 'manual_retry', 'regenerate')),

  total_leads INTEGER NOT NULL DEFAULT 0,
  processed_leads INTEGER NOT NULL DEFAULT 0,
  generated_messages INTEGER NOT NULL DEFAULT 0,
  failed_leads INTEGER NOT NULL DEFAULT 0,
  skipped_leads INTEGER NOT NULL DEFAULT 0,

  -- Per-lead failure detail: [{ leadId, step, reason, attempts }]. Drives the
  -- "28 generated, 2 failed" panel and its retry action.
  failures JSONB NOT NULL DEFAULT '[]'::jsonb,

  provider TEXT,
  model TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_generation_runs_campaign_idx
  ON public.campaign_generation_runs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_generation_runs_active_idx
  ON public.campaign_generation_runs (organization_id, status)
  WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Leads: qualification, enrichment completeness, context score
-- ---------------------------------------------------------------------------

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS import_run_id UUID REFERENCES public.lead_import_runs(id) ON DELETE SET NULL,

  -- Eligibility, deliberately separate from leads.status. 'pending' until the
  -- lead has finished enrichment and been judged.
  ADD COLUMN IF NOT EXISTS qualification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (qualification_status IN ('pending', 'qualified', 'rejected')),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT
    CHECK (rejection_reason IS NULL OR rejection_reason IN (
      'no_email',
      'unverified_email',
      'generic_inbox',
      'duplicate',
      'suppressed',
      'do_not_contact',
      'missing_identity'
    )),

  -- Enrichment is only "complete" once the person match, the organization
  -- lookup, and any expected waterfall webhook have all resolved (or the
  -- deadline swept them up). Scoring before that would measure our patience,
  -- not Apollo's data.
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (enrichment_status IN ('pending', 'enriching', 'awaiting_webhook', 'complete', 'incomplete', 'failed')),
  ADD COLUMN IF NOT EXISTS enrichment_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_completed_at TIMESTAMPTZ,
  -- True when the deadline cut enrichment short. Distinguishes "Apollo does
  -- not have this" from "we stopped waiting", which decides whether a retry
  -- is worth a credit.
  ADD COLUMN IF NOT EXISTS enrichment_timed_out BOOLEAN NOT NULL DEFAULT FALSE,

  -- Context readiness. required_met is the hard gate; context_score counts the
  -- optional ingredients actually present out of context_score_max.
  ADD COLUMN IF NOT EXISTS context_required_met BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS context_score INTEGER,
  ADD COLUMN IF NOT EXISTS context_score_max INTEGER,
  ADD COLUMN IF NOT EXISTS context_ingredients JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS leads_qualification_idx
  ON public.leads (organization_id, qualification_status);
CREATE INDEX IF NOT EXISTS leads_import_run_idx
  ON public.leads (import_run_id)
  WHERE import_run_id IS NOT NULL;
-- Drives the generation trigger: "which leads in this campaign are ready and
-- have no drafts yet".
CREATE INDEX IF NOT EXISTS leads_generation_ready_idx
  ON public.leads (campaign_id, enrichment_status, qualification_status)
  WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Email messages: draft -> approved -> queued -> sent
-- ---------------------------------------------------------------------------

-- 'draft'    generated and validated, awaiting approval
-- 'approved' cleared to send, picked up by the scheduler
-- 'queued'   handed to the send worker
--
-- A message that fails identity validation never reaches this table at all -
-- it is recorded as a generation failure instead, so every row here is by
-- definition safe to send.
ALTER TABLE public.email_messages
  DROP CONSTRAINT IF EXISTS email_messages_status_check;

ALTER TABLE public.email_messages
  ADD CONSTRAINT email_messages_status_check
  CHECK (status IN (
    'draft',
    'approved',
    'queued',
    'sent',
    'failed',
    'bounced',
    'skipped',
    'pending_review'
  ));

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT
    CHECK (approved_by IS NULL OR approved_by IN ('user', 'autopilot')),
  ADD COLUMN IF NOT EXISTS generation_run_id UUID
    REFERENCES public.campaign_generation_runs(id) ON DELETE SET NULL,
  -- provider, model, generation_version, apollo_person_id, context score,
  -- generated_at. Lets you later correlate context score against reply rate.
  ADD COLUMN IF NOT EXISTS generation_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS context_score INTEGER,
  -- Written from thin Apollo data. Truthful, but the reviewer should see at a
  -- glance how much of a batch is thin rather than discover it after sending.
  ADD COLUMN IF NOT EXISTS thin_context BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  -- Why a send was refused, for the message row itself. The generation run
  -- records why an email was never written; this records why a written one
  -- did not go out.
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS email_messages_approval_idx
  ON public.email_messages (campaign_id, status)
  WHERE status IN ('draft', 'approved');

-- ---------------------------------------------------------------------------
-- Campaigns: autopilot and the frozen brief
-- ---------------------------------------------------------------------------

ALTER TABLE public.campaigns
  -- Approval policy lives on the campaign so you can always see what *this*
  -- campaign will do without going hunting in Settings. Copied from the org
  -- default at creation; never read from the org again afterwards.
  ADD COLUMN IF NOT EXISTS autopilot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS autopilot_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS import_run_id UUID
    REFERENCES public.lead_import_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_source TEXT NOT NULL DEFAULT 'apollo'
    CHECK (lead_source IN ('apollo', 'csv', 'manual', 'mixed')),
  -- Frozen copy of angle/offer/cta/tone/language/proof/signature. Editing the
  -- agent config later must not silently rewrite a campaign already written.
  ADD COLUMN IF NOT EXISTS brief JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Agent config: the org-wide autopilot default
-- ---------------------------------------------------------------------------

ALTER TABLE public.agent_configs
  -- Sits beside auto_approve_replies, which is the same idea for inbound.
  ADD COLUMN IF NOT EXISTS autopilot_default BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'verified' protects the sending domain; loosening is a deliberate choice
  -- for customers whose niche Apollo cannot verify.
  ADD COLUMN IF NOT EXISTS email_qualification_policy TEXT NOT NULL DEFAULT 'verified'
    CHECK (email_qualification_policy IN ('verified', 'verified_or_likely', 'any'));

-- ---------------------------------------------------------------------------
-- Apollo enrichment runs: bulk kinds and the owning import
-- ---------------------------------------------------------------------------

ALTER TABLE public.apollo_enrichment_runs
  ADD COLUMN IF NOT EXISTS import_run_id UUID
    REFERENCES public.lead_import_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_size INTEGER;

ALTER TABLE public.apollo_enrichment_runs
  DROP CONSTRAINT IF EXISTS apollo_enrichment_runs_enrichment_kind_check;

ALTER TABLE public.apollo_enrichment_runs
  ADD CONSTRAINT apollo_enrichment_runs_enrichment_kind_check
  CHECK (enrichment_kind IN (
    'people_search',
    'person_match',
    'bulk_person_match',
    'organization_enrich',
    'organization_bulk_enrich',
    'organization_info',
    'phone_waterfall'
  ));

CREATE INDEX IF NOT EXISTS apollo_enrichment_runs_import_idx
  ON public.apollo_enrichment_runs (import_run_id)
  WHERE import_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.lead_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_generation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_import_run_org_isolation ON public.lead_import_runs;
CREATE POLICY lead_import_run_org_isolation ON public.lead_import_runs
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS campaign_generation_run_org_isolation ON public.campaign_generation_runs;
CREATE POLICY campaign_generation_run_org_isolation ON public.campaign_generation_runs
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);
