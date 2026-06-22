import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { generateEmailSchema, generateReplySchema, generateVoicePromptSchema } from '../schemas/ai.schema';
import * as aiService from '../services/ai.service';

const router = Router();

router.use(authenticate);

router.post(
  '/generate-email',
  validate(generateEmailSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await aiService.generateEmail(req.organization.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/generate-reply',
  validate(generateReplySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await aiService.generateReply(req.organization.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/generate-voice-prompt',
  validate(generateVoicePromptSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await aiService.generateVoicePrompt(req.organization.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
