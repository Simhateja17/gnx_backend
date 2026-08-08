/**
 * Apollo import orchestration.
 *
 * Search, qualify, enrich in batches, re-qualify, then hand off to generation.
 *
 * The ordering is the point. Qualification runs twice: once on the search
 * result, to avoid spending an enrichment credit on a candidate that could
 * never qualify, and again after enrichment, when the facts are final. Context
 * is only scored after enrichment reaches a terminal state - scoring earlier
 * measures how long we waited rather than what Apollo actually has, and would
 * make a lead look thin while its facts were still in flight.
 */

import {
  APOLLO_IMPORT_TIMEOUT_MS,
  ONBOARDING_APOLLO_MAX_CANDIDATES,
  ONBOARDING_APOLLO_MAX_SEARCH_PAGES,
  ONBOARDING_ENRICHED_LEAD_TARGET,
} from '../config/constants';
import { searchApolloPeople } from '../lib/apollo';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import {
  completeApolloEnrichmentRun,
  failApolloEnrichmentRun,
  hashApolloPayload,
  mapApolloPerson,
  startApolloEnrichmentRun,
  upsertApolloAccount,
  type ApolloPerson,
} from './apollo-data.service';
import { bulkEnrichLeads, sweepStalledEnrichment, type EnrichableLead } from './apollo-bulk-enrichment.service';
import {
  evaluateContextReadiness,
  readinessToStoredIngredients,
  summarizeImportReadiness,
} from './context-readiness.service';
import {
  normalizeEmail,
  qualifyLeadOffline,
  searchEmailStatuses,
  type EmailQualificationPolicy,
  type RejectionReason,
} from './lead-qualification.service';
import {
  createImportRun,
  getImportRun,
  importRunExpired,
  resolveTerminalStatus,
  setImportRunStatus,
  updateImportRunCounters,
  type ImportRun,
  type ImportRunCounters,
} from './lead-import-run.service';

export type ApolloImportCriteria = {
  organizationId: string;
  campaignId?: string | null;
  titles?: string[];
  locations?: string[];
  companySizes?: string[];
  industries?: string[];
  keywords?: string;
  limit?: number;
  candidateCap?: number;
  timeoutMs?: number;
};

type JsonRecord = Record<string, unknown>;

function log(event: string, fields: JsonRecord) {
  console.log(JSON.stringify({ event, ...fields }));
}

export async function resolveQualificationPolicy(organizationId: string): Promise<EmailQualificationPolicy> {
  const { data } = await supabase
    .from('agent_configs')
    .select('email_qualification_policy')
    .eq('organization_id', organizationId)
    .maybeSingle();

  const policy = data?.email_qualification_policy;
  return policy === 'verified_or_likely' || policy === 'any' ? policy : 'verified';
}

// ---------------------------------------------------------------------------
// Candidate persistence
// ---------------------------------------------------------------------------

type CandidateResult = {
  insertedLeadIds: string[];
  reusedLeadIds: string[];
  duplicates: number;
  rejected: number;
  suppressed: number;
};

/**
 * Saves a page of Apollo people as leads.
 *
 * Candidates that already fail on what search returned are stored rejected
 * rather than dropped - a customer who asked for ten and got six is owed the
 * reason, and "5 generic inbox" tells them something about their targeting
 * that a silent shortfall does not.
 */
