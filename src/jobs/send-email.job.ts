import { JobsOptions, Queue } from 'bullmq';
import { queueConnection, silenceQueueErrors } from '../lib/redis';

export interface SendEmailJobData {
  emailMessageId: string;
  leadId?:        string;
  campaignId?:    string;
  organizationId: string;
  stepNumber?:    number;
}

const sendEmailQueue = new Queue<SendEmailJobData, any, string>('send-email', { connection: queueConnection });
silenceQueueErrors(sendEmailQueue, 'send-email');

export async function enqueueSendEmail(data: SendEmailJobData, options: JobsOptions = {}) {
  return sendEmailQueue.add('send-email', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    ...options,
  });
}
