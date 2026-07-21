import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.middleware';
import { AppError } from '../types';

const BLOCKED_STATUSES = ['restricted', 'suspended'];

// Checks req.organization.subscription_status, already loaded by `authenticate`
// on every request — no extra DB query here. Apply this per mutating/send
// route, never via a blanket router.use, so an org can still view its data
// and pay while restricted.
export function requireActiveSubscription(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const status = req.organization?.subscription_status;
  if (status && BLOCKED_STATUSES.includes(status)) {
    return next(new AppError(402, 'Your subscription is inactive. Please renew billing to continue.', { subscriptionStatus: status }));
  }
  next();
}
