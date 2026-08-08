import { createHash } from 'node:crypto';
import { env } from '../config/env';
import {
  enrichApolloOrganization,
  getApolloOrganization,
} from '../lib/apollo';
import { normalizeApolloDomain } from '../lib/apollo-domain';
import type { ApolloRequestContext } from '../lib/apollo';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import {
  buildBulkMatchDetail,
  buildBulkMatchOptions,
  waterfallRequested,
} from './apollo-request.service';

type JsonRecord = Record<string, unknown>;

export type ApolloPerson = JsonRecord & {
  id?: string;
  person_id?: string;
  contact_id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  headline?: string;
  email?: string;
  organization_id?: string;
  organization?: JsonRecord | null;
  contact?: JsonRecord | null;
  phone_numbers?: Array<JsonRecord>;
  employment_history?: Array<JsonRecord>;
  departments?: string[];
  functions?: string[];
  city?: string;
  state?: string;
  country?: string;
  linkedin_url?: string;
  photo_url?: string;
  email_status?: string;
  extrapolated_email_confidence?: number | null;
  dnc_status?: string;
  email_unsubscribed?: boolean;
};

export type MappedApolloPerson = {
  apolloId: string;
  contactId: string;
  firstName: string;
  lastName: string;
  name: string;
  title: string;
  headline: string;
  company: string;
  email: string;
  phone: string;
  phoneNumbers: Array<JsonRecord>;
  employmentHistory: Array<JsonRecord>;
  location: string;
  city: string;
  state: string;
  country: string;
  linkedinUrl: string;
  photoUrl: string;
  emailStatus: string;
  emailConfidence: number | null;
  department: string;
  jobFunction: string;
  seniority: string;
  dncStatus: string;
  emailUnsubscribed: boolean;
};

export type MappedApolloOrganization = {
  apolloOrganizationId: string | null;
  apolloAccountId: string | null;
  name: string;
  domain: string | null;
  normalizedDomain: string | null;
  website: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  facebookUrl: string | null;
  logoUrl: string | null;
  industry: string | null;
  industries: Array<unknown>;
  keywords: Array<unknown>;
  description: string | null;
  rawAddress: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  estimatedNumEmployees: number | null;
  annualRevenue: number | null;
  annualRevenuePrinted: string | null;
  totalFunding: number | null;
  totalFundingPrinted: string | null;
  latestFundingStage: string | null;
  fundingEvents: Array<unknown>;
  technologyNames: Array<unknown>;
  currentTechnologies: Array<unknown>;
  departmentalHeadcount: JsonRecord;
  headcountGrowthSixMonths: number | null;
  headcountGrowthTwelveMonths: number | null;
  headcountGrowthTwentyFourMonths: number | null;
  parentApolloOrganizationId: string | null;
  suborganizations: Array<unknown>;
  intentSummary: JsonRecord | null;
};

export type ApolloLeadCurrent = JsonRecord & {
  id?: string;
  organization_id?: string;
  manual_field_overrides?: JsonRecord | null;
  do_not_email?: boolean;
  do_not_call?: boolean;
  email_unsubscribed?: boolean;
};

export type ApolloRunKind =
  | 'people_search'
  | 'person_match'
  | 'bulk_person_match'
  | 'organization_enrich'
  | 'organization_bulk_enrich'
  | 'organization_info'
  | 'phone_waterfall';

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).map(item => firstString(item)).filter(Boolean) as string[];
}

// Re-exported so existing importers keep working. The implementation lives in
// lib/apollo-domain so both request builders can share it without importing
// each other, and so it survives tests that mock the HTTP client wholesale.
export { normalizeApolloDomain };

function unwrapOrganization(payload: unknown): JsonRecord | null {
  const record = asRecord(payload);
  return asRecord(record?.organization) ?? record;
}

