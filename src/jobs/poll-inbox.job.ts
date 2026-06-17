import { Queue } from 'bullmq';
import { redisConnection } from '../lib/redis';

export interface PollInboxJobData {
  organizationId:     string;
  connectedAccountId: string;
}

const pollInboxQueue = new Queue<PollInboxJobData, any, string>('poll-inbox', { connection: redisConnection });

export async function enqueuePollInbox(data: PollInboxJobData) {
  return pollInboxQueue.add('poll-inbox', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  });
}
