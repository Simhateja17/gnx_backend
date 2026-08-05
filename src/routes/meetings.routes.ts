import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { listMeetings } from '../services/meetings.service';
import { cancelMeetingById } from '../services/calendar.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await listMeetings(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.delete('/:meetingId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await cancelMeetingById(getOrgId(req), req.params.meetingId));
  } catch (err) {
    next(err);
  }
});

export default router;