export function mapApolloOrganization(input: unknown): MappedApolloOrganization | null {
  const organization = unwrapOrganization(input);
  if (!organization) return null;

  const account = asRecord(organization.account);
  const website = firstString(organization.website_url, account?.website_url);
  const domain = firstString(
    organization.primary_domain,
    organization.domain,
    account?.domain,
    normalizeApolloDomain(website),
  );
  const normalizedDomain = normalizeApolloDomain(domain);
  const name = firstString(organization.name, account?.name, normalizedDomain);
  if (!name) return null;

  const industries = asArray(organization.industries);
  const industry = firstString(organization.industry, industries[0]);
  const intentSummary = asRecord(organization.intent_signal_account)
    ?? asRecord(account?.intent_signal_account);

  return {
    apolloOrganizationId: firstString(organization.id, organization.organization_id),
    apolloAccountId: firstString(organization.account_id, account?.id),
    name,
    domain,
    normalizedDomain,
    website,
    linkedinUrl: firstString(organization.linkedin_url, account?.linkedin_url),
    twitterUrl: firstString(organization.twitter_url),
    facebookUrl: firstString(organization.facebook_url),
    logoUrl: firstString(organization.logo_url),
    industry,
    industries,
    keywords: asArray(organization.keywords),
    description: firstString(organization.short_description, organization.seo_description),
    rawAddress: firstString(organization.raw_address),
    streetAddress: firstString(organization.street_address),
    city: firstString(organization.city),
    state: firstString(organization.state),
    postalCode: firstString(organization.postal_code),
    country: firstString(organization.country),
    estimatedNumEmployees: asNumber(organization.estimated_num_employees),
    annualRevenue: asNumber(organization.annual_revenue),
    annualRevenuePrinted: firstString(organization.annual_revenue_printed),
    totalFunding: asNumber(organization.total_funding),
    totalFundingPrinted: firstString(organization.total_funding_printed),
    latestFundingStage: firstString(organization.latest_funding_stage),
    fundingEvents: asArray(organization.funding_events),
    technologyNames: asArray(organization.technology_names),
    currentTechnologies: asArray(organization.current_technologies),
    departmentalHeadcount: asRecord(organization.departmental_head_count) ?? {},
    headcountGrowthSixMonths: asNumber(organization.organization_headcount_six_month_growth),
    headcountGrowthTwelveMonths: asNumber(organization.organization_headcount_twelve_month_growth),
    headcountGrowthTwentyFourMonths: asNumber(organization.organization_headcount_twenty_four_month_growth),
    parentApolloOrganizationId: firstString(organization.parent_organization_id, organization.parent_apollo_organization_id),
    suborganizations: asArray(organization.suborganizations),
    intentSummary,
  };
}

export function mapApolloPerson(input: ApolloPerson): MappedApolloPerson {
  const contact = asRecord(input.contact);
  const organization = asRecord(input.organization);
  const phoneNumbers = (asArray(input.phone_numbers).length > 0
    ? asArray(input.phone_numbers)
    : asArray(contact?.phone_numbers)) as Array<JsonRecord>;
  const employmentHistory = (asArray(input.employment_history).length > 0
    ? asArray(input.employment_history)
    : asArray(contact?.employment_history)) as Array<JsonRecord>;
  const firstPhone = asRecord(phoneNumbers[0]);
  const currentEmployment = employmentHistory.find(item => asRecord(item)?.current === true);

  const firstName = firstString(input.first_name, contact?.first_name) ?? '';
  const lastName = firstString(input.last_name, contact?.last_name) ?? '';
  const name = firstString(input.name, contact?.name, [firstName, lastName].filter(Boolean).join(' ')) ?? '';
  const company = firstString(
    organization?.name,
    input.organization_name,
    asRecord(currentEmployment)?.organization_name,
    asRecord(employmentHistory[0])?.organization_name,
  ) ?? '';
  const city = firstString(input.city, contact?.city) ?? '';
  const state = firstString(input.state, contact?.state) ?? '';
  const country = firstString(input.country, contact?.country) ?? '';
  const emailUnsubscribed = input.email_unsubscribed === true || contact?.email_unsubscribed === true;

  return {
    apolloId: firstString(input.id, input.person_id) ?? '',
    contactId: firstString(input.contact_id, contact?.id) ?? '',
    firstName,
    lastName,
    name,
    title: firstString(input.title, contact?.title) ?? '',
    headline: firstString(input.headline, contact?.headline) ?? '',
    company,
    email: firstString(input.email, contact?.email) ?? '',
    phone: firstString(firstPhone?.sanitized_number, firstPhone?.raw_number) ?? '',
    phoneNumbers,
    employmentHistory,
    location: [city, state, country].filter(Boolean).join(', '),
    city,
    state,
    country,
    linkedinUrl: firstString(input.linkedin_url, contact?.linkedin_url) ?? '',
    photoUrl: firstString(input.photo_url, contact?.photo_url) ?? '',
    emailStatus: firstString(input.email_status, contact?.email_status) ?? '',
    emailConfidence: asNumber(input.extrapolated_email_confidence ?? contact?.extrapolated_email_confidence),
    department: firstString(asStringArray(input.departments)[0], asStringArray(contact?.departments)[0]) ?? '',
    jobFunction: firstString(asStringArray(input.functions)[0], asStringArray(contact?.functions)[0]) ?? '',
    seniority: firstString(input.seniority, contact?.seniority) ?? '',
    dncStatus: firstString(input.dnc_status, contact?.dnc_status) ?? '',
    emailUnsubscribed,
  };
}

