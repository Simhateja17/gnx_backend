import { Queue } from 'bullmq';
import { queueConnection } from '../lib/redis';

const billingRenewalQueue = new Queue('billing-renewal-check', { connection: queueConnection });

export async function enqueueRecurringBillingRenewalCheck() {
  return billingRenewalQueue.add('billing-renewal-check', {}, {
    jobId: 'billing-renewal-check:daily',
    repeat: { every: 24 * 60 * 60 * 1000 },
  });
}
