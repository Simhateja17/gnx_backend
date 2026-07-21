import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  FRONTEND_URL: z.string().url(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim(),
  SUPABASE_ANON_KEY: z.string().trim(),

  JWT_SECRET: z.string().trim(),
  COOKIE_SECRET: z.string().trim(),
  COOKIE_DOMAIN: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().trim().default(''),
  GOOGLE_CLIENT_SECRET: z.string().trim().default(''),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:5000/api/gmail/callback'),

  AZURE_OPENAI_ENDPOINT: z.string().default(''),
  AZURE_OPENAI_API_KEY: z.string().trim().default(''),
  AZURE_OPENAI_API_VERSION: z.string().default('2025-04-01-preview'),
  AZURE_OPENAI_CHAT_DEPLOYMENT: z.string().default('gpt-5.4-mini'),

  RETELL_API_KEY: z.string().trim().default(''),
  RETELL_WEBHOOK_SECRET: z.string().trim().default(''),

  APOLLO_API_KEY: z.string().trim().default(''),

  STRIPE_SECRET_KEY: z.string().trim().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().trim().default(''),
  STRIPE_PRICE_STARTER: z.string().trim().default(''),
  STRIPE_PRICE_GROWTH: z.string().trim().default(''),
  STRIPE_PRICE_SCALE: z.string().trim().default(''),

  RESEND_API_KEY: z.string().trim().default(''),
  RESEND_FROM_EMAIL: z.string().default('noreply@globonexo.com'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  POSTHOG_API_KEY: z.string().trim().optional(),
  POSTHOG_HOST: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
});

function loadEnv(): z.infer<typeof envSchema> {
  try {
    return envSchema.parse(process.env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const missing = err.issues.map((issue) => issue.path.join('.')).join(', ');
      throw new Error(`Missing or invalid environment variables: ${missing}`);
    }
    throw err;
  }
}

export const env = loadEnv();
