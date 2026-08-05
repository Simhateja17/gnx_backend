import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import {
  DEFAULT_BUSINESS_HOURS,
  EMAIL_SEQUENCE_DEFAULTS,
  ONBOARDING_ENRICHED_LEAD_TARGET,
  PLANS,
  VOICE_DEFAULTS,
} from '../config/constants';
import { AppError } from '../types';
import type { OnboardingInput } from '../schemas/onboarding.schema';
import { createCampaign, getCampaign, upsertSequenceSteps } from './campaigns.service';
import { enqueueOnboardingLeads } from '../jobs/onboarding-leads.job';
import {
  setOnboardingPreparationProgress,
  type OnboardingPreparationProgress,
} from './onboarding-preparation.service';

type AgentConfigSetupRow = {
  id: string;
  onboarding_campaign_id?: string | null;
};

type InitialCampaignPreparation = {
  status: 'ready' | 'preparing' | 'attention';
  campaign: any;
  apollo: {
    status: 'ready' | 'already_populated' | 'not_connected' | 'preparing' | 'empty' | 'failed';
    targetEnriched: number;
    enriched: number;
    candidatesFound: number;
    candidatesAttempted: number;
    failed: number;
    searchPages: number;
    inserted: number;
    reused: number;
    skippedDuplicates: number;
    error: string | null;
  };
};

function listValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function trimText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

function safeApolloError(error: unknown): string {
  if (error instanceof AppError && error.status === 503) {
    return 'Apollo is not connected yet. Connect Apollo from Prospects and run the first search there.';
  }
  return 'Apollo could not prepare the first lead batch. You can retry the search from Prospects.';
}

function buildInitialCampaignInput(data: Partial<OnboardingInput>, planId: string) {
  const plan = PLANS[planId as keyof typeof PLANS] ?? PLANS.starter;
  const company = textValue(data.company, 'Your company');
  const titles = listValue(data.icpTitles);
  const industries = listValue(data.icpTargetIndustries);
  const companySizes = listValue(data.icpCompanySizes);
  const geos = listValue(data.icpGeos);
  const audience = [
    titles.length ? `titles: ${titles.join(', ')}` : '',
    industries.length ? `industries: ${industries.join(', ')}` : '',
    companySizes.length ? `company sizes: ${companySizes.join(', ')}` : '',
    geos.length ? `geographies: ${geos.join(', ')}` : '',
  ].filter(Boolean).join('; ');

  const promptNotes = trimText([
    data.productDescription ? `Product: ${textValue(data.productDescription)}` : '',
    data.valueProp ? `Customer outcome: ${textValue(data.valueProp)}` : '',
    data.painPoints ? `Buyer pain points: ${textValue(data.painPoints)}` : '',
    audience ? `Target audience: ${audience}` : '',
    'Use verified Apollo facts when available. Treat likely pain points as discovery hypotheses, never as claims.',
  ].filter(Boolean).join('\n\n'), 2000);

  return {
    name: trimText(`${company} - First outreach`, 120),
    // The production database currently supports email and voice separately;
    // start with email because onboarding already collects the product and
    // messaging context needed for the first reviewable campaign.
    channel: 'email' as const,
    icpSource: trimText(audience, 240),
    promptNotes,
    maxLeads: plan.maxLeadsPerCampaign,
    dailySendCap: plan.dailyEmailCap,
    callCadencePerHour: VOICE_DEFAULTS.callsPerHour,
    voiceMode: 'ai' as const,
    businessHoursStart: DEFAULT_BUSINESS_HOURS.start,
    businessHoursEnd: DEFAULT_BUSINESS_HOURS.end,
    timezone: 'America/New_York',
  };
}

