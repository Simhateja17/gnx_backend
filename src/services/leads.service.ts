import { supabase } from '../lib/supabase';
import { redis } from '../lib/redis';
import { AppError } from '../types';
import { mapRow } from '../lib/csv-parser';
import { sendEmail } from './email.service';
import { enqueueInitialEmailStepIfActive } from './campaigns.service';
import { APOLLO_ENRICHMENT_CAP } from '../config/constants';
import { matchApolloPerson, searchApolloPeople } from '../lib/apollo';
import {
  apolloWebhookExpected,
  buildApolloPersonMatchRequest,
  completeApolloEnrichmentRun,
  enrichOrganizationForPerson,
  failApolloEnrichmentRun,
  hashApolloPayload,
  mapApolloPerson,
  persistApolloPersonToLead,
  startApolloEnrichmentRun,
  upsertApolloAccount,
} from './apollo-data.service';
import type { ApolloEnrichInput, ApolloSearchInput, CsvUploadInput, LeadCreateInput } from '../schemas/leads.schema';
import type { CsvImportJobData, CsvImportProgress } from '../jobs/csv-import.job';
import type { ApolloPerson } from './apollo-data.service';

type LeadRow = {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  source: 'apollo' | 'csv' | 'manual';
  apollo_id: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  timezone: string | null;
  score: number | null;
  status: string;
  raw_data: Record<string, unknown> | null;
  account_id?: string | null;
  apollo_contact_id?: string | null;
  headline?: string | null;
  department?: string | null;
  job_function?: string | null;
  seniority?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  email_status?: string | null;
  email_confidence?: number | null;
  phone_numbers?: Array<Record<string, unknown>> | null;
  employment_history?: Array<Record<string, unknown>> | null;
  dnc_status?: string | null;
  email_unsubscribed?: boolean;
  do_not_email?: boolean;
  do_not_call?: boolean;
  last_apollo_enriched_at?: string | null;
  context_refreshed_at?: string | null;
  created_at: string;
  updated_at: string;
};

const STOP_SEQUENCE_STATUSES = ['engaged', 'meeting_booked', 'not_interested', 'unsubscribed'];

const LEAD_COLUMNS = [
  'id',
  'organization_id',
  'campaign_id',
  'source',
  'apollo_id',
  'first_name',
  'last_name',
  'name',
  'title',
  'company',
  'email',
  'phone',
  'location',
  'linkedin_url',
  'timezone',
  'score',
  'status',
  'raw_data',
  'account_id',
  'apollo_contact_id',
  'headline',
  'department',
  'job_function',
  'seniority',
  'city',
  'state',
  'country',
  'email_status',
  'email_confidence',
  'phone_numbers',
  'employment_history',
  'dnc_status',
  'email_unsubscribed',
  'do_not_email',
  'do_not_call',
  'last_apollo_enriched_at',
  'context_refreshed_at',
  'created_at',
  'updated_at',
].join(',');

function clean(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toApiLead(row: LeadRow) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    source: row.source,
    apolloId: row.apollo_id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.name,
    title: row.title,
    company: row.company,
    email: row.email,
    phone: row.phone,
    location: row.location,
    linkedinUrl: row.linkedin_url,
    score: row.score ?? 0,
    status: row.status,
    createdAt: row.created_at,
    rawData: row.raw_data,
    accountId: row.account_id ?? null,
    apolloContactId: row.apollo_contact_id ?? null,
    headline: row.headline ?? null,
    department: row.department ?? null,
    jobFunction: row.job_function ?? null,
    seniority: row.seniority ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    country: row.country ?? null,
    emailStatus: row.email_status ?? null,
    emailConfidence: row.email_confidence ?? null,
    phoneNumbers: row.phone_numbers ?? [],
    employmentHistory: row.employment_history ?? [],
    dncStatus: row.dnc_status ?? null,
    emailUnsubscribed: row.email_unsubscribed ?? false,
    doNotEmail: row.do_not_email ?? false,
    doNotCall: row.do_not_call ?? false,
    lastApolloEnrichedAt: row.last_apollo_enriched_at ?? null,
    contextRefreshedAt: row.context_refreshed_at ?? null,
  };
}

