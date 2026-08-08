import { Queue } from 'bullmq';
import { queueConnection, silenceQueueErrors } from '../lib/redis';
import { CAMPAIGN_GENERATION_DEBOUNCE_MS } from '../config/constants';

export interface CampaignGenerationJobData {
  organizationId: string;
  campaignId: string;
  importRunId?: string | null;
  trigger?: 'leads_ready' | 'manual_retry' | 'regenerate';
  leadIds?: string[];
}

const campaignGenerationQueue = new Queue<CampaignGenerationJobData, any, string>(
  'campaign-generation',
  { connection: queueConnection },
);
silenceQueueErrors(campaignGenerationQueue, 'campaign-generation');

/**
 * Schedules generation for a campaign, coalescing bursts.
 *
 * Leads land in bursts as enrichment batches finish, and firing a run per lead
 * would mean dozens of runs racing each other over the same campaign. Using
 * the campaign id as the job id makes repeat calls within the debounce window
 * collapse into the one already waiting: whichever arrival is last wins, and
 * the single run it triggers picks up every lead that became ready meanwhile.
 */
export async function enqueueCampaignGeneration(
  data: CampaignGenerationJobData,
  delayMs = CAMPAIGN_GENERATION_DEBOUNCE_MS,
) {
  const jobId = `campaign-generation:${data.campaignId}`;

  // A delayed job still holds its id, so an existing one must be cleared for
  // the new arrival to extend the window rather than be silently dropped.
  const existing = await campaignGenerationQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting') {
      await existing.remove();
    } else {
      // A run is already in flight. It will not see leads that qualified after
      // it started, so queue a follow-up instead of dropping this trigger.
      return campaignGenerationQueue.add('campaign-generation', data, {
        jobId: `${jobId}:followup:${Date.now()}`,
        delay: delayMs,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      });
    }
  }

  return campaignGenerationQueue.add('campaign-generation', data, {
    jobId,
    delay: delayMs,
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  });
}

export { campaignGenerationQueue };
