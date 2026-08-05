import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import * as voiceService from '../services/voice.service';
import { listRetellPhoneNumbers, provisionIncludedRetellPhoneNumber } from '../services/retell-phone.service';

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.get(
  '/phone-numbers',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await listRetellPhoneNumbers(req.organization.id));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/phone-numbers/retry',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await provisionIncludedRetellPhoneNumber(req.organization.id));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/agents',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await voiceService.createOrUpdateRetellAgent(req.organization.id);
      res.json({
        agentId: result.agentId,
        message: 'Voice agent ready. Add your phone number in Settings.',
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
