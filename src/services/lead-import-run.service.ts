/**
 * Import run state and counters.
 *
 * This is the record that answers "how is this import going". It is separate
 * from apollo_enrichment_runs, which answers "what did we ask Apollo and what
 * did it cost" - two different questions that were previously conflated, with
 * the customer-facing half living in a Redis blob that only the onboarding
 * path ever wrote.
 *
 * The invariant worth protecting: an import must always reach a terminal
 * state. A progress bar that never finishes is the failure customers actually
 * report, and it is why every path out of the orchestrator lands here.
 */

import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { APOLLO_IMPORT_TIMEOUT_MS } from '../config/constants';

export type ImportRunStatus =
  | 'queued'
  | 'searching'
  | 'candidates_found'
  | 'enriching'
  | 'waiting_for_enrichment'
  | 'completed'
  | 'partial'
  | 'timed_out'
  | 'failed';

export const TERMINAL_IMPORT_STATUSES: ImportRunStatus[] = [
  'completed',
  'partial',
  'timed_out',
  'failed',
];

export type ImportRunCounters = {
  candidatesFound: number;
  candidatesAttempted: number;
  qualifiedCount: number;
  duplicateCount: number;
  suppressedCount: number;
  rejectedCount: number;
  pendingCount: number;
  failedCount: number;
  pagesSearched: number;
};

export type ImportRun = {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  status: ImportRunStatus;
  requested_limit: number;
  candidate_cap: number;
  deadline_at: string | null;
  search_criteria: Record<string, unknown>;
} & Record<string, unknown>;

const COUNTER_COLUMNS: Record<keyof ImportRunCounters, string> = {
  candidatesFound: 'candidates_found',
  candidatesAttempted: 'candidates_attempted',
  qualifiedCount: 'qualified_count',
  duplicateCount: 'duplicate_count',
  suppressedCount: 'suppressed_count',
  rejectedCount: 'rejected_count',
  pendingCount: 'pending_count',
  failedCount: 'failed_count',
  pagesSearched: 'pages_searched',
};

export async function createImportRun(input: {
  organizationId: string;
  campaignId?: string | null;
  source?: 'apollo' | 'csv' | 'manual';
  requestedLimit: number;
  candidateCap: number;
  searchCriteria: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ImportRun> {
  const now = Date.now();
  const { data, error } = await supabase
    .from('lead_import_runs')
    .insert({
      organization_id: input.organizationId,
      campaign_id: input.campaignId ?? null,
      source: input.source ?? 'apollo',
      status: 'queued',
      requested_limit: input.requestedLimit,
      candidate_cap: input.candidateCap,
      // Frozen at creation: later ICP edits must not retroactively change what
      // an existing run claims it searched for.
      search_criteria: input.searchCriteria,
      deadline_at: new Date(now + (input.timeoutMs ?? APOLLO_IMPORT_TIMEOUT_MS)).toISOString(),
      started_at: new Date(now).toISOString(),
    })
    .select('*')
    .single();

  if (error || !data) throw new AppError(500, 'Failed to create lead import run', error);
  return data as ImportRun;
}

export async function getImportRun(organizationId: string, runId: string): Promise<ImportRun | null> {
  const { data, error } = await supabase
    .from('lead_import_runs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('id', runId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to load lead import run', error);
  return (data as ImportRun) ?? null;
}

export async function setImportRunStatus(
  organizationId: string,
  runId: string,
  status: ImportRunStatus,
  fields: {
    error?: string | null;
    progressMetadata?: Record<string, unknown>;
    averageContextScore?: number | null;
  } = {},
) {
  const patch: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (TERMINAL_IMPORT_STATUSES.includes(status)) {
    patch.completed_at = new Date().toISOString();
  }
  if ('error' in fields) patch.error = fields.error;
  if (fields.progressMetadata) patch.progress_metadata = fields.progressMetadata;
  if ('averageContextScore' in fields) patch.average_context_score = fields.averageContextScore;

  const { error } = await supabase
    .from('lead_import_runs')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', runId);

  if (error) throw new AppError(500, 'Failed to update lead import run status', error);
}

/**
 * Counters are written as absolute values from the orchestrator's own tally
 * rather than incremented in place. Concurrent batches would otherwise race on
 * read-modify-write, and an import that under-reports its rejections is worse
 * than useless - it is the number the customer uses to diagnose their ICP.
 */
export async function updateImportRunCounters(
  organizationId: string,
  runId: string,
  counters: Partial<ImportRunCounters>,
) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(counters)) {
    const column = COUNTER_COLUMNS[key as keyof ImportRunCounters];
    if (column && typeof value === 'number') patch[column] = value;
  }

  const { error } = await supabase
    .from('lead_import_runs')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', runId);

  if (error) throw new AppError(500, 'Failed to update lead import run counters', error);
}

export function importRunExpired(run: Pick<ImportRun, 'deadline_at'>): boolean {
  if (!run.deadline_at) return false;
  return new Date(run.deadline_at).getTime() <= Date.now();
}

/**
 * Which terminal state an import earned. `partial` is a first-class outcome,
 * not a failure: Apollo simply may not have ten verified people matching a
 * given ICP, and reporting that honestly is more useful than an alarm.
 */
export function resolveTerminalStatus(input: {
  qualified: number;
  requested: number;
  expired: boolean;
}): ImportRunStatus {
  if (input.qualified >= input.requested) return 'completed';
  if (input.expired) return 'timed_out';
  if (input.qualified > 0) return 'partial';
  return 'partial';
}

/** Shape the progress endpoint and the dashboard card both read. */
export function toImportProgress(run: ImportRun) {
  const requested = Number(run.requested_limit ?? 0);
  const qualified = Number(run.qualified_count ?? 0);

  return {
    runId: run.id,
    campaignId: run.campaign_id,
    status: run.status,
    requested,
    qualified,
    candidatesFound: Number(run.candidates_found ?? 0),
    candidatesAttempted: Number(run.candidates_attempted ?? 0),
    duplicates: Number(run.duplicate_count ?? 0),
    suppressed: Number(run.suppressed_count ?? 0),
    rejected: Number(run.rejected_count ?? 0),
    pending: Number(run.pending_count ?? 0),
    failed: Number(run.failed_count ?? 0),
    pagesSearched: Number(run.pages_searched ?? 0),
    averageContextScore: run.average_context_score ?? null,
    progressPercent: requested > 0 ? Math.min(100, Math.round((qualified / requested) * 100)) : 0,
    isTerminal: TERMINAL_IMPORT_STATUSES.includes(run.status),
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
    deadlineAt: run.deadline_at ?? null,
    error: run.error ?? null,
    metadata: run.progress_metadata ?? {},
  };
}
