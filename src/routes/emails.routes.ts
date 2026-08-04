import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import {
  approveAiDraftReply,
  approvePendingDraft,
  checkSendCap,
  regenerateAiDraftReply,
  rejectAiDraftReply,
  rejectPendingDraft,
  updateAiDraftReply,
  updatePendingDraft,
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

router.post('/:replyId/approve', requireActiveSubscription, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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

// Pending-review outbound drafts created by the AI agent's "draft follow-ups
// for no-replies" tool (email_messages.status = 'pending_review'), distinct
// from the AI-drafted-reply flow above (which operates on email_replies).
router.post('/drafts/:messageId/approve', requireActiveSubscription, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await approvePendingDraft(getOrgId(req), req.params.messageId));
  } catch (err) {
    next(err);
  }
});

router.post('/drafts/:messageId/reject', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await rejectPendingDraft(getOrgId(req), req.params.messageId));
  } catch (err) {
    next(err);
  }
});

router.patch('/drafts/:messageId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const subject = typeof req.body?.subject === 'string' ? req.body.subject : undefined;
    const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
    res.json(await updatePendingDraft(getOrgId(req), req.params.messageId, { subject, body }));
  } catch (err) {
    next(err);
  }
});

export default router;
