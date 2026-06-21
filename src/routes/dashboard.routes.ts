import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { getDashboard, getAnalytics } from '../services/dashboard.service';

const router = Router();

router.use(authenticate);

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getDashboard(req.user.id, req.organization.id));
  } catch (err) {
    next(err);
  }
});

router.get('/analytics', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getAnalytics(req.organization.id));
  } catch (err) {
    next(err);
  }
});

export default router;
