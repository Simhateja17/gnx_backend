import IORedis from 'ioredis';
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
  maxRetriesPerRequest: null as null,
  enableReadyCheck:     false,
};
