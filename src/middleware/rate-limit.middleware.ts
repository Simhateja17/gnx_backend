import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

// The dashboard is a SPA that fires several API calls per page load, so the
// global budget has to cover normal clicking-around for a signed-in user - the
// old 100/15min worked out to ~6.7 req/min and locked people out mid-session.
// Abuse-sensitive routes are protected by authRateLimiter instead, which is
// where a tight limit actually belongs.
export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // ~66 req/min per IP
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Health checks are pinged on a schedule by uptime monitors and shouldn't
  // eat into anyone's budget. Local dev is exempt entirely: the store is
  // in-memory, so a few hot reloads plus normal navigation trips the limit and
  // then blocks unrelated routes (including the OAuth redirect) for 15 minutes.
  skip: req => req.path === '/health' || env.NODE_ENV === 'development',
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please try again later.' },
});

export const webhookRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many webhook requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
