import { Router } from 'express';

const router = Router();

// TODO: implement gmail oauth connect/disconnect/status
router.get('/auth-url', (_req, res) => res.json({ todo: 'auth-url' }));
router.post('/callback', (_req, res) => res.json({ todo: 'callback' }));
router.get('/status', (_req, res) => res.json({ todo: 'status' }));
router.delete('/disconnect', (_req, res) => res.json({ todo: 'disconnect' }));

export default router;
