import { Router } from 'express';
import { authRateLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies';
import * as authService from '../services/auth.service';
import { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from '../schemas/auth.schema';
import { env } from '../config/env';
import { AppError } from '../types';

const router = Router();

router.post('/signup', authRateLimiter, validate(signupSchema), async (req, res, next) => {
  try {
    const { session, user, organization } = await authService.signup(req.body);
    setAuthCookies(res, session);
    res.json({ user, organization });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authRateLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { session, user, organization } = await authService.login(req.body);
    setAuthCookies(res, session);
    res.json({ user, organization });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', authRateLimiter, async (req, res, next) => {
  try {
    await authService.logout(req.signedCookies?.access_token);
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user, organization: req.organization });
});

router.post('/forgot-password', authRateLimiter, validate(forgotPasswordSchema), async (req, res, next) => {
  try {
    await authService.forgotPassword(req.body.email);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', authRateLimiter, validate(resetPasswordSchema), async (req, res, next) => {
  try {
    await authService.resetPassword(req.body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Initiate Google OAuth — redirects browser through Supabase to Google
router.get('/google', (_req, res) => {
  const redirectTo = encodeURIComponent(`${env.FRONTEND_URL}/callback`);
  res.redirect(`${env.SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${redirectTo}`);
});

// Complete Google OAuth — receives tokens from frontend callback, sets cookies
router.post('/google/callback', authRateLimiter, async (req, res, next) => {
  try {
    const { accessToken, refreshToken, expiresIn } = req.body;
    if (!accessToken) throw new AppError(400, 'Missing access token');
    const { session, user, organization } = await authService.googleCallback(
      accessToken,
      refreshToken || '',
      Number(expiresIn) || 3600,
    );
    setAuthCookies(res, session);
    res.json({ user, organization });
  } catch (err) {
    next(err);
  }
});

export default router;
