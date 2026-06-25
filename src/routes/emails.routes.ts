import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  approveAiDraftReply,
  checkSendCap,
  regenerateAiDraftReply,
  rejectAiDraftReply,
  updateAiDraftReply,
} from '../services/email.service';
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

router.post('/:replyId/approve', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
    res.json(await approveAiDraftReply(getOrgId(req), req.params.replyId, body));
  } catch (err) {
    next(err);
  }
});

router.post('/:replyId/regenerate', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await regenerateAiDraftReply(getOrgId(req), req.params.replyId));
  } catch (err) {
    next(err);
  }
});

router.patch('/:replyId/draft', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await updateAiDraftReply(getOrgId(req), req.params.replyId, String(req.body?.body ?? '')));
  } catch (err) {
    next(err);
  }
});

router.post('/:replyId/reject', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await rejectAiDraftReply(getOrgId(req), req.params.replyId));
  } catch (err) {
    next(err);
  }
});

router.post('/send-test', (_req, res) => res.json({ todo: 'send test email' }));

export default router;
