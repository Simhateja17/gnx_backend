import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

// TODO: implement support tickets/messages
router.get('/tickets', (_req, res) => res.json({ todo: 'list tickets' }));
router.post('/tickets', (_req, res) => res.json({ todo: 'create ticket' }));
router.get('/tickets/:id/messages', (req, res) => res.json({ todo: 'list messages', id: req.params.id }));
router.post('/tickets/:id/messages', (req, res) => res.json({ todo: 'send message', id: req.params.id }));

export default router;
