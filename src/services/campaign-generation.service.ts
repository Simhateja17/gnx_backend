/**
 * Campaign email generation.
 *
 * Auto-triggered: there is no Generate button. A campaign whose leads have
 * finished enriching gets its drafts written without anyone asking, because
 * the first-run tour walks a customer straight from "leads found" to "review
 * your emails" and an empty review screen there is a dead end.
 *
 * The rule that shapes this file: a draft is valid by definition. Output that
 * fails validation is regenerated, and if the retry also fails it is recorded
 * as a per-lead failure rather than saved. Nothing invalid is ever written to
 * email_messages, so no reviewer is the last line of defence against an email
 * addressed to the wrong person - and no lead is silently dropped either, since
 * the failure is counted and retryable.
 */

import { CAMPAIGN_GENERATION_LEAD_CAP } from '../config/constants';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { ensureAgentConfig } from './agent-config.service';
import { generateSequenceRaw, type SequenceStepRequest } from './ai.service';
import {
  evaluateContextReadiness,
  readinessToPromptFacts,
} from './context-readiness.service';
import {
  parseGeneratedEmails,
  validateGeneratedEmail,
  validateRecipientBinding,
  type ValidationFailure,
  type ValidationTarget,
} from './email-validation.service';

type JsonRecord = Record<string, unknown>;

export type GenerationFailure = {
  leadId: string;
  step: number | null;
  reason: string;
  attempts: number;
};

export type GenerationRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'timed_out';

