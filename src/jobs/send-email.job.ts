import { Queue } from 'bullmq';
import { redisConnection } from '../lib/redis';

export interface SendEmailJobData {
  emailMessageId: string;
  leadId:         string;
  campaignId:     string;
  organizationId: string;
}

const sendEmailQueue = new Queue<SendEmailJobData, any, string>('send-email', { connection: redisConnection });

export async function enqueueSendEmail(data: SendEmailJobData) {
  return sendEmailQueue.add('send-email', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}
