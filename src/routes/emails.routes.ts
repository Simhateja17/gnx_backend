import { Router } from 'express';

const router = Router();

// TODO: implement email reply approve/regenerate and test send
router.post('/:replyId/approve', (req, res) => res.json({ todo: 'approve reply', replyId: req.params.replyId }));
router.post('/:replyId/regenerate', (req, res) => res.json({ todo: 'regenerate reply', replyId: req.params.replyId }));
router.post('/send-test', (_req, res) => res.json({ todo: 'send test email' }));

export default router;
