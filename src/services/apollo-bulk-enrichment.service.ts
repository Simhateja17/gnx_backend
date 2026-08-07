/**
 * Batched Apollo enrichment.
 *
 * Replaces the one-lead-at-a-time loop that made a ten lead import into twenty
 * sequential round trips. Ten contacts per bulk_match call, three calls in
 * flight, refilled as each finishes.
 *
 * Two things this must get right:
 *
 *   Index alignment. Apollo returns `matches` positionally and puts null in a
 *   slot it could not match, so results are zipped back by index. Assuming a
 *   dense array here would silently attach one person's enrichment to a
 *   different person's lead - the exact identity corruption the spec's
 *   canonical-identity rule exists to prevent.
 *
 *   Rate limits. A 429 fails one batch, not the import. The batch backs off
 *   and retries; only a repeated failure is recorded against those leads.
 */

import {
  APOLLO_BULK_BATCH_SIZE,
  APOLLO_BULK_CONCURRENCY,
  APOLLO_LEAD_ENRICHMENT_TIMEOUT_MS,
} from '../config/constants';
import { bulkMatchApolloPeople } from '../lib/apollo';
import type { ApolloRequestContext } from '../lib/apollo';
import { chunk, mapWithConcurrency } from '../lib/concurrency';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import {
  apolloWebhookExpected,
  completeApolloEnrichmentRun,
  enrichOrganizationForPerson,
  failApolloEnrichmentRun,
  hashApolloPayload,
  persistApolloPersonToLead,
  startApolloEnrichmentRun,
  type ApolloPerson,
} from './apollo-data.service';
import { buildBulkMatchOptions, buildBulkMatchDetail } from './apollo-request.service';

export type EnrichableLead = {
  id: string;
  apollo_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  company: string | null;
  linkedin_url: string | null;
  account_id: string | null;
};

export type BulkEnrichmentOutcome = {
  leadId: string;
  status: 'enriched' | 'awaiting_webhook' | 'no_match' | 'failed';
  error?: string;
};

const RATE_LIMIT_BACKOFF_MS = 5_000;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function markLeadEnrichmentState(
  organizationId: string,
  leadId: string,
  patch: Record<string, unknown>,
) {
  const { error } = await supabase
    .from('leads')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', leadId);

  if (error) {
    console.error(`[apollo-bulk] failed to update enrichment state for lead ${leadId}:`, error.message);
  }
}

/**
 * Enriches one batch of up to ten leads in a single Apollo call.
 *
 * The organization lookup still runs per lead, but only when the person
 * payload lacks rich embedded company data - Apollo usually inlines enough
 * that no second call is needed at all.
 */
