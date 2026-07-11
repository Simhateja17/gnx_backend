import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { Queue } from 'bullmq';

// Regression test for a real hang: BullMQ Workers require
// maxRetriesPerRequest: null (needed for blocking commands), but Queue
// producers don't need that and, with it set, Queue.add() against an
// unreachable Redis retries forever and never resolves or rejects — an API
// request that enqueues a job would hang indefinitely. queueConnection
// (used by all jobs/*.job.ts Queue instances) bounds the retry count so
// enqueue calls fail fast instead.
describe('queueConnection fails fast when Redis is unreachable', () => {
  it('Queue.add() rejects within a few seconds instead of hanging', async () => {
    const unreachableConnection = {
      host: '127.0.0.1',
      port: 6399, // nothing listens here
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 1000)),
    };

    const queue = new Queue('redis-down-probe', { connection: unreachableConnection });

    const start = Date.now();
    await expect(queue.add('probe', { hello: 'world' })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(10_000);

    await queue.close();
  });
});
