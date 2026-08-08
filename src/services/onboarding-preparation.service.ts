import { redis } from '../lib/redis';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import {
  ONBOARDING_APOLLO_MAX_CANDIDATES,
  ONBOARDING_ENRICHED_LEAD_TARGET,
} from '../config/constants';
import { runApolloImport } from './apollo-import.service';

const PREPARATION_TTL_SECONDS = 24 * 60 * 60;

// 'partial' is a legitimate outcome, not a degraded 'attention': Apollo may
// simply not hold enough verified people for a given profile.
export type OnboardingPreparationStatus =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'ready'
  | 'partial'
  | 'attention';

export type OnboardingPreparationProgress = {
  status: OnboardingPreparationStatus;
  targetEnriched: number;
  enriched: number;
  candidatesFound: number;
  candidatesAttempted: number;
  inserted: number;
  reused: number;
  skippedDuplicates: number;
  failed: number;
  rejected: number;
  searchPages: number;
  importRunId: string | null;
  error: string | null;
  updatedAt: string;
};

export type OnboardingPreparationCriteria = {
  organizationId: string;
  campaignId: string;
  targetEnriched?: number;
  titles: string[];
  locations: string[];
  companySizes: string[];
  keywords: string;
};

type CampaignLeadCounts = {
  attached: number;
  enriched: number;
  failed: number;
  pending: number;
};

function preparationKey(campaignId: string) {
  return `onboarding-apollo-preparation:${campaignId}`;
}

