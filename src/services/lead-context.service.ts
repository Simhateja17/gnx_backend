import { createHash } from 'node:crypto';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

export type ContextChannel = 'email' | 'voice';

type ContextLead = Record<string, any> & {
  id: string;
  organization_id: string;
  account_id?: string | null;
};

type ContextAccount = Record<string, any> | null;

export type LeadContextSnapshot = {
  id: string;
  channel: ContextChannel;
  context_version: number;
  customer_context_version: string | null;
  factual_summary: string | null;
  pain_hypotheses: Array<Record<string, unknown>>;
  discovery_questions: string[];
  solution_angle: string | null;
  do_not_claim: string[];
  context_payload: Record<string, unknown>;
  snapshot_hash: string | null;
};

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed || null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => nonEmpty(item)).filter(Boolean) as string[];
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item == null || item === '') return false;
    if (Array.isArray(item) && item.length === 0) return false;
    return true;
  }));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

export function buildLeadContextPayload(input: {
  lead: ContextLead;
  account: ContextAccount;
  campaign?: Record<string, any> | null;
  agentConfig?: Record<string, any> | null;
}) {
  const { lead, account, campaign, agentConfig } = input;
  const accountFacts = compactObject({
    name: nonEmpty(account?.name) ?? nonEmpty(lead.company),
    domain: nonEmpty(account?.domain),
    industry: nonEmpty(account?.industry),
    industries: asStringArray(account?.industries),
    estimatedEmployees: account?.estimated_num_employees ?? null,
    annualRevenue: account?.annual_revenue ?? null,
    annualRevenuePrinted: nonEmpty(account?.annual_revenue_printed),
    technologies: asStringArray(account?.technology_names),
    headcountGrowthSixMonths: account?.headcount_growth_six_months ?? null,
    headcountGrowthTwelveMonths: account?.headcount_growth_twelve_months ?? null,
    headcountGrowthTwentyFourMonths: account?.headcount_growth_twenty_four_months ?? null,
    city: nonEmpty(account?.city),
    state: nonEmpty(account?.state),
    country: nonEmpty(account?.country),
    description: nonEmpty(account?.description),
  });

  const leadFacts = compactObject({
    name: nonEmpty(lead.name) ?? ([lead.first_name, lead.last_name].map(nonEmpty).filter(Boolean).join(' ') || null),
    title: nonEmpty(lead.title),
    headline: nonEmpty(lead.headline),
    department: nonEmpty(lead.department),
    jobFunction: nonEmpty(lead.job_function),
    seniority: nonEmpty(lead.seniority),
    email: nonEmpty(lead.email),
    city: nonEmpty(lead.city),
    state: nonEmpty(lead.state),
    country: nonEmpty(lead.country),
    location: nonEmpty(lead.location),
    linkedinUrl: nonEmpty(lead.linkedin_url),
  });

  const factualLines: string[] = [];
  if (accountFacts.name) factualLines.push(`Company: ${accountFacts.name}`);
  if (accountFacts.industry) factualLines.push(`Industry: ${accountFacts.industry}`);
  if (accountFacts.estimatedEmployees) factualLines.push(`Estimated employees: ${accountFacts.estimatedEmployees}`);
  if (accountFacts.annualRevenuePrinted || accountFacts.annualRevenue) factualLines.push(`Estimated annual revenue: ${accountFacts.annualRevenuePrinted ?? accountFacts.annualRevenue}`);
  if (accountFacts.technologies) factualLines.push(`Observed technologies: ${(accountFacts.technologies as string[]).slice(0, 12).join(', ')}`);
  if (leadFacts.title) factualLines.push(`Contact role: ${leadFacts.title}`);
  if (leadFacts.seniority) factualLines.push(`Contact seniority: ${leadFacts.seniority}`);
  if (leadFacts.location) factualLines.push(`Contact location: ${leadFacts.location}`);
  if (campaign?.prompt_context) factualLines.push(`Campaign context: ${String(campaign.prompt_context).slice(0, 500)}`);

  const painHypotheses = [
    leadFacts.title ? `Hypothesis only: a ${leadFacts.title} may care about measurable pipeline efficiency and team productivity.` : null,
    accountFacts.estimatedEmployees ? `Hypothesis only: a company of this size may have process consistency and handoff challenges.` : null,
    accountFacts.technologies ? 'Hypothesis only: the current sales stack may leave room for workflow integration or automation.' : null,
  ].filter(Boolean).map(text => ({ text, confidence: 'hypothesis' }));

  const discoveryQuestions = [
    'How are you currently identifying and prioritizing accounts like this?',
    'Where does the current outreach process slow your team down?',
    'What would make a change in this workflow worth evaluating this quarter?',
  ];

  const product = nonEmpty(agentConfig?.product_description);
  const valueProp = nonEmpty(agentConfig?.value_proposition);
  const solutionAngle = valueProp
    ? `Explore whether ${valueProp.charAt(0).toLowerCase()}${valueProp.slice(1)}`
    : product
      ? `Explore whether ${product.charAt(0).toLowerCase()}${product.slice(1)}`
      : null;

  const doNotClaim = [
    'Treat estimated employee, revenue, technology, and growth values as directional, not confirmed facts.',
    'Do not claim the prospect has a pain point unless they confirm it in the conversation.',
    'Do not mention private raw provider payloads or provider confidence fields to the prospect.',
  ];

  const customerContextVersion = [account?.last_enriched_at, lead.last_apollo_enriched_at, lead.updated_at, lead.created_at]
    .map(nonEmpty)
    .find(Boolean) ?? null;

  const contextPayload = {
    source: 'apollo_and_first_party_db',
    leadFacts,
    accountFacts,
    verifiedFacts: factualLines,
    campaignContext: nonEmpty(campaign?.prompt_context),
    hypotheses: painHypotheses,
    discoveryQuestions,
    solutionAngle,
    doNotClaim,
  };

  return {
    factualSummary: factualLines.join('\n'),
    painHypotheses,
    discoveryQuestions,
    solutionAngle,
    doNotClaim,
    customerContextVersion,
    contextPayload,
    snapshotHash: createHash('sha256').update(stableJson(contextPayload)).digest('hex'),
  };
}

