import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  FRONTEND_URL: z.string().url(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string(),
  SUPABASE_ANON_KEY: z.string(),

  JWT_SECRET: z.string(),
  COOKIE_SECRET: z.string(),
  COOKIE_DOMAIN: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_REDIRECT_URI: z.string().url(),

  AZURE_OPENAI_ENDPOINT: z.string().url(),
  AZURE_OPENAI_API_KEY: z.string(),
  AZURE_OPENAI_DEPLOYMENT_NAME: z.string().default('gpt-4o'),

  RETELL_API_KEY: z.string(),
  RETELL_WEBHOOK_SECRET: z.string(),

  APOLLO_API_KEY: z.string(),

  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_PRICE_STARTER: z.string(),
  STRIPE_PRICE_GROWTH: z.string(),
  STRIPE_PRICE_SCALE: z.string(),

  RESEND_API_KEY: z.string(),
  RESEND_FROM_EMAIL: z.string().email(),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().optional(),

  SENTRY_DSN: z.string().optional(),
});

export const env = envSchema.parse(process.env);
