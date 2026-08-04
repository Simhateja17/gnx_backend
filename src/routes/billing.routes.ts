import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireBillingManager } from '../middleware/billing.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkoutSchema, checkoutVerifySchema, subscriptionChangeSchema } from '../schemas/billing.schema';
import * as billingService from '../services/billing.service';
import { AppError } from '../types';
import { supabase } from '../lib/supabase';

const router = Router();

router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/usage', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [emailsResult, usersResult, campaignsResult, subscription] = await Promise.all([
      supabase
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('status', 'sent')
        .gte('sent_at', monthStart),
      supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId),
      supabase
        .from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('status', 'active'),
      billingService.getSubscriptionForOrganization(orgId),
    ]);

    res.json({
      emailsSentThisMonth: emailsResult.count ?? 0,
      seatsUsed: usersResult.count ?? 0,
      activeCampaigns: campaignsResult.count ?? 0,
      plan: subscription?.plan_id ?? req.organization?.plan_id ?? 'starter',
      subscriptionStatus: req.organization?.subscription_status ?? 'payment_required',
      canManageBilling: req.user?.role === 'admin' || req.organization?.billing_manager_user_id === req.user?.id,
      subscription: subscription ? {
        providerStatus: subscription.status,
        billingPeriod: subscription.billing_period,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtCycleEnd: Boolean(subscription.cancel_at_cycle_end),
        scheduledPlanId: subscription.scheduled_plan_id,
        scheduledBillingPeriod: subscription.scheduled_billing_period,
      } : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', requireBillingManager, validate(checkoutSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await billingService.createSubscription(getOrgId(req), req.body.planId, req.body.billingPeriod));
  } catch (err) {
    next(err);
  }
});

router.post('/checkout/verify', requireBillingManager, validate(checkoutVerifySchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await billingService.verifyCheckoutSignature(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.patch('/subscription', requireBillingManager, validate(subscriptionChangeSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await billingService.changeSubscription(getOrgId(req), req.body.planId, req.body.billingPeriod));
  } catch (err) {
    next(err);
  }
});

router.post('/cancel', requireBillingManager, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await billingService.cancelSubscription(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.get('/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await billingService.getBillingHistory(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

export default router;
