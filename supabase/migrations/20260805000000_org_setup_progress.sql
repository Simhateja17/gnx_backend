-- Organization-scoped onboarding/setup state.
--
-- Only holds the parts of setup that cannot be derived from real data:
-- tour position, explicit acknowledgements/skips, and the Setup Copilot draft.
-- Integration completion (Gmail, Calendar, Apollo, Retell, leads, campaigns) is
-- always derived from the live records at read time so the UI can never claim a
-- provider is connected when it is not.
CREATE TABLE IF NOT EXISTS public.org_setup_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- { [stepId]: { acknowledged: bool, skipped: bool, updatedAt: iso } }
  steps JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- { status, lastStepId, lastStepIndex, seenStepIds, startedAt, completedAt, updatedAt }
  tour JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Setup Copilot draft (channel, audience, campaign fields). Never contains
  -- provider credentials — only the customer's own campaign inputs.
  copilot JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_setup_progress_org
  ON public.org_setup_progress(organization_id);

ALTER TABLE public.org_setup_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_setup_progress_org_isolation ON public.org_setup_progress;
CREATE POLICY org_setup_progress_org_isolation ON public.org_setup_progress
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);
