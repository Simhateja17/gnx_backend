import { Router } from 'express';

const router = Router();

// TODO: implement stripe checkout/portal and webhooks
router.post('/checkout', (req, res) => res.json({ todo: 'create checkout session' }));
router.post('/portal', (req, res) => res.json({ todo: 'create portal session' }));

export default router;
