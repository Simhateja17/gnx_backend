import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
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
      plan: req.organization?.plan ?? 'starter',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', (_req, res) => res.json({
  status: 'coming_soon',
  message: 'Billing is launching soon — you have full access during early access.',
}));
router.post('/portal', (_req, res) => res.json({
  status: 'coming_soon',
  message: 'The billing portal is launching soon — reach out to support for plan changes in the meantime.',
}));

export default router;
