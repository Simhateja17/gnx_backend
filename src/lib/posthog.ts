import { PostHog } from 'posthog-node';
import { env } from '../config/env';

export const posthog = env.POSTHOG_API_KEY
  ? new PostHog(env.POSTHOG_API_KEY, { host: env.POSTHOG_HOST || 'https://us.i.posthog.com' })
  : null;