function toLeadRecord(orgId: string, input: LeadCreateInput, rawData?: Record<string, unknown>) {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  const name = clean(input.name) ?? ([firstName, lastName].filter(Boolean).join(' ') || null);

  return {
    organization_id: orgId,
    campaign_id: input.campaignId ?? null,
    source: input.source,
    apollo_id: clean(input.apolloId),
    first_name: firstName,
    last_name: lastName,
    name,
    title: clean(input.title),
    company: clean(input.company),
    email: clean(input.email),
    phone: clean(input.phone),
    location: clean(input.location),
    linkedin_url: clean(input.linkedinUrl),
    status: 'new',
    raw_data: rawData ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function listLeads(orgId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw new AppError(500, 'Failed to fetch leads', error);
  return { items: ((data ?? []) as unknown as LeadRow[]).map(toApiLead) };
}

export async function createLead(orgId: string, input: LeadCreateInput) {
  const { data, error } = await supabase
    .from('leads')
    .insert(toLeadRecord(orgId, input))
    .select(LEAD_COLUMNS)
    .single();

  if (error) throw new AppError(500, 'Failed to create lead', error);

  if (input.campaignId) {
    await enqueueInitialEmailStepIfActive(orgId, input.campaignId);
  }

  return toApiLead(data as unknown as LeadRow);
}

async function saveApolloPeople(orgId: string, input: ApolloSearchInput, people: ApolloPerson[]) {
  const mappedPeople = await Promise.all(people.map(async person => {
    let accountId: string | null = null;
    try {
      accountId = await upsertApolloAccount(orgId, person.organization);
    } catch (error) {
      console.warn('[apollo-search] failed to persist embedded organization:', error instanceof Error ? error.message : error);
    }
    return { person, mapped: mapApolloPerson(person), accountId };
  }));
  const apolloIds = mappedPeople.map(({ mapped }) => clean(mapped.apolloId)).filter(Boolean) as string[];
  const emails = mappedPeople.map(({ mapped }) => clean(mapped.email)).filter(Boolean) as string[];
  const existingApolloIds = new Set<string>();
  const existingEmails = new Set<string>();

  if (apolloIds.length > 0) {
    const { data, error } = await supabase
      .from('leads')
      .select('apollo_id')
      .eq('organization_id', orgId)
      .in('apollo_id', apolloIds);

    if (error) throw new AppError(500, 'Failed to check existing Apollo leads', error);
    for (const row of data ?? []) {
      if (row.apollo_id) existingApolloIds.add(row.apollo_id);
    }
  }

  if (emails.length > 0) {
    const { data, error } = await supabase
      .from('leads')
      .select('email')
      .eq('organization_id', orgId)
      .in('email', emails);

    if (error) throw new AppError(500, 'Failed to check existing Apollo leads', error);
    for (const row of data ?? []) {
      if (row.email) existingEmails.add(row.email);
    }
  }

  const records = [] as Array<Record<string, unknown>>;
  for (const { person, mapped, accountId } of mappedPeople) {
    const apolloId = clean(mapped.apolloId);
    const email = clean(mapped.email);
    if ((apolloId && existingApolloIds.has(apolloId)) || (email && existingEmails.has(email))) continue;
    if (apolloId) existingApolloIds.add(apolloId);
    if (email) existingEmails.add(email);

    records.push({
      ...toLeadRecord(
        orgId,
        {
          campaignId: input.campaignId,
          source: 'apollo',
          apolloId: mapped.apolloId,
          firstName: mapped.firstName,
          lastName: mapped.lastName,
          name: mapped.name,
          title: mapped.title,
          company: mapped.company,
          email: mapped.email,
          phone: mapped.phone,
          location: mapped.location,
          linkedinUrl: mapped.linkedinUrl,
        },
        person,
      ),
      account_id: accountId,
      apollo_contact_id: mapped.contactId || null,
      headline: mapped.headline || null,
      department: mapped.department || null,
      job_function: mapped.jobFunction || null,
      seniority: mapped.seniority || null,
      city: mapped.city || null,
      state: mapped.state || null,
      country: mapped.country || null,
      email_status: mapped.emailStatus || null,
      email_confidence: mapped.emailConfidence,
      phone_numbers: mapped.phoneNumbers,
      employment_history: mapped.employmentHistory,
      dnc_status: mapped.dncStatus || null,
      email_unsubscribed: mapped.emailUnsubscribed,
      do_not_email: mapped.emailUnsubscribed,
      do_not_call: ['dnc', 'do_not_call', 'do-not-call'].includes(mapped.dncStatus.toLowerCase()),
    });
  }

  if (records.length === 0) return { saved: [], inserted: 0, skipped: mappedPeople.length };

  const { data, error } = await supabase
    .from('leads')
    .insert(records)
    .select(LEAD_COLUMNS);

  if (error) throw new AppError(500, 'Failed to save Apollo leads', error);

  if (input.campaignId && (data?.length ?? 0) > 0) {
    await enqueueInitialEmailStepIfActive(orgId, input.campaignId);
  }

  return {
    saved: ((data ?? []) as unknown as LeadRow[]).map(toApiLead),
    inserted: data?.length ?? 0,
    skipped: mappedPeople.length - (data?.length ?? 0),
  };
}

export async function searchApollo(orgId: string, input: ApolloSearchInput) {
  const body: Record<string, unknown> = {
    page: input.page,
    per_page: input.perPage,
  };

  if (input.titles.length > 0) body.person_titles = input.titles;
  if (input.locations.length > 0) body.person_locations = input.locations;
  if (input.companySizes.length > 0) body.organization_num_employees_ranges = input.companySizes;
  if (input.keywords) body.q_keywords = input.keywords;

  const run = await startApolloEnrichmentRun({
    organizationId: orgId,
    enrichmentKind: 'people_search',
    idempotencyKey: `people_search:${hashApolloPayload(body)}`,
  });

  try {
    const data = await searchApolloPeople(body) as {
    people?: ApolloPerson[];
    contacts?: ApolloPerson[];
    pagination?: { page?: number; per_page?: number; total_entries?: number; total_pages?: number };
    };
    const people = data.people ?? data.contacts ?? [];
    const saved = await saveApolloPeople(orgId, input, people);
    await completeApolloEnrichmentRun(orgId, run.id, {
      providerStatus: 'completed',
      creditCost: 0,
      rawPayload: data,
    });

    return {
      items: saved.saved.length > 0 ? saved.saved : people.map(mapApolloPerson),
      inserted: saved.inserted,
      skipped: saved.skipped,
      pagination: data.pagination ?? {
        page: input.page,
        perPage: input.perPage,
        totalEntries: people.length,
      },
    };
  } catch (error) {
    await failApolloEnrichmentRun(
      orgId,
      run.id,
      error instanceof AppError ? `apollo_${error.status}` : 'apollo_search_failed',
      error instanceof Error ? error.message : 'Apollo search failed',
    );
    throw error;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\//i;

export async function uploadCsvLeads(orgId: string, input: CsvUploadInput) {
  const records: ReturnType<typeof toLeadRecord>[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  input.rows.forEach((row, index) => {
    if (row.email && !EMAIL_PATTERN.test(row.email)) {
      errors.push({ row: index + 1, message: `Invalid email format: "${row.email}"` });
      return;
    }
    if (row.linkedinUrl && !URL_PATTERN.test(row.linkedinUrl)) {
      errors.push({ row: index + 1, message: `Invalid LinkedIn URL: "${row.linkedinUrl}"` });
      return;
    }
    if (!row.name && !row.firstName && !row.lastName && !row.email && !row.company) {
      errors.push({ row: index + 1, message: 'Row has no identifiable data (no name, email, or company)' });
      return;
    }

    records.push(toLeadRecord(
      orgId,
      {
        campaignId: input.campaignId,
        source: 'csv',
        firstName: row.firstName,
        lastName: row.lastName,
        name: row.name,
        title: row.title,
        company: row.company,
        email: row.email,
        phone: row.phone,
        location: row.location,
        linkedinUrl: row.linkedinUrl,
      },
      row.rawData
    ));
  });

  if (records.length === 0) {
    return { inserted: 0, skipped: errors.length, errors, items: [] };
  }

  const { data, error } = await supabase
    .from('leads')
    .insert(records)
    .select(LEAD_COLUMNS);

  if (error) throw new AppError(500, 'Failed to upload CSV leads', error);

  if (input.campaignId && (data?.length ?? 0) > 0) {
    await enqueueInitialEmailStepIfActive(orgId, input.campaignId);
  }

  return {
    inserted: data?.length ?? 0,
    skipped: errors.length,
    errors,
    items: ((data ?? []) as unknown as LeadRow[]).map(toApiLead),
  };
}

export async function deleteLead(orgId: string, id: string) {
  const { data, error } = await supabase
    .from('leads')
    .delete()
    .eq('organization_id', orgId)
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to delete lead', error);
  if (!data) throw new AppError(404, 'Lead not found');
  return { success: true };
}

// Apollo enrichment calls are real, billed API requests. Cap them per campaign
// (or per org, for leads with no campaign) at whichever is smaller: the
// campaign's own max_leads or the platform-wide APOLLO_ENRICHMENT_CAP, so a
// misconfigured campaign can't exceed the cost-control assumption in the PRD.
export async function checkApolloEnrichmentCap(orgId: string, campaignId: string | null) {
  let cap: number = APOLLO_ENRICHMENT_CAP;

  if (campaignId) {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('max_leads')
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .maybeSingle();
    if (campaign?.max_leads) cap = Math.min(campaign.max_leads, APOLLO_ENRICHMENT_CAP);
  }

  let query = supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .not('last_apollo_enriched_at', 'is', null);
  query = campaignId ? query.eq('campaign_id', campaignId) : query.is('campaign_id', null);

  const { count, error } = await query;
  if (error) throw new AppError(500, 'Failed to check Apollo enrichment cap', error);

  if ((count ?? 0) >= cap) {
    throw new AppError(429, `Apollo enrichment cap reached (${cap} leads) for this ${campaignId ? 'campaign' : 'organization'}`);
  }
}

export async function enrichLead(orgId: string, input: ApolloEnrichInput) {
  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('organization_id', orgId)
    .eq('id', input.leadId)
    .single();

  if (fetchError || !lead) throw new AppError(404, 'Lead not found');

  const row = lead as unknown as LeadRow;
  await checkApolloEnrichmentCap(orgId, row.campaign_id);

  const enrichBody = buildApolloPersonMatchRequest({
    apolloId: row.apollo_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.name,
    company: row.company,
    linkedinUrl: row.linkedin_url,
  });
  if (Object.keys(enrichBody).filter(key => !['reveal_personal_emails', 'reveal_phone_number', 'run_waterfall_email', 'run_waterfall_phone', 'webhook_url'].includes(key)).length === 0) {
    throw new AppError(400, 'Lead has no identifiers for enrichment (need email, apollo_id, or name+company)');
  }

  const run = await startApolloEnrichmentRun({
    organizationId: orgId,
    leadId: input.leadId,
    accountId: row.account_id,
    enrichmentKind: 'person_match',
    idempotencyKey: `person_match:${input.leadId}:${hashApolloPayload(enrichBody)}`,
    webhookExpected: apolloWebhookExpected(),
  });

  try {
    const result = await matchApolloPerson(enrichBody) as {
      person?: ApolloPerson;
      request_id?: string;
      waterfall?: Record<string, unknown>;
    };
    const person = result.person;

    if (!person) {
      await failApolloEnrichmentRun(orgId, run.id, 'no_match', 'No enrichment data found for this lead', result);
      await supabase
        .from('leads')
        .update({ status: 'enrichment_failed', updated_at: new Date().toISOString() })
        .eq('id', input.leadId)
        .eq('organization_id', orgId);
      throw new AppError(404, 'No enrichment data found for this lead');
    }

    const organization = await enrichOrganizationForPerson(person);
    const persisted = await persistApolloPersonToLead(orgId, input.leadId, person, organization);
    await completeApolloEnrichmentRun(orgId, run.id, {
      providerRequestId: result.request_id == null ? null : String(result.request_id),
      providerStatus: result.waterfall?.status ? String(result.waterfall.status) : 'completed',
      status: apolloWebhookExpected() ? 'awaiting_webhook' : 'completed',
      accountId: persisted.accountId,
      rawPayload: { person: result, organization },
      webhookExpected: apolloWebhookExpected(),
    });

    return toApiLead(persisted.lead as unknown as LeadRow);
  } catch (error) {
    if (!(error instanceof AppError && error.status === 404)) {
      await failApolloEnrichmentRun(
        orgId,
        run.id,
        error instanceof AppError ? `apollo_${error.status}` : 'apollo_person_match_failed',
        error instanceof Error ? error.message : 'Apollo person enrichment failed',
      );
    }
    throw error;
  }
}

export async function sendLeadNow(orgId: string, id: string) {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select(`${LEAD_COLUMNS}, campaigns(id,channel,status)`)
    .eq('organization_id', orgId)
    .eq('id', id)
    .maybeSingle();

  if (leadError) throw new AppError(500, 'Failed to fetch lead for immediate send', leadError);
  if (!lead) throw new AppError(404, 'Lead not found');

  const row = lead as unknown as LeadRow & { campaigns?: { channel?: string; status?: string } | null };
  if (!row.email) throw new AppError(400, 'Lead has no email address');
  if (!row.campaign_id) throw new AppError(400, 'Lead is not attached to a campaign');
  if (STOP_SEQUENCE_STATUSES.includes(row.status)) {
    throw new AppError(400, `Lead status is ${row.status}; sequence is stopped for this lead`);
  }
  if (row.campaigns?.channel && !['email', 'both'].includes(row.campaigns.channel)) {
    throw new AppError(400, 'Immediate send is only available for campaigns that use email');
  }

  const { data: alreadySent, error: sentCheckError } = await supabase
    .from('email_messages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('campaign_id', row.campaign_id)
    .eq('lead_id', id)
    .eq('step_number', 1)
    .eq('status', 'sent')
    .limit(1)
    .maybeSingle();

  if (sentCheckError) throw new AppError(500, 'Failed to check existing sent email', sentCheckError);
  if (alreadySent) throw new AppError(409, 'Step 1 email has already been sent to this lead');

  const { data: reusableMessage, error: reusableError } = await supabase
    .from('email_messages')
    .select('id,status')
    .eq('organization_id', orgId)
    .eq('campaign_id', row.campaign_id)
    .eq('lead_id', id)
    .eq('step_number', 1)
    .in('status', ['queued', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (reusableError) throw new AppError(500, 'Failed to find queued email message', reusableError);

  let emailMessageId = reusableMessage?.id;
  if (!emailMessageId) {
    const { data: firstStep, error: stepError } = await supabase
      .from('email_sequence_steps')
      .select('id')
      .eq('campaign_id', row.campaign_id)
      .eq('step_number', 1)
      .maybeSingle();

    if (stepError) throw new AppError(500, 'Failed to fetch first campaign email step', stepError);

    const { data: message, error: messageError } = await supabase
      .from('email_messages')
      .insert({
        organization_id: orgId,
        campaign_id: row.campaign_id,
        lead_id: id,
        sequence_step_id: firstStep?.id ?? null,
        step_number: 1,
        subject: '',
        body: '',
        status: 'queued',
      })
      .select('id')
      .single();

    if (messageError || !message) throw new AppError(500, 'Failed to create email message for immediate send', messageError);
    emailMessageId = message.id;
  } else if (reusableMessage?.status === 'failed') {
    await supabase
      .from('email_messages')
      .update({ status: 'queued' })
      .eq('organization_id', orgId)
      .eq('id', emailMessageId);
  }

  await supabase
    .from('leads')
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('id', id)
    .in('status', ['new', 'enrichment_failed']);

  const sendResult = await sendEmail(emailMessageId, orgId);
  if (!sendResult.success) {
    throw new AppError(429, sendResult.reason ?? 'Email was not sent', sendResult);
  }

  const { data: updated, error: updatedError } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('organization_id', orgId)
    .eq('id', id)
    .single();

  if (updatedError) throw new AppError(500, 'Email sent, but failed to reload lead', updatedError);

  return {
    success: true,
    emailMessageId,
    gmailMessageId: sendResult.gmailMessageId,
    lead: toApiLead(updated as unknown as LeadRow),
  };
}

export async function enrichLeads(
  organizationId: string,
  leadIds: string[],
  campaignId: string,
) {
  await checkApolloEnrichmentCap(organizationId, campaignId || null);

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email, first_name, last_name, name, company, apollo_id, linkedin_url, account_id')
    .eq('organization_id', organizationId)
    .in('id', leadIds);

  if (error) throw new AppError(500, 'Failed to fetch leads for enrichment');
  if (!leads || leads.length === 0) return { enriched: 0 };

  let enriched = 0;

  for (const lead of leads) {
    if (!lead.email && !lead.apollo_id && !lead.name && !(lead.first_name || lead.last_name)) continue;

    let run: { id: string } | null = null;

    try {
      await checkApolloEnrichmentCap(organizationId, campaignId || null);
      const enrichBody = buildApolloPersonMatchRequest({
        apolloId: lead.apollo_id,
        email: lead.email,
        firstName: lead.first_name,
        lastName: lead.last_name,
        name: lead.name,
        company: lead.company,
        linkedinUrl: lead.linkedin_url,
      });
      run = await startApolloEnrichmentRun({
        organizationId,
        leadId: lead.id,
        accountId: lead.account_id,
        enrichmentKind: 'person_match',
        idempotencyKey: `person_match:${lead.id}:${hashApolloPayload(enrichBody)}`,
        webhookExpected: apolloWebhookExpected(),
      });

      const data = await matchApolloPerson(enrichBody) as { person?: ApolloPerson; request_id?: string };
      const person = data.person;
      if (!person) {
        if (run) await failApolloEnrichmentRun(organizationId, run.id, 'no_match', 'No enrichment data found', data);
        continue;
      }

      const persisted = await persistApolloPersonToLead(organizationId, lead.id, person, person.organization);
      if (run) {
        await completeApolloEnrichmentRun(organizationId, run.id, {
          providerRequestId: data.request_id == null ? null : String(data.request_id),
          status: apolloWebhookExpected() ? 'awaiting_webhook' : 'completed',
          accountId: persisted.accountId,
          rawPayload: data,
          webhookExpected: apolloWebhookExpected(),
        });
      }
      enriched++;
    } catch (err: any) {
      console.error(`[enrich-leads] Error enriching lead ${lead.id}:`, err.message);
      if (run) await failApolloEnrichmentRun(organizationId, run.id, 'worker_error', err.message ?? 'Apollo enrichment failed');
      await supabase
        .from('leads')
        .update({ status: 'enrichment_failed', updated_at: new Date().toISOString() })
        .eq('id', lead.id);
    }
  }

  return { enriched };
}

export async function listLeadsFiltered(orgId: string, filters: {
  search?: string;
  status?: string;
  source?: string;
  campaignId?: string;
  page?: number;
  perPage?: number;
}) {
  const page = filters.page ?? 1;
  const perPage = filters.perPage ?? 50;
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let query = supabase
    .from('leads')
    .select(LEAD_COLUMNS, { count: 'exact' })
    .eq('organization_id', orgId);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.source) {
    query = query.eq('source', filters.source);
  }
  if (filters.campaignId) {
    query = query.eq('campaign_id', filters.campaignId);
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    query = query.or(`name.ilike.${term},email.ilike.${term},company.ilike.${term},first_name.ilike.${term},last_name.ilike.${term}`);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError(500, 'Failed to fetch leads', error);

  return {
    items: ((data ?? []) as unknown as LeadRow[]).map(toApiLead),
    pagination: {
      page,
      perPage,
      total: count ?? 0,
    },
  };
}

const PROGRESS_TTL = 3600;

function progressKey(jobId: string) {
  return `csv-import:${jobId}:progress`;
}

export async function setCsvImportProgress(jobId: string, progress: CsvImportProgress) {
  await redis.set(progressKey(jobId), JSON.stringify(progress), 'EX', PROGRESS_TTL);
}

export async function getCsvImportProgress(jobId: string): Promise<CsvImportProgress | null> {
  const raw = await redis.get(progressKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw);
}

const BATCH_SIZE = 50;

export async function processCsvImportJob(jobId: string, data: CsvImportJobData) {
  const { organizationId, campaignId, columnMapping, rows, totalRows, fileName } = data;

  const progress: CsvImportProgress = {
    status: 'processing',
    total: totalRows,
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
    fileName,
  };
  await setCsvImportProgress(jobId, progress);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const records: ReturnType<typeof toLeadRecord>[] = [];

    for (let j = 0; j < batch.length; j++) {
      const rowIndex = i + j + 2;
      const mapped = mapRow(batch[j], columnMapping);

      if (!mapped.email && !mapped.name && !mapped.firstName && !mapped.lastName) {
        progress.errors.push({ row: rowIndex, message: 'Row has no identifiable data (no email or name)' });
        progress.skipped++;
        progress.processed++;
        continue;
      }

      records.push(toLeadRecord(organizationId, {
        campaignId: campaignId,
        source: 'csv',
        firstName: mapped.firstName,
        lastName: mapped.lastName,
        name: mapped.name,
        title: mapped.title,
        company: mapped.company,
        email: mapped.email,
        phone: mapped.phone,
        location: mapped.location,
        linkedinUrl: mapped.linkedinUrl,
      }, batch[j] as unknown as Record<string, unknown>));
    }

    if (records.length > 0) {
      const { data: inserted, error } = await supabase
        .from('leads')
        .insert(records)
        .select('id');

      if (error) {
        for (let j = 0; j < records.length; j++) {
          progress.errors.push({
            row: i + j + 2,
            message: error.message || 'Database insert failed',
          });
        }
        progress.skipped += records.length;
      } else {
        progress.inserted += inserted?.length ?? 0;
      }
    }

    progress.processed = Math.min(i + batch.length, totalRows);
    await setCsvImportProgress(jobId, progress);
  }

  progress.status = 'completed';
  progress.processed = totalRows;
  await setCsvImportProgress(jobId, progress);
  return progress;
}
