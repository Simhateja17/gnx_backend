import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import * as voiceService from '../services/voice.service';

const router = Router();

router.use(authenticate);

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