export async function createOrReuseLeadContextSnapshot(
  organizationId: string,
  leadId: string,
  campaignId: string | null | undefined,
  channel: ContextChannel,
  agentConfig?: Record<string, any> | null,
): Promise<LeadContextSnapshot> {
  const [leadResult, campaignResult] = await Promise.all([
    supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('organization_id', organizationId)
      .single(),
    campaignId
      ? supabase.from('campaigns').select('id,prompt_context').eq('id', campaignId).eq('organization_id', organizationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (leadResult.error || !leadResult.data) throw new AppError(404, 'Lead not found for context snapshot', leadResult.error);
  if (campaignResult.error) throw new AppError(500, 'Failed to load campaign context', campaignResult.error);

  const lead = leadResult.data as ContextLead;
  let account: ContextAccount = null;
  if (lead.account_id) {
    const accountResult = await supabase
      .from('accounts')
      .select('*')
      .eq('id', lead.account_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (accountResult.error) throw new AppError(500, 'Failed to load account context', accountResult.error);
    account = accountResult.data;
  }

  const built = buildLeadContextPayload({
    lead,
    account,
    campaign: campaignResult.data,
    agentConfig,
  });

  let existingQuery = supabase
    .from('lead_context_snapshots')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .eq('snapshot_hash', built.snapshotHash)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1);
  existingQuery = campaignId ? existingQuery.eq('campaign_id', campaignId) : existingQuery.is('campaign_id', null);
  const { data: existing, error: existingError } = await existingQuery.maybeSingle();
  if (existingError) throw new AppError(500, 'Failed to load existing context snapshot', existingError);
  if (existing) return existing as LeadContextSnapshot;

  const { data, error } = await supabase
    .from('lead_context_snapshots')
    .insert({
      organization_id: organizationId,
      lead_id: leadId,
      account_id: lead.account_id ?? null,
      campaign_id: campaignId ?? null,
      channel,
      status: 'ready',
      context_version: 1,
      snapshot_hash: built.snapshotHash,
      customer_context_version: built.customerContextVersion,
      factual_summary: built.factualSummary,
      pain_hypotheses: built.painHypotheses,
      discovery_questions: built.discoveryQuestions,
      solution_angle: built.solutionAngle,
      do_not_claim: built.doNotClaim,
      context_payload: built.contextPayload,
    })
    .select('*')
    .single();

  if (error || !data) throw new AppError(500, 'Failed to create lead context snapshot', error);
  return data as LeadContextSnapshot;
}

export function contextSnapshotToDynamicVariables(
  snapshot: LeadContextSnapshot,
  lead: Record<string, any>,
): Record<string, string> {
  const payload = snapshot.context_payload ?? {};
  const leadFacts = (payload.leadFacts ?? {}) as Record<string, unknown>;
  const accountFacts = (payload.accountFacts ?? {}) as Record<string, unknown>;

  return {
    lead_name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || String(lead.name ?? ''),
    lead_title: String(lead.title ?? ''),
    lead_company: String(lead.company ?? accountFacts.name ?? ''),
    lead_email: String(lead.email ?? ''),
    lead_factual_summary: snapshot.factual_summary ?? '',
    lead_verified_facts: JSON.stringify(payload.verifiedFacts ?? []),
    lead_company_facts: JSON.stringify(accountFacts),
    lead_pain_hypotheses: JSON.stringify(snapshot.pain_hypotheses ?? []),
    lead_discovery_questions: JSON.stringify(snapshot.discovery_questions ?? []),
    lead_solution_angle: snapshot.solution_angle ?? '',
    lead_do_not_claim: JSON.stringify(snapshot.do_not_claim ?? []),
    customer_context_version: snapshot.customer_context_version ?? '',
    lead_department: String(leadFacts.department ?? lead.department ?? ''),
    lead_seniority: String(leadFacts.seniority ?? lead.seniority ?? ''),
  };
}