async function enrichBatch(
  organizationId: string,
  leads: EnrichableLead[],
  context: ApolloRequestContext,
  attempt = 1,
): Promise<BulkEnrichmentOutcome[]> {
  const details = leads.map(buildBulkMatchDetail);
  const options = buildBulkMatchOptions();
  const webhookExpected = apolloWebhookExpected();

  const run = await startApolloEnrichmentRun({
    organizationId,
    leadId: null,
    enrichmentKind: 'bulk_person_match',
    idempotencyKey: `bulk_person_match:${hashApolloPayload({ details, options })}`,
    webhookExpected,
  });

  await Promise.all(leads.map(lead => markLeadEnrichmentState(organizationId, lead.id, {
    enrichment_status: 'enriching',
    enrichment_started_at: new Date().toISOString(),
  })));

  let payload: Record<string, unknown>;
  try {
    payload = await bulkMatchApolloPeople(details, options, { ...context, enrichmentRunId: run.id });
  } catch (error) {
    const isRateLimit = error instanceof AppError && error.status === 429;

    // One retry after a backoff. A rate limit is a property of the moment, not
    // of these leads, so failing them permanently would discard good records
    // over a transient condition.
    if (isRateLimit && attempt === 1) {
      await failApolloEnrichmentRun(organizationId, run.id, 'rate_limited', 'Apollo rate limit, retrying batch');
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
      return enrichBatch(organizationId, leads, context, attempt + 1);
    }

    const message = error instanceof Error ? error.message : 'Apollo bulk enrichment failed';
    await failApolloEnrichmentRun(
      organizationId,
      run.id,
      error instanceof AppError ? `apollo_${error.status}` : 'apollo_bulk_match_failed',
      message,
    );
    await Promise.all(leads.map(lead => markLeadEnrichmentState(organizationId, lead.id, {
      enrichment_status: 'failed',
      status: 'enrichment_failed',
    })));

    return leads.map(lead => ({ leadId: lead.id, status: 'failed' as const, error: message }));
  }

  const matches = asArray(payload.matches);
  const outcomes: BulkEnrichmentOutcome[] = [];

  for (let index = 0; index < leads.length; index++) {
    const lead = leads[index];
    // Positional, never `matches[0]` or a find(): Apollo pads unmatched slots
    // with null and a shifted read would write one person's data onto another.
    const person = matches[index] as ApolloPerson | null | undefined;

    if (!person || typeof person !== 'object') {
      await markLeadEnrichmentState(organizationId, lead.id, {
        enrichment_status: 'incomplete',
        enrichment_completed_at: new Date().toISOString(),
        status: 'enrichment_failed',
      });
      outcomes.push({ leadId: lead.id, status: 'no_match' });
      continue;
    }

    try {
      const organization = await enrichOrganizationForPerson(person, {
        ...context,
        leadId: lead.id,
        enrichmentRunId: run.id,
      });
      await persistApolloPersonToLead(organizationId, lead.id, person, organization);

      // A lead is only "complete" once every source has resolved. With a
      // waterfall in flight the facts are still arriving, and scoring now
      // would measure our patience rather than Apollo's data.
      await markLeadEnrichmentState(organizationId, lead.id, {
        enrichment_status: webhookExpected ? 'awaiting_webhook' : 'complete',
        enrichment_completed_at: webhookExpected ? null : new Date().toISOString(),
      });

      outcomes.push({
        leadId: lead.id,
        status: webhookExpected ? 'awaiting_webhook' : 'enriched',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to persist Apollo enrichment';
      console.error(`[apollo-bulk] failed to persist lead ${lead.id}:`, message);
      await markLeadEnrichmentState(organizationId, lead.id, {
        enrichment_status: 'failed',
        status: 'enrichment_failed',
      });
      outcomes.push({ leadId: lead.id, status: 'failed', error: message });
    }
  }

  await completeApolloEnrichmentRun(organizationId, run.id, {
    providerRequestId: payload.request_id == null ? null : String(payload.request_id),
    providerStatus: typeof payload.status === 'string' ? payload.status : 'completed',
    status: webhookExpected ? 'awaiting_webhook' : 'completed',
    creditCost: typeof payload.credits_consumed === 'number' ? payload.credits_consumed : null,
    rawPayload: payload,
    webhookExpected,
  });

  return outcomes;
}

/**
 * Enriches every supplied lead, ten per call, three calls at a time.
 *
 * `deadlineAt` is the import's own clock. Once it passes, remaining batches
 * are abandoned rather than started - the leads they would have covered are
 * reported as still pending so the import can reach a terminal state instead
 * of running indefinitely.
 */
export async function bulkEnrichLeads(input: {
  organizationId: string;
  campaignId?: string | null;
  importRunId?: string | null;
  leads: EnrichableLead[];
  deadlineAt?: Date | null;
  onBatchComplete?: (outcomes: BulkEnrichmentOutcome[]) => Promise<void> | void;
}): Promise<{ outcomes: BulkEnrichmentOutcome[]; abandoned: string[] }> {
  const batches = chunk(input.leads, APOLLO_BULK_BATCH_SIZE);
  const abandoned: string[] = [];

  const context: ApolloRequestContext = {
    organizationId: input.organizationId,
    campaignId: input.campaignId ?? null,
    enrichmentRunId: input.importRunId ?? undefined,
  };

  const batchResults = await mapWithConcurrency(
    batches,
    APOLLO_BULK_CONCURRENCY,
    async (batch): Promise<BulkEnrichmentOutcome[]> => {
      if (input.deadlineAt && Date.now() >= input.deadlineAt.getTime()) {
        for (const lead of batch) {
          abandoned.push(lead.id);
          await markLeadEnrichmentState(input.organizationId, lead.id, {
            enrichment_status: 'incomplete',
            enrichment_timed_out: true,
          });
        }
        return batch.map(lead => ({
          leadId: lead.id,
          status: 'failed' as const,
          error: 'Import deadline reached before enrichment started',
        }));
      }

      const outcomes = await enrichBatch(input.organizationId, batch, context);
      if (input.onBatchComplete) await input.onBatchComplete(outcomes);
      return outcomes;
    },
  );

  return { outcomes: batchResults.flat(), abandoned };
}

/**
 * Sweeps leads still waiting on a webhook that never arrived. Without this a
 * lead sits in `awaiting_webhook` forever and never gets an email, and the
 * campaign quietly never finishes.
 *
 * The distinction it preserves matters: `enrichment_timed_out` marks a thin
 * email caused by us giving up, as opposed to one caused by Apollo genuinely
 * not having the data - which is what decides whether a retry is worth a credit.
 */
export async function sweepStalledEnrichment(
  organizationId: string,
  leadIds: string[],
  timeoutMs = APOLLO_LEAD_ENRICHMENT_TIMEOUT_MS,
): Promise<string[]> {
  if (leadIds.length === 0) return [];

  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const { data, error } = await supabase
    .from('leads')
    .update({
      enrichment_status: 'incomplete',
      enrichment_timed_out: true,
      enrichment_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', organizationId)
    .in('id', leadIds)
    .in('enrichment_status', ['enriching', 'awaiting_webhook'])
    .lt('enrichment_started_at', cutoff)
    .select('id');

  if (error) {
    console.error('[apollo-bulk] failed to sweep stalled enrichment:', error.message);
    return [];
  }

  return (data ?? []).map(row => row.id as string);
}
