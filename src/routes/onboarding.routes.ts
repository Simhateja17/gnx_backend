import { Router } from 'express';

const router = Router();

// TODO: implement onboarding create/update/get
router.post('/', (req, res) => res.json({ todo: 'create onboarding' }));
router.get('/', (req, res) => res.json({ todo: 'get onboarding' }));
router.put('/', (req, res) => res.json({ todo: 'update onboarding' }));

export default router;
