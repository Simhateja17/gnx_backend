import { Router } from 'express';

const router = Router();

// TODO: implement dashboard KPIs and analytics
router.get('/', (req, res) => res.json({ todo: 'dashboard' }));

export default router;
