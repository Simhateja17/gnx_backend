import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { onboardingPostSchema, onboardingPutSchema } from '../schemas/onboarding.schema';
import { submitOnboarding, getOnboarding } from '../services/onboarding.service';

const router = Router();

router.use(authenticate);

router.post('/', validate(onboardingPostSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await submitOnboarding(req.organization.id, req.body);
    res.status(201).json(result);
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