export function buildApolloLeadPatch(
  person: ApolloPerson,
  currentLead: ApolloLeadCurrent = {},
  accountId?: string | null,
): JsonRecord {
  const mapped = mapApolloPerson(person);
  const manualOverrides = asRecord(currentLead.manual_field_overrides) ?? {};
  const hasManualOverride = (field: string) => Boolean(manualOverrides[field]);
  const patch: JsonRecord = {
    apollo_id: mapped.apolloId || currentLead.apollo_id,
    apollo_contact_id: mapped.contactId || currentLead.apollo_contact_id,
    headline: mapped.headline || currentLead.headline,
    department: mapped.department || currentLead.department,
    job_function: mapped.jobFunction || currentLead.job_function,
    seniority: mapped.seniority || currentLead.seniority,
    city: mapped.city || currentLead.city,
    state: mapped.state || currentLead.state,
    country: mapped.country || currentLead.country,
    email_status: mapped.emailStatus || currentLead.email_status,
    email_confidence: mapped.emailConfidence ?? currentLead.email_confidence,
    phone_numbers: mapped.phoneNumbers.length > 0 ? mapped.phoneNumbers : (currentLead.phone_numbers ?? []),
    employment_history: mapped.employmentHistory.length > 0 ? mapped.employmentHistory : (currentLead.employment_history ?? []),
    dnc_status: mapped.dncStatus || currentLead.dnc_status,
    email_unsubscribed: currentLead.email_unsubscribed === true || mapped.emailUnsubscribed,
    do_not_email: currentLead.do_not_email === true || mapped.emailUnsubscribed,
    do_not_call: currentLead.do_not_call === true || ['dnc', 'do_not_call', 'do-not-call'].includes(mapped.dncStatus.toLowerCase()),
    raw_data: person,
    last_apollo_enriched_at: new Date().toISOString(),
    context_refreshed_at: null,
    updated_at: new Date().toISOString(),
  };

  const firstPartyFields: Array<[string, unknown]> = [
    ['first_name', mapped.firstName],
    ['last_name', mapped.lastName],
    ['name', mapped.name],
    ['title', mapped.title],
    ['company', mapped.company],
    ['email', mapped.email],
    ['phone', mapped.phone],
    ['location', mapped.location],
    ['linkedin_url', mapped.linkedinUrl],
  ];

  for (const [field, value] of firstPartyFields) {
    if (!hasManualOverride(field) && value) patch[field] = value;
  }

  if (accountId) patch.account_id = accountId;
  return patch;
}

function accountLookup(organizationId: string, mapped: MappedApolloOrganization) {
  let query = supabase
    .from('accounts')
    .select('id')
    .eq('organization_id', organizationId);

  if (mapped.apolloOrganizationId) {
    query = query.eq('apollo_organization_id', mapped.apolloOrganizationId);
  } else if (mapped.normalizedDomain) {
    query = query.eq('normalized_domain', mapped.normalizedDomain);
  } else {
    return null;
  }

  return query.maybeSingle();
}

