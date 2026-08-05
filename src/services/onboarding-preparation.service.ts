import { redis } from '../lib/redis';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import {
  ONBOARDING_APOLLO_MAX_CANDIDATES,
  ONBOARDING_APOLLO_MAX_SEARCH_PAGES,
  ONBOARDING_ENRICHED_LEAD_TARGET,
} from '../config/constants';
import { enrichLeads, searchApollo } from './leads.service';

const PREPARATION_TTL_SECONDS = 24 * 60 * 60;

export type OnboardingPreparationStatus = 'idle' | 'queued' | 'preparing' | 'ready' | 'attention';

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
  searchPages: number;
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
    searchPages: 0,
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

async function readPendingApolloLeadIds(organizationId: string, campaignId: string, limit: number) {
  const { data, error } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('source', 'apollo')
    .is('last_apollo_enriched_at', null)
    .neq('status', 'enrichment_failed')
    .limit(limit);

  if (error) throw new AppError(500, 'Failed to read pending onboarding Apollo leads', error);
  return (data ?? []).map(lead => lead.id);
}

async function readPendingApolloLeadIdsForCandidates(
  organizationId: string,
  campaignId: string,
  candidateIds: string[],
) {
  if (candidateIds.length === 0) return [];

  const { data, error } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('source', 'apollo')
    .is('last_apollo_enriched_at', null)
    .neq('status', 'enrichment_failed')
    .in('id', candidateIds);

  if (error) throw new AppError(500, 'Failed to read candidate onboarding Apollo leads', error);
  return (data ?? []).map(lead => lead.id);
}

function finalError(progress: OnboardingPreparationProgress, matchesReturned: number) {
  if (progress.enriched >= progress.targetEnriched) return null;
  if (matchesReturned === 0 && progress.enriched === 0) {
    return 'Apollo found no people matching this ICP. Broaden the titles, industries, company sizes, or locations and retry.';
  }
  if (progress.candidatesAttempted >= ONBOARDING_APOLLO_MAX_CANDIDATES) {
    return `Apollo prepared ${progress.enriched} enriched leads, but the onboarding safety limit was reached before ${progress.targetEnriched}. Retry after refining the ICP.`;
  }
  return `Apollo prepared ${progress.enriched} enriched leads, but did not return enough usable matches to reach ${progress.targetEnriched}. Retry after refining the ICP.`;
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

  const initialCounts = await readCampaignLeadCounts(criteria.organizationId, criteria.campaignId);
  progress.enriched = initialCounts.enriched;
  progress.failed = initialCounts.failed;
  progress.candidatesFound = initialCounts.attached;
  await setOnboardingPreparationProgress(progress, criteria.campaignId);

  // A repeated onboarding request should finish enriching any candidates that
  // were already attached before searching Apollo for more.
  const initialPendingIds = await readPendingApolloLeadIds(
    criteria.organizationId,
    criteria.campaignId,
    ONBOARDING_APOLLO_MAX_CANDIDATES,
  );
  if (initialPendingIds.length > 0 && progress.enriched < targetEnriched) {
    progress.candidatesAttempted += initialPendingIds.length;
    await setOnboardingPreparationProgress(progress, criteria.campaignId);
    await enrichLeads(criteria.organizationId, initialPendingIds, criteria.campaignId);
    const counts = await readCampaignLeadCounts(criteria.organizationId, criteria.campaignId);
    progress.enriched = counts.enriched;
    progress.failed = counts.failed;
    await setOnboardingPreparationProgress(progress, criteria.campaignId);
  }

  let lastMatchesReturned = 0;
  const attemptedLeadIds = new Set(initialPendingIds);

  for (
    let page = 1;
    page <= ONBOARDING_APOLLO_MAX_SEARCH_PAGES
      && progress.enriched < targetEnriched
      && progress.candidatesAttempted < ONBOARDING_APOLLO_MAX_CANDIDATES;
    page++
  ) {
    const result = await searchApollo(criteria.organizationId, {
      campaignId: criteria.campaignId,
      titles: criteria.titles,
      locations: criteria.locations,
      companySizes: criteria.companySizes,
      keywords: criteria.keywords,
      page,
      perPage: 100,
    });

    progress.searchPages = page;
    lastMatchesReturned = result.matchesReturned;
    progress.inserted += result.inserted;
    progress.reused += result.reused;
    progress.skippedDuplicates += result.skipped;

    const candidateIds = [...new Set(result.candidateIds.filter(id => !attemptedLeadIds.has(id)))];
    progress.candidatesFound += candidateIds.length;
    // Mark every candidate as seen, including leads that were already
    // enriched. The preparation loop must not spend another enrichment call
    // on a lead merely because Apollo returned it on a later page.
    candidateIds.forEach(id => attemptedLeadIds.add(id));
    const remainingCandidateBudget = ONBOARDING_APOLLO_MAX_CANDIDATES - progress.candidatesAttempted;
    const pendingCandidateIds = await readPendingApolloLeadIdsForCandidates(
      criteria.organizationId,
      criteria.campaignId,
      candidateIds,
    );
    const idsToEnrich = pendingCandidateIds.slice(0, remainingCandidateBudget);

    if (idsToEnrich.length > 0) {
      progress.candidatesAttempted += idsToEnrich.length;
      await setOnboardingPreparationProgress(progress, criteria.campaignId);
      await enrichLeads(criteria.organizationId, idsToEnrich, criteria.campaignId);
    }

    const counts = await readCampaignLeadCounts(criteria.organizationId, criteria.campaignId);
    progress.enriched = counts.enriched;
    progress.failed = counts.failed;
    await setOnboardingPreparationProgress(progress, criteria.campaignId);

    if (result.matchesReturned === 0) break;
  }

  const finalCounts = await readCampaignLeadCounts(criteria.organizationId, criteria.campaignId);
  progress.enriched = finalCounts.enriched;
  progress.failed = finalCounts.failed;
  progress.status = progress.enriched >= targetEnriched ? 'ready' : 'attention';
  progress.error = finalError(progress, lastMatchesReturned);
  progress.updatedAt = new Date().toISOString();
  await setOnboardingPreparationProgress(progress, criteria.campaignId);
  return progress;
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
    status,
    enriched: counts.enriched,
    attached: counts.attached,
    pending: counts.pending,
    failed: counts.failed,
    updatedAt: new Date().toISOString(),
  };
}
