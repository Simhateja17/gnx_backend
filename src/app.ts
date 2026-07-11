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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(env.COOKIE_SECRET));
app.use(rateLimiter);

app.use('/api', routes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(errorHandler);
