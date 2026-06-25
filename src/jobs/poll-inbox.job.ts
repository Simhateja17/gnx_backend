import { JobsOptions, Queue } from 'bullmq';
import { redisConnection } from '../lib/redis';

export interface PollInboxJobData {
  organizationId:     string;
  connectedAccountId: string;
}

const pollInboxQueue = new Queue<PollInboxJobData, any, string>('poll-inbox', { connection: redisConnection });

export async function enqueuePollInbox(data: PollInboxJobData, options: JobsOptions = {}) {
  return pollInboxQueue.add('poll-inbox', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    ...options,
  });
}

export async function enqueueRecurringPollInbox(data: PollInboxJobData) {
  return enqueuePollInbox(data, {
    jobId: `poll-inbox:${data.connectedAccountId}`,
    repeat: { every: 3 * 60 * 1000 },
  });
}
