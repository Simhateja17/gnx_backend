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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);

    const { data: replies, error } = await supabase
      .from('email_replies')
      .select('id, body, ai_draft_status, received_at, email_message_id, lead_id, leads(name, first_name, last_name, company), email_messages(subject)')
      .eq('organization_id', orgId)
      .order('received_at', { ascending: false })
      .limit(50);

    if (error) throw new AppError(500, 'Failed to fetch inbox threads');

    const threads = (replies ?? []).map(reply => {
      const lead = reply.leads as any;
      const msg = reply.email_messages as any;
      const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.name || 'Unknown';
      return {
        id: reply.id,
        leadId: reply.lead_id,
        name,
        company: lead?.company || '',
        subject: msg?.subject || 'No subject',
        preview: (reply.body || '').slice(0, 120),
        aiDraftStatus: reply.ai_draft_status,
        time: timeAgo(reply.received_at),
        receivedAt: reply.received_at,
        emailMessageId: reply.email_message_id,
      };
    });

    res.json({ threads });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { data: reply, error } = await supabase
      .from('email_replies')
      .select('id, body, ai_draft_reply, ai_draft_status, received_at, email_message_id, lead_id, leads(name, first_name, last_name, company, email, title), email_messages(subject, body, sent_at)')
      .eq('organization_id', orgId)
      .eq('id', req.params.id)
      .single();

    if (error || !reply) throw new AppError(404, 'Thread not found');

    res.json(reply);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reply', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ todo: 'send manual reply', id: req.params.id });
  } catch (err) {
    next(err);
  }
});

export default router;
