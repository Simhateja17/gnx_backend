import { Router } from 'express';
import { authRateLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies';
import * as authService from '../services/auth.service';
import { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from '../schemas/auth.schema';

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

router.post('/logout', async (req, res, next) => {
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

router.post('/reset-password', validate(resetPasswordSchema), async (req, res, next) => {
  try {
    await authService.resetPassword(req.body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