function buildInitialSequenceSteps(data: Partial<OnboardingInput>) {
  const painPoints = textValue(data.painPoints, 'the buyer’s current growth and outreach challenges');
  const valueProp = textValue(data.valueProp, 'the customer outcome described during onboarding');

  return EMAIL_SEQUENCE_DEFAULTS.map(step => ({
    stepNumber: step.stepNumber,
    delayDays: step.delayDays,
    subjectTemplate: step.stepNumber === 1 ? 'A relevant idea for {{company}}' : '',
    bodyPromptContext: step.stepNumber === 1
      ? `Lead with a concise, role-aware observation about ${painPoints}. Position ${valueProp} as a possible way to help, then ask a low-pressure discovery question.`
      : step.stepNumber === 2
        ? 'Add a new angle rather than repeating the first email. Reference a verified company or role fact when available and invite a short conversation.'
        : 'Close the sequence respectfully. Give the prospect an easy way to say not now and do not create urgency or unsupported claims.',
  }));
}

async function countCampaignLeads(orgId: string, campaignId: string) {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('campaign_id', campaignId)
    .eq('source', 'apollo');
  if (error) throw new AppError(500, 'Failed to count the initial campaign leads', error);
  return count ?? 0;
}

async function countCampaignEnrichedLeads(orgId: string, campaignId: string) {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('campaign_id', campaignId)
    .eq('source', 'apollo')
    .not('last_apollo_enriched_at', 'is', null);
  if (error) throw new AppError(500, 'Failed to count enriched onboarding leads', error);
  return count ?? 0;
}

async function prepareInitialCampaign(
  orgId: string,
  data: Partial<OnboardingInput>,
  agentConfig: AgentConfigSetupRow,
  planId: string,
): Promise<InitialCampaignPreparation> {
  let campaign: any = null;

  if (agentConfig.onboarding_campaign_id) {
    try {
      campaign = await getCampaign(orgId, agentConfig.onboarding_campaign_id);
    } catch (error) {
      if (!(error instanceof AppError && error.status === 404)) throw error;
    }
  }

  if (!campaign) {
    campaign = await createCampaign(orgId, buildInitialCampaignInput(data, planId));

    // Persist the relationship immediately after creation. A repeated
    // onboarding submit can then resume this exact draft instead of creating
    // another first campaign.
    const { error } = await supabase
      .from('agent_configs')
      .update({ onboarding_campaign_id: campaign.id, updated_at: new Date().toISOString() })
      .eq('id', agentConfig.id)
      .eq('organization_id', orgId);
    if (error) throw new AppError(500, 'Failed to link the initial campaign to onboarding', error);

    await upsertSequenceSteps(orgId, campaign.id, { steps: buildInitialSequenceSteps(data) });
  }

  const existingLeadCount = await countCampaignLeads(orgId, campaign.id);
  const enrichedLeadCount = await countCampaignEnrichedLeads(orgId, campaign.id);
  const targetEnriched = Math.min(
    ONBOARDING_ENRICHED_LEAD_TARGET,
    buildInitialCampaignInput(data, planId).maxLeads,
  );
  let apollo: InitialCampaignPreparation['apollo'] = {
    status: enrichedLeadCount >= targetEnriched ? 'already_populated' : 'empty',
    targetEnriched,
    enriched: enrichedLeadCount,
    candidatesFound: existingLeadCount,
    candidatesAttempted: 0,
    failed: 0,
    searchPages: 0,
    inserted: 0,
    reused: 0,
    skippedDuplicates: 0,
    error: null,
  };

  if (enrichedLeadCount < targetEnriched) {
    if (!env.APOLLO_API_KEY) {
      apollo = {
        ...apollo,
        status: 'not_connected',
        error: 'Apollo is not connected yet. Connect Apollo from Prospects and run the first search there.',
      };
    } else {
      const queuedProgress: OnboardingPreparationProgress = {
        status: 'queued',
        targetEnriched,
        enriched: enrichedLeadCount,
        candidatesFound: existingLeadCount,
        candidatesAttempted: 0,
        inserted: 0,
        reused: 0,
        skippedDuplicates: 0,
        failed: 0,
        searchPages: 0,
        error: null,
        updatedAt: new Date().toISOString(),
      };

      try {
        await setOnboardingPreparationProgress(queuedProgress, campaign.id);
        const job = await enqueueOnboardingLeads({
          organizationId: orgId,
          campaignId: campaign.id,
          targetEnriched,
          titles: listValue(data.icpTitles),
          locations: listValue(data.icpGeos),
          companySizes: listValue(data.icpCompanySizes),
          keywords: listValue(data.icpTargetIndustries).join(', '),
        });
        console.log(`[onboarding-apollo] queued preparation job ${job.id ?? 'unknown'} for campaign ${campaign.id} (${targetEnriched} enriched leads target)`);
        apollo = {
          ...apollo,
          status: 'preparing',
        };
      } catch (error) {
        const message = safeApolloError(error);
        await setOnboardingPreparationProgress({
          ...queuedProgress,
          status: 'attention',
          error: message,
          updatedAt: new Date().toISOString(),
        }, campaign.id);
        apollo = {
          ...apollo,
          status: 'failed',
          error: message,
        };
      }
    }
  }

  const refreshedCampaign = await getCampaign(orgId, campaign.id);
  return {
    status: apollo.status === 'failed' || apollo.status === 'not_connected'
      ? 'attention'
      : apollo.status === 'preparing'
        ? 'preparing'
        : 'ready',
    campaign: refreshedCampaign,
    apollo,
  };
}

