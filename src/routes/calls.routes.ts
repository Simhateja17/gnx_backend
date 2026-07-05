import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { supabase } from '../lib/supabase';
import * as voiceService from '../services/voice.service';
import { AppError } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { campaignId, status } = req.query;

    let query = supabase
      .from('calls')
      .select('*, leads(name, first_name, last_name, company), campaigns(name)')
      .eq('organization_id', req.organization.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (campaignId) query = query.eq('campaign_id', campaignId as string);
    if (status) query = query.eq('status', status as string);

    const { data, error } = await query;
    if (error) throw new AppError(500, 'Failed to fetch calls');

    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

router.post('/:callId/retry', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await voiceService.retryCall(req.params.callId, req.organization.id);
    res.json({ message: 'Call re-queued successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;
