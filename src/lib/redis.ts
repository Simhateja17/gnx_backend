import IORedis from 'ioredis';
import type { Queue } from 'bullmq';
import { env } from '../config/env';

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.warn('[Redis] connection error (workers will be unavailable):', err.message);
});

redis.connect().catch(() => {});

const parsed = new URL(env.REDIS_URL);
export const redisConnection = {
  host:                 parsed.hostname,
  port:                 Number(parsed.port) || 6379,
  password:             parsed.password || undefined,
  tls:                  parsed.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null as null,
  enableReadyCheck:     false,
};

// BullMQ Workers require maxRetriesPerRequest: null (they issue blocking
// commands that must retry indefinitely). Queue producers have no such
// requirement, and with the null setting a Queue.add() call against an
// unreachable Redis retries forever and never resolves or rejects — an API
// request that enqueues a job would hang indefinitely instead of failing.
//
// maxRetriesPerRequest alone doesn't fix this: it only bounds retries for
// commands issued after a connection has been established and then drops.
// The very first connection attempt is governed by retryStrategy, which
// ioredis defaults to retrying forever — so a Redis that's never been
// reachable still hangs. retryStrategy here gives up after 3 attempts
// (returning null tells ioredis to stop and reject pending commands).
export const queueConnection = {
  ...redisConnection,
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 1000)),
};

// BullMQ Queues are EventEmitters. If nothing listens for 'error', a Redis
// connection failure becomes an unhandled 'error' event, which Node treats
// as fatal and crashes the whole process — taking down the API along with
// the job producers. Attach a listener that just logs instead.
export function silenceQueueErrors(queue: Queue, name: string): void {
  queue.on('error', (err) => {
    console.warn(`[Queue:${name}] connection error (jobs will be unavailable):`, err.message);
  });
}