export async function upsertApolloAccount(organizationId: string, input: unknown): Promise<string | null> {
  const mapped = mapApolloOrganization(input);
  if (!mapped || (!mapped.apolloOrganizationId && !mapped.normalizedDomain)) return null;

  const now = new Date();
  const payload: JsonRecord = {
    organization_id: organizationId,
    apollo_organization_id: mapped.apolloOrganizationId,
    apollo_account_id: mapped.apolloAccountId,
    name: mapped.name,
    domain: mapped.domain,
    normalized_domain: mapped.normalizedDomain,
    website: mapped.website,
    linkedin_url: mapped.linkedinUrl,
    twitter_url: mapped.twitterUrl,
    facebook_url: mapped.facebookUrl,
    logo_url: mapped.logoUrl,
    industry: mapped.industry,
    industries: mapped.industries,
    keywords: mapped.keywords,
    description: mapped.description,
    raw_address: mapped.rawAddress,
    street_address: mapped.streetAddress,
    city: mapped.city,
    state: mapped.state,
    postal_code: mapped.postalCode,
    country: mapped.country,
    estimated_num_employees: mapped.estimatedNumEmployees,
    annual_revenue: mapped.annualRevenue,
    annual_revenue_printed: mapped.annualRevenuePrinted,
    total_funding: mapped.totalFunding,
    total_funding_printed: mapped.totalFundingPrinted,
    latest_funding_stage: mapped.latestFundingStage,
    funding_events: mapped.fundingEvents,
    technology_names: mapped.technologyNames,
    current_technologies: mapped.currentTechnologies,
    departmental_headcount: mapped.departmentalHeadcount,
    headcount_growth_six_months: mapped.headcountGrowthSixMonths,
    headcount_growth_twelve_months: mapped.headcountGrowthTwelveMonths,
    headcount_growth_twenty_four_months: mapped.headcountGrowthTwentyFourMonths,
    parent_apollo_organization_id: mapped.parentApolloOrganizationId,
    suborganizations: mapped.suborganizations,
    intent_summary: mapped.intentSummary,
    source: 'apollo',
    enrichment_status: 'completed',
    enrichment_error: null,
    last_enriched_at: now.toISOString(),
    next_refresh_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    raw_data: unwrapOrganization(input),
    updated_at: now.toISOString(),
  };

  // The foundation uses partial unique indexes so nullable Apollo identifiers
  // do not collide. Resolve the existing row first, then handle a concurrent
  // insert by re-reading the unique key after Postgres reports the conflict.
  const existingResult = await accountLookup(organizationId, mapped);
  if (existingResult?.error) throw new AppError(500, 'Failed to find existing Apollo account', existingResult.error);

  if (existingResult?.data?.id) {
    const { data, error } = await supabase
      .from('accounts')
      .update(payload)
      .eq('organization_id', organizationId)
      .eq('id', existingResult.data.id)
      .select('id')
      .single();
    if (error) throw new AppError(500, 'Failed to update Apollo account', error);
    return data.id;
  }

  const { data, error } = await supabase
    .from('accounts')
    .insert(payload)
    .select('id')
    .single();
  if (!error && data) return data.id;

  if (error?.code === '23505') {
    const concurrent = await accountLookup(organizationId, mapped);
    if (concurrent?.error) throw new AppError(500, 'Failed to reload concurrently created Apollo account', concurrent.error);
    if (concurrent?.data?.id) {
      const { data: updated, error: updateError } = await supabase
        .from('accounts')
        .update(payload)
        .eq('organization_id', organizationId)
        .eq('id', concurrent.data.id)
        .select('id')
        .single();
      if (updateError) throw new AppError(500, 'Failed to update concurrently created Apollo account', updateError);
      return updated.id;
    }
  }

  throw new AppError(500, 'Failed to save Apollo account', error);
}

