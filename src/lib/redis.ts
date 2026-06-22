import IORedis from 'ioredis';
import { env } from '../config/env';

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Plain connection options for BullMQ Queue/Worker constructors.
// BullMQ v5 bundles its own ioredis internally, so passing an IORedis instance
// causes a type clash. Passing options lets BullMQ create its own connection.
const parsed = new URL(env.REDIS_URL);
export const redisConnection = {
  host:                 parsed.hostname,
  port:                 Number(parsed.port) || 6379,
  password:             parsed.password || undefined,
  maxRetriesPerRequest: null as null,
  enableReadyCheck:     false,
};
