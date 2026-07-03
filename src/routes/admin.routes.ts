import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

// TODO: implement admin endpoints
router.get('/organizations', (_req, res) => res.json({ todo: 'list organizations' }));
router.get('/users', (_req, res) => res.json({ todo: 'list users' }));
router.get('/campaigns', (_req, res) => res.json({ todo: 'list campaigns' }));
router.get('/metrics', (_req, res) => res.json({ todo: 'admin metrics' }));
router.post('/organizations/:id/suspend', (req, res) => res.json({ todo: 'suspend org', id: req.params.id }));
router.post('/organizations/:id/impersonate', (req, res) => res.json({ todo: 'impersonate org', id: req.params.id }));

export default router;
