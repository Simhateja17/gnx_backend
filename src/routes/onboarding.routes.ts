import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { validate } from '../middleware/validate.middleware';
import { onboardingPostSchema, onboardingPutSchema } from '../schemas/onboarding.schema';
import { submitOnboarding, getOnboarding } from '../services/onboarding.service';
import {
  getCurrentOnboardingPreparation,
  getOnboardingPreparation,
} from '../services/onboarding-preparation.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.post('/', validate(onboardingPostSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await submitOnboarding(req.organization.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/preparation', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : '';
    if (!campaignId) throw new AppError(400, 'campaignId is required');
    res.json(await getOnboardingPreparation(req.organization.id, campaignId));
  } catch (err) {
    next(err);
  }
});

router.get('/preparation/current', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getCurrentOnboardingPreparation(req.organization.id));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await getOnboarding(req.organization.id);
    res.json(data ?? null);
  } catch (err) {
    next(err);
  }
});

router.put('/', validate(onboardingPutSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await submitOnboarding(req.organization.id, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
