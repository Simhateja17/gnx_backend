import { Router } from 'express';

const router = Router();

// TODO: implement campaign CRUD + launch/pause
router.get('/', (req, res) => res.json({ todo: 'list campaigns' }));
router.post('/', (req, res) => res.json({ todo: 'create campaign' }));
router.get('/:id', (req, res) => res.json({ todo: 'get campaign', id: req.params.id }));
router.put('/:id', (req, res) => res.json({ todo: 'update campaign', id: req.params.id }));
router.post('/:id/launch', (req, res) => res.json({ todo: 'launch campaign', id: req.params.id }));
router.post('/:id/pause', (req, res) => res.json({ todo: 'pause campaign', id: req.params.id }));
router.delete('/:id', (req, res) => res.json({ todo: 'delete campaign', id: req.params.id }));

export default router;
