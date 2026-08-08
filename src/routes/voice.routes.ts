import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import * as voiceService from '../services/voice.service';
import { listRetellPhoneNumbers, provisionIncludedRetellPhoneNumber } from '../services/retell-phone.service';
import { z } from 'zod';
import { validate } from '../middleware/validate.middleware';
import { getInboundVoiceStatus, updateInboundVoiceSettings } from '../services/inbound-voice.service';

const router = Router();

const inboundSettingsSchema = z.object({
  enabled: z.boolean(),
  dailyMinuteLimit: z.number().int().min(1).max(60).optional(),
});

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

router.get('/inbound', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getInboundVoiceStatus(req.organization.id));
  } catch (err) {
    next(err);
  }
});

router.put('/inbound', validate(inboundSettingsSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await updateInboundVoiceSettings(req.organization.id, req.body));
  } catch (err) {
    next(err);
  }
});

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
