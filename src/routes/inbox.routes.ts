import { Router } from 'express';

const router = Router();

// TODO: implement inbox threads and manual reply
router.get('/', (req, res) => res.json({ todo: 'list inbox' }));
router.get('/:id', (req, res) => res.json({ todo: 'get thread', id: req.params.id }));
router.post('/:id/reply', (req, res) => res.json({ todo: 'send manual reply', id: req.params.id }));

export default router;
