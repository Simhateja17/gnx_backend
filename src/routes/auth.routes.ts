import { Router } from 'express';
import { authRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// TODO: implement signup, login, logout, google oauth, forgot/reset password
router.post('/signup', authRateLimiter, (req, res) => res.json({ todo: 'signup' }));
router.post('/login', authRateLimiter, (req, res) => res.json({ todo: 'login' }));
router.post('/logout', (req, res) => res.json({ todo: 'logout' }));
router.get('/me', (req, res) => res.json({ todo: 'me' }));

export default router;
