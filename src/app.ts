import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as Sentry from '@sentry/node';
import { env } from './config/env';
import { errorHandler } from './middleware/error.middleware';
import { rateLimiter, webhookRateLimiter } from './middleware/rate-limit.middleware';
import routes from './routes';
import * as voiceService from './services/voice.service';
import * as billingService from './services/billing.service';
import { handleApolloWebhook } from './services/apollo-webhook.service';

export const app = express();

// Trust the first proxy hop (Vercel's edge today, Nginx/Caddy on GCP later) so
// express-rate-limit can safely read X-Forwarded-For for per-IP limits.
app.set('trust proxy', 1);

Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
});

app.use(helmet());
app.use(cors({
  origin: [env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));

// Retell webhook — must come before express.json() so we receive the raw bytes for signature verification
app.post('/webhooks/retell', webhookRateLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    await voiceService.handleRetellWebhook(req.body as Buffer, req.headers['x-retell-signature'] as string ?? '');
    res.json({ received: true });
  } catch (err: any) {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

// Razorpay webhook — must come before express.json() so we receive the raw bytes for signature verification
app.post('/webhooks/razorpay', webhookRateLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    await billingService.handleRazorpayWebhook(req.body as Buffer, req.headers['x-razorpay-signature'] as string ?? '');
    res.json({ received: true });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// Apollo does not provide a signed webhook header for phone/waterfall
// enrichment. Require the account-owned secret before accepting the callback.
app.post('/webhooks/apollo', webhookRateLimiter, express.json(), async (req, res) => {
  const configuredSecret = env.APOLLO_ENRICHMENT_WEBHOOK_SECRET;
  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : '';
  const headerSecret = typeof req.headers['x-apollo-webhook-secret'] === 'string'
    ? req.headers['x-apollo-webhook-secret']
    : '';
  if (!configuredSecret || (querySecret !== configuredSecret && headerSecret !== configuredSecret)) {
    res.status(401).json({ error: 'Invalid Apollo webhook secret' });
    return;
  }

  try {
    res.json(await handleApolloWebhook(req.body));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(env.COOKIE_SECRET));
app.use(rateLimiter);

app.use('/api', routes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

export default app;
