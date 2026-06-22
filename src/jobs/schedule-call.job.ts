import { Queue } from 'bullmq';
import { redisConnection } from '../lib/redis';

export interface ScheduleCallJobData {
  leadId:         string;
  campaignId:     string;
  organizationId: string;
  toNumber:       string;
  fromNumber:     string;
}

const scheduleCallQueue = new Queue<ScheduleCallJobData, any, string>('schedule-call', { connection: redisConnection });

export async function enqueueScheduleCall(data: ScheduleCallJobData) {
  return scheduleCallQueue.add('schedule-call', data, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 15_000 },
  });
}
