import { Router } from 'express';

const router = Router();

// TODO: implement settings get/update
router.get('/', (req, res) => res.json({ todo: 'get settings' }));
router.put('/', (req, res) => res.json({ todo: 'update settings' }));

export default router;
