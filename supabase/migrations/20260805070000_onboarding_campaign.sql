-- Keep the one campaign created from onboarding linked to the organisation's
-- agent configuration. This makes onboarding retries return to the same draft
-- instead of creating a second campaign.
ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS onboarding_campaign_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_configs_onboarding_campaign_id_fkey'
       AND conrelid = 'public.agent_configs'::regclass
  ) THEN
    ALTER TABLE public.agent_configs
      ADD CONSTRAINT agent_configs_onboarding_campaign_id_fkey
      FOREIGN KEY (onboarding_campaign_id)
      REFERENCES public.campaigns(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_agent_configs_onboarding_campaign
  ON public.agent_configs(onboarding_campaign_id)
  WHERE onboarding_campaign_id IS NOT NULL;
