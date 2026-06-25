import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { checkSendCap } from '../services/email.service';
import { AppError } from '../types';

const router = Router();
router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/send-cap', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await checkSendCap(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/:replyId/approve', (req, res) => res.json({ todo: 'approve reply', replyId: req.params.replyId }));
router.post('/:replyId/regenerate', (req, res) => res.json({ todo: 'regenerate reply', replyId: req.params.replyId }));
router.post('/send-test', (_req, res) => res.json({ todo: 'send test email' }));

export default router;