function emptyProgress(targetEnriched = ONBOARDING_ENRICHED_LEAD_TARGET): OnboardingPreparationProgress {
  return {
    status: 'idle',
    targetEnriched,
    enriched: 0,
    candidatesFound: 0,
    candidatesAttempted: 0,
    inserted: 0,
    reused: 0,
    skippedDuplicates: 0,
    failed: 0,
    rejected: 0,
    searchPages: 0,
    importRunId: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function setOnboardingPreparationProgress(progress: OnboardingPreparationProgress, campaignId: string) {
  try {
    await redis.set(
      preparationKey(campaignId),
      JSON.stringify(progress),
      'EX',
      PREPARATION_TTL_SECONDS,
    );
  } catch (error) {
    // Progress is useful to the UI but must never turn a successful Apollo
    // preparation into a failed job when Redis is temporarily unavailable.
    console.warn('[onboarding-apollo] failed to persist progress:', error instanceof Error ? error.message : error);
  }
}

export async function getOnboardingPreparationProgress(campaignId: string) {
  try {
    const raw = await redis.get(preparationKey(campaignId));
    if (!raw) return null;
    return JSON.parse(raw) as OnboardingPreparationProgress;
  } catch (error) {
    console.warn('[onboarding-apollo] failed to read progress:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function readCampaignLeadCounts(organizationId: string, campaignId: string): Promise<CampaignLeadCounts> {
  const { data, error } = await supabase
    .from('leads')
    .select('id,status,last_apollo_enriched_at')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('source', 'apollo');

  if (error) throw new AppError(500, 'Failed to read onboarding Apollo lead progress', error);

  const leads = data ?? [];
  const enriched = leads.filter(lead => Boolean(lead.last_apollo_enriched_at)).length;
  const failed = leads.filter(lead => lead.status === 'enrichment_failed').length;

  return {
    attached: leads.length,
    enriched,
    failed,
    pending: Math.max(0, leads.length - enriched - failed),
  };
}

/**
 * Message for a run that qualified nobody.
 *
 * Distinguishes "Apollo has no such people" from "Apollo had people but none
 * were contactable", because those send the customer to different fixes:
 * broaden the profile, versus loosen the email policy or accept the niche is
 * hard to reach.
 */
function noMatchesError(progress: OnboardingPreparationProgress) {
  if (progress.candidatesFound === 0) {
    return 'Apollo found no people matching this profile. Broaden the titles, industries, company sizes, or locations and try again.';
  }
  return `Apollo found ${progress.candidatesFound} people, but none had a verified work email. Broaden the profile, or loosen the email policy in Settings if this market is hard to verify.`;
}

export async function prepareApolloLeadsForCampaign(criteria: OnboardingPreparationCriteria) {
  const targetEnriched = Math.max(
    1,
    Math.min(criteria.targetEnriched ?? ONBOARDING_ENRICHED_LEAD_TARGET, ONBOARDING_ENRICHED_LEAD_TARGET),
  );

  const progress: OnboardingPreparationProgress = {
    ...emptyProgress(targetEnriched),
    status: 'preparing',
  };
  await setOnboardingPreparationProgress(progress, criteria.campaignId);

  console.log(`[onboarding-apollo] starting campaign ${criteria.campaignId} for ${targetEnriched} qualified leads`);

  try {
    const run = await runApolloImport({
      organizationId: criteria.organizationId,
      campaignId: criteria.campaignId,
      titles: criteria.titles,
      locations: criteria.locations,
      companySizes: criteria.companySizes,
      keywords: criteria.keywords,
      limit: targetEnriched,
      candidateCap: ONBOARDING_APOLLO_MAX_CANDIDATES,
    });

    const qualified = Number(run.qualified_count ?? 0);

    progress.enriched = qualified;
    progress.candidatesFound = Number(run.candidates_found ?? 0);
    progress.candidatesAttempted = Number(run.candidates_attempted ?? 0);
    progress.skippedDuplicates = Number(run.duplicate_count ?? 0);
    progress.rejected = Number(run.rejected_count ?? 0);
    progress.failed = Number(run.failed_count ?? 0);
    progress.searchPages = Number(run.pages_searched ?? 0);
    progress.importRunId = run.id;

    // 'partial' is a real outcome, not a failure: Apollo may simply not hold
    // enough verified people for this ICP. Only a run that found nobody at all
    // is worth raising as needing attention.
    progress.status = qualified >= targetEnriched
      ? 'ready'
      : qualified > 0
        ? 'partial'
        : 'attention';

    progress.error = qualified === 0 ? noMatchesError(progress) : null;
    progress.updatedAt = new Date().toISOString();
    await setOnboardingPreparationProgress(progress, criteria.campaignId);

    console.log(
      `[onboarding-apollo] campaign ${criteria.campaignId} finished ${run.status}: ` +
      `${qualified}/${targetEnriched} qualified, ${progress.rejected} filtered out`
    );

    // Generation is queued by the import worker once the run completes, so a
    // customer arriving at the campaign finds emails already being written.
    return { ...progress, targetEnriched };
  } catch (error) {
    progress.status = 'attention';
    progress.error = error instanceof Error ? error.message : 'Apollo preparation failed';
    progress.updatedAt = new Date().toISOString();
    await setOnboardingPreparationProgress(progress, criteria.campaignId);
    throw error;
  }
}

export async function getOnboardingPreparation(organizationId: string, campaignId: string) {
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('id', campaignId)
    .maybeSingle();

  if (campaignError) throw new AppError(500, 'Failed to verify onboarding campaign', campaignError);
  if (!campaign) throw new AppError(404, 'Onboarding campaign not found');

  const [stored, counts] = await Promise.all([
    getOnboardingPreparationProgress(campaignId),
    readCampaignLeadCounts(organizationId, campaignId),
  ]);
  const progress = stored ?? emptyProgress();
  const status = counts.enriched >= progress.targetEnriched
    ? 'ready'
    : progress.status;

  return {
    ...progress,
    campaignId,
    status,
    enriched: counts.enriched,
    attached: counts.attached,
    pending: counts.pending,
    failed: counts.failed,
    updatedAt: new Date().toISOString(),
  };
}

export async function getCurrentOnboardingPreparation(organizationId: string) {
  const { data: agentConfig, error } = await supabase
    .from('agent_configs')
    .select('onboarding_campaign_id')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to find the onboarding campaign', error);
  if (!agentConfig?.onboarding_campaign_id) return null;

  return getOnboardingPreparation(organizationId, agentConfig.onboarding_campaign_id);
}
