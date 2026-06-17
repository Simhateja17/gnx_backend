import { Queue } from 'bullmq';
import { redisConnection } from '../lib/redis';

export interface EnrichLeadsJobData {
  leadIds:        string[];
  campaignId:     string;
  organizationId: string;
}

const enrichLeadsQueue = new Queue<EnrichLeadsJobData, any, string>('enrich-leads', { connection: redisConnection });

export async function enqueueEnrichLeads(data: EnrichLeadsJobData) {
  return enrichLeadsQueue.add('enrich-leads', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 8_000 },
  });
}
