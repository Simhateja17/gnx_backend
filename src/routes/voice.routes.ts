import { Router } from 'express';

const router = Router();

// TODO: implement retell agent create/update and call retry
router.post('/agents', (_req, res) => res.json({ todo: 'create/update retell agent' }));
router.post('/calls/:callId/retry', (req, res) => res.json({ todo: 'retry call', callId: req.params.callId }));

export default router;
