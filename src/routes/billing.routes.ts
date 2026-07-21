import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { checkoutSchema, checkoutVerifySchema } from '../schemas/billing.schema';
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

    const [emailsResult, usersResult, campaignsResult] = await Promise.all([
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
    ]);

    res.json({
      emailsSentThisMonth: emailsResult.count ?? 0,
      seatsUsed: usersResult.count ?? 0,
      activeCampaigns: campaignsResult.count ?? 0,
      plan: req.organization?.plan_id ?? 'starter',
      subscriptionStatus: req.organization?.subscription_status ?? 'trialing',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', validate(checkoutSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { planId, billingPeriod } = req.body;
    const order = await billingService.createOrder(orgId, planId, billingPeriod);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

router.post('/checkout/verify', validate(checkoutVerifySchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const result = await billingService.verifyCheckoutSignature(orgId, req.body);
    res.json(result);
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
