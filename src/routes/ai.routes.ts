import { Router } from 'express';

const router = Router();

// TODO: implement AI generation endpoints
router.post('/generate-email', (req, res) => res.json({ todo: 'generate email' }));
router.post('/generate-reply', (req, res) => res.json({ todo: 'generate reply' }));
router.post('/generate-voice-prompt', (req, res) => res.json({ todo: 'generate voice prompt' }));

export default router;
