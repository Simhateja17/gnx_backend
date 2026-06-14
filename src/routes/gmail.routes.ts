import { Router } from 'express';

const router = Router();

// TODO: implement gmail oauth connect/disconnect/status
router.get('/auth-url', (req, res) => res.json({ todo: 'auth-url' }));
router.post('/callback', (req, res) => res.json({ todo: 'callback' }));
router.get('/status', (req, res) => res.json({ todo: 'status' }));
router.delete('/disconnect', (req, res) => res.json({ todo: 'disconnect' }));

export default router;
