import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.middleware';
import { AppError } from '../types';

const ACCESS_STATUSES = ['active', 'past_due'];

// Checks req.organization.subscription_status, already loaded by `authenticate`.
// `past_due` is the seven-day provider-failure grace period. Every other
// customer state requires Billing; internal admins remain available for
// support and impersonation.
export function requireActiveSubscription(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  if (req.user?.role === 'admin') return next();
  const status = req.organization?.subscription_status;
  if (!ACCESS_STATUSES.includes(status)) {
    return next(new AppError(402, 'Please complete billing to continue.', { subscriptionStatus: status ?? 'payment_required' }));
  }
  next();
}

export function requireBillingManager(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  if (req.user?.role === 'admin' || req.organization?.billing_manager_user_id === req.user?.id) {
    return next();
  }
  next(new AppError(403, 'Only the billing manager can change the subscription.'));
}