export async function persistApolloPersonToLead(
  organizationId: string,
  leadId: string,
  person: ApolloPerson,
  organization?: unknown,
): Promise<{ accountId: string | null; lead: JsonRecord }> {
  const { data: currentLead, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('id', leadId)
    .single();
  if (leadError || !currentLead) throw new AppError(404, 'Lead not found while saving Apollo enrichment', leadError);

  const accountId = await upsertApolloAccount(organizationId, organization ?? person.organization);
  const patch = buildApolloLeadPatch(person, currentLead as ApolloLeadCurrent, accountId);
  const { data: lead, error } = await supabase
    .from('leads')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', leadId)
    .select('*')
    .single();
  if (error || !lead) throw new AppError(500, 'Failed to save enriched Apollo lead', error);

  return { accountId, lead: lead as JsonRecord };
}

export async function startApolloEnrichmentRun(input: {
  organizationId: string;
  leadId?: string | null;
  accountId?: string | null;
  enrichmentKind: ApolloRunKind;
  idempotencyKey: string;
  webhookExpected?: boolean;
}) {
  const now = new Date().toISOString();
  const record = {
    organization_id: input.organizationId,
    lead_id: input.leadId ?? null,
    account_id: input.accountId ?? null,
    enrichment_kind: input.enrichmentKind,
    idempotency_key: input.idempotencyKey,
    status: 'running',
    attempts: 1,
    webhook_expected: input.webhookExpected ?? false,
    requested_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase
    .from('apollo_enrichment_runs')
    .insert(record)
    .select('id,status,attempts')
    .single();
  if (!error && data) return data;

  if (error?.code !== '23505') throw new AppError(500, 'Failed to create Apollo enrichment run', error);

  const { data: existing, error: existingError } = await supabase
    .from('apollo_enrichment_runs')
    .select('id,status,attempts')
    .eq('organization_id', input.organizationId)
    .eq('idempotency_key', input.idempotencyKey)
    .single();
  if (existingError || !existing) throw new AppError(500, 'Failed to load existing Apollo enrichment run', existingError);

  const { data: retried, error: retryError } = await supabase
    .from('apollo_enrichment_runs')
    .update({
      lead_id: input.leadId ?? null,
      account_id: input.accountId ?? null,
      status: 'running',
      attempts: (existing.attempts ?? 0) + 1,
      webhook_expected: input.webhookExpected ?? false,
      error_code: null,
      error_message: null,
      requested_at: now,
      updated_at: now,
    })
    .eq('organization_id', input.organizationId)
    .eq('id', existing.id)
    .select('id,status,attempts')
    .single();
  if (retryError || !retried) throw new AppError(500, 'Failed to retry Apollo enrichment run', retryError);
  return retried;
}

export async function completeApolloEnrichmentRun(
  organizationId: string,
  runId: string,
  fields: {
    providerRequestId?: string | null;
    providerStatus?: string | null;
    status?: 'completed' | 'awaiting_webhook';
    creditCost?: number | null;
    rawPayload?: unknown;
    accountId?: string | null;
    webhookExpected?: boolean;
    webhookReceivedAt?: string | null;
  } = {},
) {
  const now = new Date().toISOString();
  const patch: JsonRecord = {
    status: fields.status ?? 'completed',
    completed_at: fields.status === 'awaiting_webhook' ? null : now,
    updated_at: now,
  };
  if ('providerRequestId' in fields) patch.provider_request_id = fields.providerRequestId;
  if ('providerStatus' in fields) patch.provider_status = fields.providerStatus;
  if ('creditCost' in fields) patch.credit_cost = fields.creditCost;
  if ('rawPayload' in fields) patch.raw_payload = fields.rawPayload;
  if ('accountId' in fields) patch.account_id = fields.accountId;
  if ('webhookExpected' in fields) patch.webhook_expected = fields.webhookExpected;
  if ('webhookReceivedAt' in fields) patch.webhook_received_at = fields.webhookReceivedAt;
  const { error } = await supabase
    .from('apollo_enrichment_runs')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', runId);
  if (error) throw new AppError(500, 'Failed to complete Apollo enrichment run', error);
}

export async function failApolloEnrichmentRun(
  organizationId: string,
  runId: string,
  errorCode: string,
  errorMessage: string,
  rawPayload?: unknown,
) {
  const { error } = await supabase
    .from('apollo_enrichment_runs')
    .update({
      status: 'failed',
      error_code: errorCode,
      error_message: errorMessage.slice(0, 1000),
      raw_payload: rawPayload ?? null,
      failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', organizationId)
    .eq('id', runId);
  if (error) console.error('[apollo] failed to mark enrichment run failed:', error.message);
}

export function buildApolloPersonMatchRequest(input: {
  apolloId?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  company?: string | null;
  domain?: string | null;
  linkedinUrl?: string | null;
}) {
  // Identifiers and request options come from the same builders the bulk path
  // uses, so a change to the waterfall or webhook contract cannot apply to one
  // path and silently miss the other.
  return {
    ...buildBulkMatchDetail(input),
    ...buildBulkMatchOptions(),
  };
}

export function apolloWebhookExpected() {
  return waterfallRequested();
}

export function hashApolloPayload(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function enrichOrganizationForPerson(
  person: ApolloPerson,
  context: ApolloRequestContext = {},
) {
  const embedded = asRecord(person.organization);
  const embeddedOrgId = firstString(embedded?.id, embedded?.organization_id, person.organization_id);
  const embeddedDomain = firstString(embedded?.primary_domain, embedded?.domain);
  const embeddedName = firstString(embedded?.name, person.organization_name);

  if (!embeddedOrgId && !embeddedDomain && !embeddedName) return embedded;

  const hasRichEmbeddedData = Boolean(embedded && [
    'industry',
    'industries',
    'keywords',
    'estimated_num_employees',
    'annual_revenue',
    'technology_names',
  ].some(key => embedded[key] != null));
  if (hasRichEmbeddedData) return embedded;

  try {
    if (embeddedDomain) {
      const response = await enrichApolloOrganization(
        { domain: normalizeApolloDomain(embeddedDomain) ?? embeddedDomain },
        context,
      );
      return unwrapOrganization(response) ?? embedded;
    }
    if (embeddedOrgId) {
      const response = await getApolloOrganization(embeddedOrgId, context);
      return unwrapOrganization(response) ?? embedded;
    }
    const response = await enrichApolloOrganization({ name: embeddedName as string }, context);
    return unwrapOrganization(response) ?? embedded;
  } catch (error) {
    console.warn('[apollo] organization enrichment unavailable; using embedded organization data:', error instanceof Error ? error.message : error);
    return embedded;
  }
}

export function personOrganization(person: ApolloPerson) {
  return asRecord(person.organization);
}

export function isApolloWebhookEnrichmentEnabled() {
  return Boolean(env.APOLLO_ENRICHMENT_WEBHOOK_URL) && apolloWebhookExpected();
}
