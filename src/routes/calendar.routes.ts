import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { validate } from '../middleware/validate.middleware';
import { updateCalendarSettingsSchema } from '../schemas/calendar.schema';
import { AppError } from '../types';
import * as calendarService from '../services/calendar.service';

const router = Router();
router.use(authenticate);
router.use(requireActiveSubscription);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/settings', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await calendarService.getCalendarSettings(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.put('/settings', validate(updateCalendarSettingsSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await calendarService.updateCalendarSettings(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

export default router;
