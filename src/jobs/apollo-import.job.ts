import { Queue } from 'bullmq';
import { queueConnection, silenceQueueErrors } from '../lib/redis';
import type { ApolloImportCriteria } from '../services/apollo-import.service';

export type ApolloImportJobData = Omit<ApolloImportCriteria, 'timeoutMs'> & {
  timeoutMs?: number;
};

const apolloImportQueue = new Queue<ApolloImportJobData, any, string>(
  'apollo-import',
  { connection: queueConnection },
);
silenceQueueErrors(apolloImportQueue, 'apollo-import');

/**
 * Imports run asynchronously and the HTTP request returns a run id
 * immediately. A search plus enrichment for ten leads is minutes of work, and
 * holding the request open for it is how the onboarding call ended up with a
 * two minute client timeout.
 *
 * Only one retry: a failed import has usually already spent Apollo credits,
 * and retrying it automatically spends them again for the same likely result.
 */
export async function enqueueApolloImport(data: ApolloImportJobData) {
  return apolloImportQueue.add('apollo-import', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  });
}

export { apolloImportQueue };
