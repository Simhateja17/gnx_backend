import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { getCampaignAnalytics, getCallAnalytics } from '../services/dashboard.service';

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.get('/campaigns', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getCampaignAnalytics(req.organization.id));
  } catch (err) {
    next(err);
  }
});

router.get('/calls', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getCallAnalytics(req.organization.id));
  } catch (err) {
    next(err);
  }
});

export default router;
