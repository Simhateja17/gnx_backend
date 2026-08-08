import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as Sentry from '@sentry/node';
import { env } from './config/env';
import { errorHandler } from './middleware/error.middleware';
import { rateLimiter, retellInboundRateLimiter, retellToolRateLimiter, webhookRateLimiter } from './middleware/rate-limit.middleware';
import routes from './routes';
import * as voiceService from './services/voice.service';
import * as billingService from './services/billing.service';
import { handleApolloWebhook } from './services/apollo-webhook.service';
import { handleRetellTool } from './services/retell-tools.service';
import { handleInboundRetellWebhook } from './services/inbound-voice.service';
import { verifyRetellRequest, verifyRetellToolSecret } from './services/retell-auth.service';

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
    res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message });
  }
});

// Pre-connect inbound routing. Retell waits for this signed response before
// connecting an agent, so keep the handler raw, bounded, and independent from
// browser/session authentication.
app.post('/webhooks/retell/inbound', retellInboundRateLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    res.json(await handleInboundRetellWebhook(req.body as Buffer, req.headers['x-retell-signature'] as string ?? ''));
  } catch (err: any) {
    res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
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
//
// Two paths, one handler: /api/apollo/webhook is the documented contract, and
// /webhooks/apollo is what already-configured Apollo callbacks point at.
// Retiring the old path would strand enrichment results in flight, and the
// handler is idempotent either way.
app.post(['/webhooks/apollo', '/api/apollo/webhook'], webhookRateLimiter, express.json(), async (req, res) => {
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

// Retell tools require both Retell's signature and our private static header.
// Raw bytes are mandatory because parsing/re-serializing JSON changes the HMAC.
app.post('/webhooks/retell/tools/:toolName', retellToolRateLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body as Buffer;
    verifyRetellRequest(rawBody, req.headers['x-retell-signature'] as string ?? '');
    verifyRetellToolSecret(typeof req.headers['x-tool-secret'] === 'string' ? req.headers['x-tool-secret'] : '');
    res.json(await handleRetellTool(req.params.toolName, JSON.parse(rawBody.toString('utf8'))));
  } catch (err: any) {
    res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
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
