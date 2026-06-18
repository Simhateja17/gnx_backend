import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { updateSettingsSchema } from '../schemas/settings.schema';
import * as settingsService from '../services/settings.service';

const router = Router();

router.get('/', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await settingsService.getSettings(req.user.id, req.organization.id));
  } catch (err) {
    next(err);
  }
});

router.put('/', authenticate, validate(updateSettingsSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await settingsService.updateSettings(req.user.id, req.organization.id, req.body));
  } catch (err) {
    next(err);
  }
});

export default router;