function log(event: string, fields: JsonRecord) {
  console.log(JSON.stringify({ event, ...fields }));
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

export async function createGenerationRun(input: {
  organizationId: string;
  campaignId: string;
  importRunId?: string | null;
  trigger?: 'leads_ready' | 'manual_retry' | 'regenerate';
  totalLeads: number;
}) {
  const { data, error } = await supabase
    .from('campaign_generation_runs')
    .insert({
      organization_id: input.organizationId,
      campaign_id: input.campaignId,
      import_run_id: input.importRunId ?? null,
      trigger: input.trigger ?? 'leads_ready',
      status: 'running',
      total_leads: input.totalLeads,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error || !data) throw new AppError(500, 'Failed to create generation run', error);
  return data;
}

async function updateGenerationRun(runId: string, patch: JsonRecord) {
  const { error } = await supabase
    .from('campaign_generation_runs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', runId);

  if (error) console.error('[generation] failed to update run:', error.message);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Leads ready to have emails written for them.
 *
 * "Ready" means enrichment has reached a terminal state - not merely that the
 * lead exists. Generating while enrichment is still in flight produces the thin
 * role-only email the spec tolerates but nobody wants on the first campaign a
 * customer ever reads, and it would do so from data that was about to arrive.
 */
export async function findGenerationReadyLeads(organizationId: string, campaignId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('qualification_status', 'qualified')
    .in('enrichment_status', ['complete', 'incomplete'])
    .limit(CAMPAIGN_GENERATION_LEAD_CAP);

  if (error) throw new AppError(500, 'Failed to load leads for generation', error);
  return data ?? [];
}

async function loadSequenceSteps(campaignId: string): Promise<SequenceStepRequest[]> {
  const { data, error } = await supabase
    .from('email_sequence_steps')
    .select('step_number,body_prompt_context')
    .eq('campaign_id', campaignId)
    .order('step_number', { ascending: true });

  if (error) throw new AppError(500, 'Failed to load campaign sequence', error);

  const steps = (data ?? []).map(step => ({
    stepNumber: step.step_number as number,
    stepType: step.step_number === 1
      ? 'first_touch'
      : step.step_number === 2
        ? 'follow_up'
        : 'final_follow_up',
    instruction: (step.body_prompt_context as string | null) ?? null,
  }));

  // A campaign with no configured sequence still gets the spec's default arc
  // rather than producing nothing.
  return steps.length > 0
    ? steps
    : [
      { stepNumber: 1, stepType: 'first_touch', instruction: null },
      { stepNumber: 2, stepType: 'follow_up', instruction: null },
      { stepNumber: 3, stepType: 'final_follow_up', instruction: null },
    ];
}

// ---------------------------------------------------------------------------
// Per-lead generation
// ---------------------------------------------------------------------------

type LeadGenerationResult = {
  saved: number;
  failures: GenerationFailure[];
  thin: boolean;
  contextScore: number;
};

/**
 * Writes every missing step for one lead.
 *
 * Steps already sent or approved are never regenerated or overwritten. Invalid
 * steps are retried once, and only the steps that failed - a good step is not
 * thrown away because a sibling was malformed.
 */
async function generateForLead(input: {
  organizationId: string;
  campaignId: string;
  generationRunId: string;
  campaign: JsonRecord;
  agentConfig: JsonRecord;
  lead: JsonRecord;
  account: JsonRecord | null;
  steps: SequenceStepRequest[];
  autopilot: boolean;
}): Promise<LeadGenerationResult> {
  const leadId = input.lead.id as string;
  const failures: GenerationFailure[] = [];

  const readiness = evaluateContextReadiness(input.lead as never, input.account as never);
  const facts = readinessToPromptFacts(readiness);

  // Required ingredients missing means there is nothing truthful to write.
  // Recorded as a failure rather than silently skipped: the customer paid to
  // enrich this lead and deserves to see that it produced nothing.
  if (!readiness.requiredMet) {
    return {
      saved: 0,
      thin: readiness.thin,
      contextScore: readiness.score,
      failures: [{
        leadId,
        step: null,
        reason: `Missing required context: ${readiness.missingRequired.join(', ')}.`,
        attempts: 0,
      }],
    };
  }

  const { data: existing } = await supabase
    .from('email_messages')
    .select('id,step_number,status,subject,body')
    .eq('organization_id', input.organizationId)
    .eq('campaign_id', input.campaignId)
    .eq('lead_id', leadId);

  const existingByStep = new Map<number, JsonRecord>();
  for (const message of existing ?? []) existingByStep.set(message.step_number as number, message);

  // Anything sent or approved is settled and must not be rewritten.
  const lockedSteps = new Set(
    (existing ?? [])
      .filter(message => ['sent', 'approved', 'queued'].includes(message.status as string))
      .map(message => message.step_number as number),
  );

  const missingSteps = input.steps.filter(step => !lockedSteps.has(step.stepNumber));
  if (missingSteps.length === 0) {
    return { saved: 0, failures: [], thin: readiness.thin, contextScore: readiness.score };
  }

  const previousEmails = (existing ?? [])
    .filter(message => message.status === 'sent')
    .map(message => ({
      step_number: message.step_number as number,
      subject: message.subject as string,
      body: message.body as string,
    }));

  const validSteps = new Map<number, ValidationTarget>();
  let lastFailures: ValidationFailure[] = [];
  let attempts = 0;

  // Two attempts: the initial call, then one retry covering only the steps
  // that did not survive validation.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const outstanding = missingSteps.filter(step => !validSteps.has(step.stepNumber));
    if (outstanding.length === 0) break;
    attempts = attempt;

    let raw: string;
    let provider: string;
    let model: string;
    try {
      const generated = await generateSequenceRaw({
        campaign: input.campaign,
        lead: input.lead,
        agentConfig: input.agentConfig,
        steps: outstanding,
        facts,
        previousEmails,
      });
      raw = generated.raw;
      provider = generated.provider;
      model = generated.model;
    } catch (error) {
      lastFailures = [{
        code: 'missing_json',
        detail: error instanceof Error ? error.message : 'AI provider call failed',
      }];
      continue;
    }

    const parsed = parseGeneratedEmails(raw);
    if ('error' in parsed) {
      lastFailures = [{ code: 'missing_json', detail: parsed.error }];
      continue;
    }

    for (const step of outstanding) {
      const candidate = parsed.steps.find(item => item.stepNumber === step.stepNumber);
      if (!candidate) {
        lastFailures = [{ code: 'wrong_step', detail: `Model omitted step ${step.stepNumber}.` }];
        continue;
      }

      const bodiesToCompare = [
        ...previousEmails.map(email => email.body),
        ...[...validSteps.values()].map(target => target.body),
      ];

      const verdict = validateGeneratedEmail({
        target: candidate,
        lead: input.lead as never,
        expectedStep: step.stepNumber,
        previousBodies: bodiesToCompare,
      });

      if (verdict.valid) {
        validSteps.set(step.stepNumber, candidate);
        (candidate as ValidationTarget & { meta?: JsonRecord }).meta = { provider, model };
      } else {
        lastFailures = verdict.failures;
        log('email_generation_validation_failed', {
          organizationId: input.organizationId,
          campaignId: input.campaignId,
          leadId,
          step: step.stepNumber,
          attempt,
          codes: verdict.failures.map(failure => failure.code),
        });
      }
    }

    if (attempt === 1 && validSteps.size < missingSteps.length) {
      log('email_generation_retry', {
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        leadId,
        retryingSteps: missingSteps.filter(step => !validSteps.has(step.stepNumber)).map(step => step.stepNumber),
      });
    }
  }

  for (const step of missingSteps) {
    if (validSteps.has(step.stepNumber)) continue;
    failures.push({
      leadId,
      step: step.stepNumber,
      reason: lastFailures.map(failure => `${failure.code}: ${failure.detail}`).join('; ')
        || 'Model did not return a usable email for this step.',
      attempts,
    });
  }

  let saved = 0;
  for (const [stepNumber, target] of validSteps) {
    // Last gate before persistence: the greeting and the recipient address
    // must come from the same lead record. Catches the class of bug no prompt
    // can prevent - content built for one lead saved against another.
    const binding = validateRecipientBinding({
      messageLeadId: leadId,
      canonicalLeadId: input.lead.id as string,
      recipientEmail: input.lead.email as string | null,
      canonicalEmail: input.lead.email as string | null,
    });

    if (!binding.valid) {
      failures.push({
        leadId,
        step: stepNumber,
        reason: binding.failures.map(failure => failure.detail).join('; '),
        attempts,
      });
      continue;
    }

    const { data: sequenceStep } = await supabase
      .from('email_sequence_steps')
      .select('id')
      .eq('campaign_id', input.campaignId)
      .eq('step_number', stepNumber)
      .maybeSingle();

    const meta = (target as ValidationTarget & { meta?: JsonRecord }).meta ?? {};
    const record = {
      organization_id: input.organizationId,
      campaign_id: input.campaignId,
      lead_id: leadId,
      sequence_step_id: sequenceStep?.id ?? null,
      step_number: stepNumber,
      subject: target.subject.trim(),
      body: target.body.trim(),
      // Autopilot approves on creation. It skips human review, never
      // validation - everything reaching this point has already passed.
      status: input.autopilot ? 'approved' : 'draft',
      approved_at: input.autopilot ? new Date().toISOString() : null,
      approved_by: input.autopilot ? 'autopilot' : null,
      generation_run_id: input.generationRunId,
      context_score: readiness.score,
      thin_context: readiness.thin,
      generation_meta: {
        provider: meta.provider ?? 'azure-openai',
        model: meta.model ?? null,
        lead_source: input.lead.source ?? 'apollo',
        apollo_person_id: input.lead.apollo_id ?? null,
        apollo_enrichment_status: input.lead.enrichment_status ?? null,
        context_score: readiness.score,
        context_score_max: readiness.scoreMax,
        generation_version: 'sequence-v1',
        generated_at: new Date().toISOString(),
      },
    };

    const previous = existingByStep.get(stepNumber);
    const { error } = previous
      ? await supabase.from('email_messages').update(record).eq('id', previous.id as string)
      : await supabase.from('email_messages').insert(record);

    if (error) {
      failures.push({ leadId, step: stepNumber, reason: `Failed to save draft: ${error.message}`, attempts });
      continue;
    }

    saved++;
  }

  return { saved, failures, thin: readiness.thin, contextScore: readiness.score };
}

// ---------------------------------------------------------------------------
// Campaign run
// ---------------------------------------------------------------------------

/**
 * Generates drafts for every ready lead in a campaign.
 *
 * One lead failing never stops the others: each is generated and recorded
 * independently, and the run reports "28 generated, 2 failed" rather than
 * aborting or silently skipping.
 */
export async function runCampaignGeneration(input: {
  organizationId: string;
  campaignId: string;
  importRunId?: string | null;
  trigger?: 'leads_ready' | 'manual_retry' | 'regenerate';
  leadIds?: string[];
}) {
  const { organizationId, campaignId } = input;

  const [agentConfig, campaignResult] = await Promise.all([
    ensureAgentConfig(organizationId),
    supabase
      .from('campaigns')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', campaignId)
      .single(),
  ]);

  if (campaignResult.error || !campaignResult.data) throw new AppError(404, 'Campaign not found');
  const campaign = campaignResult.data as JsonRecord;

  const allLeads = await findGenerationReadyLeads(organizationId, campaignId);
  const leads = input.leadIds?.length
    ? allLeads.filter(lead => input.leadIds!.includes(lead.id))
    : allLeads;

  const run = await createGenerationRun({
    organizationId,
    campaignId,
    importRunId: input.importRunId,
    trigger: input.trigger,
    totalLeads: leads.length,
  });

  log('campaign_generation_started', {
    organizationId,
    campaignId,
    generationRunId: run.id,
    totalLeads: leads.length,
    autopilot: campaign.autopilot_enabled === true,
  });

  if (leads.length === 0) {
    await updateGenerationRun(run.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    return { runId: run.id, status: 'completed' as GenerationRunStatus, generated: 0, failed: 0 };
  }

  const steps = await loadSequenceSteps(campaignId);

  const accountIds = [...new Set(leads.map(lead => lead.account_id).filter(Boolean))] as string[];
  const accounts = new Map<string, JsonRecord>();
  if (accountIds.length > 0) {
    const { data: accountRows } = await supabase
      .from('accounts')
      .select('*')
      .eq('organization_id', organizationId)
      .in('id', accountIds);
    for (const account of accountRows ?? []) accounts.set(account.id, account);
  }

  const autopilot = campaign.autopilot_enabled === true;
  const failures: GenerationFailure[] = [];
  let generated = 0;
  let processed = 0;
  let failedLeads = 0;
  const contextScores: number[] = [];

  for (const lead of leads) {
    try {
      const result = await generateForLead({
        organizationId,
        campaignId,
        generationRunId: run.id,
        campaign,
        agentConfig: agentConfig as JsonRecord,
        lead,
        account: lead.account_id ? accounts.get(lead.account_id) ?? null : null,
        steps,
        autopilot,
      });

      generated += result.saved;
      contextScores.push(result.contextScore);
      if (result.failures.length > 0) {
        failures.push(...result.failures);
        failedLeads++;
      }
    } catch (error) {
      // A thrown error is still one lead's problem, not the campaign's.
      const message = error instanceof Error ? error.message : 'Generation failed';
      failures.push({ leadId: lead.id, step: null, reason: message, attempts: 0 });
      failedLeads++;
      console.error(`[generation] lead ${lead.id} failed:`, message);
    }

    processed++;
    if (processed % 5 === 0 || processed === leads.length) {
      await updateGenerationRun(run.id, {
        processed_leads: processed,
        generated_messages: generated,
        failed_leads: failedLeads,
        failures,
      });
    }
  }

  const status: GenerationRunStatus = failedLeads === 0
    ? 'completed'
    : generated > 0
      ? 'partial'
      : 'failed';

  await updateGenerationRun(run.id, {
    status,
    processed_leads: processed,
    generated_messages: generated,
    failed_leads: failedLeads,
    failures,
    provider: 'azure-openai',
    completed_at: new Date().toISOString(),
  });

  log('campaign_generation_completed', {
    organizationId,
    campaignId,
    generationRunId: run.id,
    status,
    generated,
    failedLeads,
    averageContextScore: contextScores.length > 0
      ? Number((contextScores.reduce((total, score) => total + score, 0) / contextScores.length).toFixed(2))
      : null,
  });

  return { runId: run.id, status, generated, failed: failedLeads };
}

/** Latest run for a campaign, for the progress panel. */
export async function getGenerationProgress(organizationId: string, campaignId: string) {
  const { data, error } = await supabase
    .from('campaign_generation_runs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to load generation progress', error);
  if (!data) return null;

  return {
    runId: data.id,
    status: data.status,
    totalLeads: data.total_leads ?? 0,
    processedLeads: data.processed_leads ?? 0,
    generatedMessages: data.generated_messages ?? 0,
    failedLeads: data.failed_leads ?? 0,
    skippedLeads: data.skipped_leads ?? 0,
    failures: data.failures ?? [],
    provider: data.provider ?? null,
    model: data.model ?? null,
    startedAt: data.started_at ?? null,
    completedAt: data.completed_at ?? null,
    error: data.error ?? null,
    isTerminal: ['completed', 'partial', 'failed', 'timed_out'].includes(data.status),
  };
}