export async function persistApolloCandidates(input: {
  organizationId: string;
  campaignId?: string | null;
  importRunId?: string | null;
  people: ApolloPerson[];
  policy: EmailQualificationPolicy;
}): Promise<CandidateResult> {
  const { organizationId, campaignId, importRunId, people, policy } = input;

  const mapped = await Promise.all(people.map(async person => {
    let accountId: string | null = null;
    try {
      accountId = await upsertApolloAccount(organizationId, person.organization);
    } catch (error) {
      console.warn('[apollo-import] embedded organization save failed:', error instanceof Error ? error.message : error);
    }
    return { person, mapped: mapApolloPerson(person), accountId };
  }));

  const apolloIds = mapped.map(item => item.mapped.apolloId).filter(Boolean);
  const emails = mapped.map(item => normalizeEmail(item.mapped.email)).filter(Boolean) as string[];

  const existingByApolloId = new Map<string, { id: string; campaign_id: string | null }>();
  const existingByEmail = new Map<string, { id: string; campaign_id: string | null }>();

  // One query per key type rather than per candidate. Both are needed: a lead
  // imported by CSV has no Apollo id, and a person can appear under a new
  // Apollo id after changing jobs.
  for (const [column, values] of [['apollo_id', apolloIds], ['email', emails]] as const) {
    if (values.length === 0) continue;
    const { data, error } = await supabase
      .from('leads')
      .select('id,apollo_id,email,campaign_id')
      .eq('organization_id', organizationId)
      .in(column, values);

    if (error) throw new AppError(500, 'Failed to check existing Apollo leads', error);
    for (const row of data ?? []) {
      if (row.apollo_id) existingByApolloId.set(row.apollo_id, { id: row.id, campaign_id: row.campaign_id });
      if (row.email) existingByEmail.set(row.email, { id: row.id, campaign_id: row.campaign_id });
    }
  }

  const records: JsonRecord[] = [];
  const reusedLeadIds: string[] = [];
  const seenApolloIds = new Set<string>();
  const seenEmails = new Set<string>();
  let duplicates = 0;
  let rejected = 0;
  let suppressed = 0;

  for (const { person, mapped: contact, accountId } of mapped) {
    const apolloId = contact.apolloId || null;
    const email = normalizeEmail(contact.email);

    const existing = (apolloId ? existingByApolloId.get(apolloId) : undefined)
      ?? (email ? existingByEmail.get(email) : undefined);

    if (existing) {
      duplicates++;
      // A lead already in the workspace can join this campaign if it is
      // unattached, but must never be taken from a different campaign.
      if (campaignId && !existing.campaign_id) {
        const { error } = await supabase
          .from('leads')
          .update({
            campaign_id: campaignId,
            import_run_id: importRunId ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('organization_id', organizationId)
          .eq('id', existing.id);
        if (error) throw new AppError(500, 'Failed to attach an existing lead to the campaign', error);
        reusedLeadIds.push(existing.id);
      } else if (campaignId && existing.campaign_id === campaignId) {
        reusedLeadIds.push(existing.id);
      }
      continue;
    }

    // Duplicates within this same page, which the database lookup above cannot
    // see because none of them are stored yet.
    if ((apolloId && seenApolloIds.has(apolloId)) || (email && seenEmails.has(email))) {
      duplicates++;
      continue;
    }
    if (apolloId) seenApolloIds.add(apolloId);
    if (email) seenEmails.add(email);

    const verdict = qualifyLeadOffline({
      first_name: contact.firstName,
      last_name: contact.lastName,
      name: contact.name,
      title: contact.title,
      company: contact.company,
      email: contact.email,
      email_status: contact.emailStatus,
      apollo_id: contact.apolloId,
      do_not_email: contact.emailUnsubscribed,
      email_unsubscribed: contact.emailUnsubscribed,
      dnc_status: contact.dncStatus,
    }, policy);

    const preRejected = !verdict.qualified;
    if (preRejected) {
      rejected++;
      if (verdict.reason === 'suppressed' || verdict.reason === 'do_not_contact') suppressed++;
    }

    records.push({
      organization_id: organizationId,
      // A rejected candidate is never attached to a campaign - it must not be
      // selectable, and campaign membership is what makes a lead selectable.
      campaign_id: preRejected ? null : (campaignId ?? null),
      import_run_id: importRunId ?? null,
      source: 'apollo',
      apollo_id: contact.apolloId || null,
      apollo_contact_id: contact.contactId || null,
      first_name: contact.firstName || null,
      last_name: contact.lastName || null,
      name: contact.name || null,
      title: contact.title || null,
      company: contact.company || null,
      email,
      phone: contact.phone || null,
      location: contact.location || null,
      linkedin_url: contact.linkedinUrl || null,
      account_id: accountId,
      headline: contact.headline || null,
      department: contact.department || null,
      job_function: contact.jobFunction || null,
      seniority: contact.seniority || null,
      city: contact.city || null,
      state: contact.state || null,
      country: contact.country || null,
      email_status: contact.emailStatus || null,
      email_confidence: contact.emailConfidence,
      phone_numbers: contact.phoneNumbers,
      employment_history: contact.employmentHistory,
      dnc_status: contact.dncStatus || null,
      email_unsubscribed: contact.emailUnsubscribed,
      do_not_email: contact.emailUnsubscribed,
      do_not_call: ['dnc', 'do_not_call', 'do-not-call'].includes(contact.dncStatus.toLowerCase()),
      status: 'new',
      qualification_status: preRejected ? 'rejected' : 'pending',
      rejection_reason: preRejected ? (verdict as { reason: RejectionReason }).reason : null,
      // Pre-rejected candidates are never enriched: there is no point paying
      // for facts about someone we will never contact.
      enrichment_status: preRejected ? 'incomplete' : 'pending',
      raw_data: person,
      updated_at: new Date().toISOString(),
    });
  }

  if (records.length === 0) {
    return { insertedLeadIds: [], reusedLeadIds, duplicates, rejected, suppressed };
  }

  const { data: inserted, error } = await supabase
    .from('leads')
    .insert(records)
    .select('id,qualification_status');

  if (error) throw new AppError(500, 'Failed to save Apollo candidates', error);

  const insertedLeadIds = (inserted ?? [])
    .filter(row => row.qualification_status === 'pending')
    .map(row => row.id as string);

  return { insertedLeadIds, reusedLeadIds, duplicates, rejected, suppressed };
}

// ---------------------------------------------------------------------------
// Post-enrichment qualification and scoring
// ---------------------------------------------------------------------------

/**
 * Final judgement, once enrichment has stopped changing the facts.
 *
 * Returns the context scores of leads that qualified, so the import can report
 * whether the batch as a whole was rich or thin - a whole import averaging two
 * of ten is an ICP problem the customer can fix, where one thin lead is noise.
 */
export async function finalizeLeadQualification(input: {
  organizationId: string;
  leadIds: string[];
  policy: EmailQualificationPolicy;
}): Promise<{ qualified: number; rejected: number; scores: number[]; scoreMax: number }> {
  if (input.leadIds.length === 0) return { qualified: 0, rejected: 0, scores: [], scoreMax: 10 };

  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', input.organizationId)
    .in('id', input.leadIds);

  if (error) throw new AppError(500, 'Failed to load leads for qualification', error);

  const accountIds = [...new Set((leads ?? []).map(lead => lead.account_id).filter(Boolean))] as string[];
  const accounts = new Map<string, JsonRecord>();
  if (accountIds.length > 0) {
    const { data: accountRows } = await supabase
      .from('accounts')
      .select('*')
      .eq('organization_id', input.organizationId)
      .in('id', accountIds);
    for (const account of accountRows ?? []) accounts.set(account.id, account);
  }

  let qualified = 0;
  let rejected = 0;
  const scores: number[] = [];
  let scoreMax = 10;

  for (const lead of leads ?? []) {
    const verdict = qualifyLeadOffline(lead, input.policy);
    const readiness = evaluateContextReadiness(lead, lead.account_id ? accounts.get(lead.account_id) ?? null : null);
    scoreMax = readiness.scoreMax;

    // Required ingredients are part of the gate: without a name, title,
    // company and address there is nothing truthful to write.
    const passes = verdict.qualified && readiness.requiredMet;

    const patch: JsonRecord = {
      qualification_status: passes ? 'qualified' : 'rejected',
      rejection_reason: passes
        ? null
        : verdict.qualified
          ? 'missing_identity'
          : (verdict as { reason: RejectionReason }).reason,
      context_required_met: readiness.requiredMet,
      context_score: readiness.score,
      context_score_max: readiness.scoreMax,
      context_ingredients: readinessToStoredIngredients(readiness),
      updated_at: new Date().toISOString(),
    };

    // Detaching on rejection is what actually enforces ineligibility -
    // campaign membership is how a lead becomes selectable.
    if (!passes) patch.campaign_id = null;

    const { error: updateError } = await supabase
      .from('leads')
      .update(patch)
      .eq('organization_id', input.organizationId)
      .eq('id', lead.id);

    if (updateError) {
      console.error(`[apollo-import] failed to finalize lead ${lead.id}:`, updateError.message);
      continue;
    }

    if (passes) {
      qualified++;
      scores.push(readiness.score);
    } else {
      rejected++;
    }
  }

  return { qualified, rejected, scores, scoreMax };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function searchPage(input: {
  organizationId: string;
  campaignId?: string | null;
  importRunId: string;
  criteria: ApolloImportCriteria;
  policy: EmailQualificationPolicy;
  page: number;
  perPage: number;
}): Promise<ApolloPerson[]> {
  const body: JsonRecord = { page: input.page, per_page: input.perPage };
  const { criteria } = input;

  if (criteria.titles?.length) body.person_titles = criteria.titles;
  if (criteria.locations?.length) body.person_locations = criteria.locations;
  if (criteria.companySizes?.length) body.organization_num_employees_ranges = criteria.companySizes;
  if (criteria.industries?.length) body.q_organization_keyword_tags = criteria.industries;
  if (criteria.keywords) body.q_keywords = criteria.keywords;

  // Filter at search time so an unverifiable candidate never costs an
  // enrichment credit. Previously everything was enriched and the failures
  // discarded afterwards, having already been paid for.
  const statuses = searchEmailStatuses(input.policy);
  if (statuses.length > 0) body.contact_email_status = statuses;

  const run = await startApolloEnrichmentRun({
    organizationId: input.organizationId,
    enrichmentKind: 'people_search',
    idempotencyKey: `people_search:${input.importRunId}:${hashApolloPayload(body)}`,
  });

  try {
    const data = await searchApolloPeople(body, {
      organizationId: input.organizationId,
      campaignId: input.campaignId ?? null,
      enrichmentRunId: run.id,
    }) as { people?: ApolloPerson[]; contacts?: ApolloPerson[] };

    await completeApolloEnrichmentRun(input.organizationId, run.id, {
      providerStatus: 'completed',
      rawPayload: data,
    });

    return data.people ?? data.contacts ?? [];
  } catch (error) {
    await failApolloEnrichmentRun(
      input.organizationId,
      run.id,
      error instanceof AppError ? `apollo_${error.status}` : 'apollo_search_failed',
      error instanceof Error ? error.message : 'Apollo search failed',
    );
    throw error;
  }
}

/**
 * Runs a full import to completion.
 *
 * Always reaches a terminal state. `partial` is a legitimate outcome rather
 * than a failure: Apollo may simply not hold ten verified people matching a
 * given ICP, and saying so is more useful than an alarm.
 */
export async function runApolloImport(criteria: ApolloImportCriteria): Promise<ImportRun> {
  const organizationId = criteria.organizationId;
  const requestedLimit = Math.max(1, criteria.limit ?? ONBOARDING_ENRICHED_LEAD_TARGET);
  const candidateCap = Math.max(requestedLimit, criteria.candidateCap ?? ONBOARDING_APOLLO_MAX_CANDIDATES);
  const policy = await resolveQualificationPolicy(organizationId);

  const run = await createImportRun({
    organizationId,
    campaignId: criteria.campaignId,
    requestedLimit,
    candidateCap,
    searchCriteria: {
      titles: criteria.titles ?? [],
      locations: criteria.locations ?? [],
      companySizes: criteria.companySizes ?? [],
      industries: criteria.industries ?? [],
      keywords: criteria.keywords ?? '',
      emailQualificationPolicy: policy,
    },
    timeoutMs: criteria.timeoutMs ?? APOLLO_IMPORT_TIMEOUT_MS,
  });

  const deadlineAt = run.deadline_at ? new Date(run.deadline_at) : null;
  const counters: ImportRunCounters = {
    candidatesFound: 0,
    candidatesAttempted: 0,
    qualifiedCount: 0,
    duplicateCount: 0,
    suppressedCount: 0,
    rejectedCount: 0,
    pendingCount: 0,
    failedCount: 0,
    pagesSearched: 0,
  };
  const contextScores: number[] = [];
  let scoreMax = 10;

  log('apollo_import_started', {
    importRunId: run.id,
    organizationId,
    campaignId: criteria.campaignId ?? null,
    requestedLimit,
    candidateCap,
    policy,
  });

  try {
    await setImportRunStatus(organizationId, run.id, 'searching');

    for (let page = 1; page <= ONBOARDING_APOLLO_MAX_SEARCH_PAGES; page++) {
      if (counters.qualifiedCount >= requestedLimit) break;
      if (counters.candidatesAttempted >= candidateCap) break;
      if (deadlineAt && Date.now() >= deadlineAt.getTime()) break;

      const remainingCandidates = candidateCap - counters.candidatesAttempted;
      const perPage = Math.max(1, Math.min(100, remainingCandidates));

      const people = await searchPage({
        organizationId,
        campaignId: criteria.campaignId,
        importRunId: run.id,
        criteria,
        policy,
        page,
        perPage,
      });

      counters.pagesSearched = page;
      counters.candidatesFound += people.length;
      log('apollo_search_page_completed', { importRunId: run.id, page, returned: people.length });

      if (people.length === 0) break;

      const saved = await persistApolloCandidates({
        organizationId,
        campaignId: criteria.campaignId,
        importRunId: run.id,
        people,
        policy,
      });

      counters.duplicateCount += saved.duplicates;
      counters.rejectedCount += saved.rejected;
      counters.suppressedCount += saved.suppressed;
      counters.candidatesAttempted += saved.insertedLeadIds.length;

      const pendingLeadIds = [...saved.insertedLeadIds, ...saved.reusedLeadIds];
      counters.pendingCount = pendingLeadIds.length;
      await updateImportRunCounters(organizationId, run.id, counters);

      if (pendingLeadIds.length === 0) continue;

      await setImportRunStatus(organizationId, run.id, 'enriching');

      const { data: enrichable } = await supabase
        .from('leads')
        .select('id,apollo_id,email,first_name,last_name,name,company,linkedin_url,account_id')
        .eq('organization_id', organizationId)
        .in('id', pendingLeadIds)
        .eq('enrichment_status', 'pending');

      const { outcomes } = await bulkEnrichLeads({
        organizationId,
        campaignId: criteria.campaignId,
        importRunId: run.id,
        leads: (enrichable ?? []) as EnrichableLead[],
        deadlineAt,
      });

      counters.failedCount += outcomes.filter(outcome => outcome.status === 'failed').length;

      // Anything still awaiting a webhook that will never come. Without this a
      // lead sits pending forever and the campaign quietly never finishes.
      await sweepStalledEnrichment(organizationId, pendingLeadIds);

      const finalized = await finalizeLeadQualification({
        organizationId,
        leadIds: pendingLeadIds,
        policy,
      });

      counters.qualifiedCount += finalized.qualified;
      counters.rejectedCount += finalized.rejected;
      counters.pendingCount = 0;
      contextScores.push(...finalized.scores);
      scoreMax = finalized.scoreMax;

      await updateImportRunCounters(organizationId, run.id, counters);
      log('apollo_import_page_finalized', {
        importRunId: run.id,
        page,
        qualified: counters.qualifiedCount,
        rejected: counters.rejectedCount,
      });
    }

    const readiness = summarizeImportReadiness(contextScores, scoreMax);
    const expired = Boolean(deadlineAt && Date.now() >= deadlineAt.getTime());
    const status = resolveTerminalStatus({
      qualified: counters.qualifiedCount,
      requested: requestedLimit,
      expired,
    });

    await updateImportRunCounters(organizationId, run.id, counters);
    await setImportRunStatus(organizationId, run.id, status, {
      averageContextScore: readiness.averageScore,
      progressMetadata: {
        contextReadiness: readiness,
        emailQualificationPolicy: policy,
      },
    });

    log('apollo_import_completed', {
      importRunId: run.id,
      status,
      qualified: counters.qualifiedCount,
      requested: requestedLimit,
      averageContextScore: readiness.averageScore,
      contextVerdict: readiness.verdict,
    });

    const finalRun = await getImportRun(organizationId, run.id);
    return finalRun ?? run;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Apollo import failed';
    const expired = importRunExpired(run);

    await updateImportRunCounters(organizationId, run.id, counters);
    await setImportRunStatus(organizationId, run.id, expired ? 'timed_out' : 'failed', { error: message });

    log('apollo_import_failed', { importRunId: run.id, error: message, timedOut: expired });
    throw error;
  }
}
