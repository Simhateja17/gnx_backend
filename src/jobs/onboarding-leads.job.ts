import { Queue } from 'bullmq';
import { queueConnection, silenceQueueErrors } from '../lib/redis';

export interface OnboardingLeadsJobData {
  organizationId: string;
  campaignId: string;
  targetEnriched: number;
  titles: string[];
  locations: string[];
  companySizes: string[];
  keywords: string;
}

const onboardingLeadsQueue = new Queue<OnboardingLeadsJobData, any, string>('onboarding-leads', {
  connection: queueConnection,
});
silenceQueueErrors(onboardingLeadsQueue, 'onboarding-leads');

export async function enqueueOnboardingLeads(data: OnboardingLeadsJobData) {
  return onboardingLeadsQueue.add('prepare-onboarding-leads', data, {
    jobId: `onboarding-leads:${data.campaignId}`,
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: { age: 86_400 },
  });
}