export async function submitOnboarding(orgId: string, data: Partial<OnboardingInput>) {
  const { data: existing } = await supabase
    .from('agent_configs')
    .select('id,onboarding_campaign_id')
    .eq('organization_id', orgId)
    .maybeSingle();

  const record: Record<string, unknown> = {
    agent_name: data.agentName ?? 'Nexo',
    first_name: data.firstName ?? '',
    last_name: data.lastName ?? '',
    company: data.company ?? '',
    role: data.role ?? '',
    industry: data.industry ?? '',
    product_description: data.productDescription ?? '',
    value_proposition: data.valueProp ?? '',
    pain_points: data.painPoints ?? null,
    tone: data.tone ?? 'consultative',
    hook_style: data.hookStyle ?? '',
    follow_up_cadence: data.followUpCadence ?? '',
    icp_titles: data.icpTitles ?? [],
    icp_company_sizes: data.icpCompanySizes ?? [],
    icp_target_industries: data.icpTargetIndustries ?? [],
    icp_geos: data.icpGeos ?? [],
    meeting_target: data.meetingTarget ?? 15,
    deal_size: data.dealSize ?? '',
    sales_cycle: data.salesCycle ?? '',
    booking_link: data.bookingLink || null,
    tools: data.tools ?? [],
    updated_at: new Date().toISOString(),
  };

  if (data.phoneCountry !== undefined) {
    record.retell_phone_country = data.phoneCountry;
  }

  let agentConfig: AgentConfigSetupRow;
  if (existing) {
    const { error } = await supabase
      .from('agent_configs')
      .update(record)
      .eq('organization_id', orgId);
    if (error) throw new AppError(500, 'Failed to update agent config', error);
    agentConfig = existing as AgentConfigSetupRow;
  } else {
    const { data: inserted, error } = await supabase
      .from('agent_configs')
      .insert({ ...record, organization_id: orgId })
      .select('id')
      .single();
    if (error) throw new AppError(500, 'Failed to create agent config', error);
    if (!inserted?.id) throw new AppError(500, 'Agent config was created without an id');
    agentConfig = { id: inserted.id, onboarding_campaign_id: null };
  }

  if (data.company) {
    const { error } = await supabase
      .from('organizations')
      .update({ name: data.company })
      .eq('id', orgId);
    if (error) throw new AppError(500, 'Failed to update organisation name', error);
  }

  const { data: organization, error: organizationError } = await supabase
    .from('organizations')
    .select('name,plan_id')
    .eq('id', orgId)
    .single();
  if (organizationError || !organization) {
    throw new AppError(500, 'Failed to load organisation plan for the initial campaign', organizationError);
  }

  const preparation = await prepareInitialCampaign(
    orgId,
    data,
    agentConfig,
    organization.plan_id ?? 'starter',
  );

  return {
    success: true,
    campaign: preparation.campaign,
    preparation: {
      status: preparation.status,
      apollo: preparation.apollo,
    },
  };
}

export async function getOnboarding(orgId: string) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch onboarding data', error);
  return data;
}
