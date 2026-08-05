import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { AppError } from '../types';
import { supabase } from '../lib/supabase';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { generateEmail } from '../services/ai.service';
import { getNextStepNumber } from '../services/email.service';

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

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

function leadName(lead: any) {
  return [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.name || 'Unknown';
}

function sentMessageId(id: string) {
  return id.startsWith('sent:') ? id.slice(5) : id;
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);

    const [repliesResult, messagesResult] = await Promise.all([
      supabase
        .from('email_replies')
        .select('id, body, ai_draft_status, received_at, email_message_id, lead_id, leads(name, first_name, last_name, company, email), email_messages(subject)')
        .eq('organization_id', orgId)
        .order('received_at', { ascending: false })
        .limit(50),
      supabase
        .from('email_messages')
        .select('id, subject, body, status, sent_at, created_at, lead_id, leads(name, first_name, last_name, company, email)')
        .eq('organization_id', orgId)
        .in('status', ['queued', 'sent', 'failed', 'bounced'])
        .order('sent_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    if (repliesResult.error || messagesResult.error) {
      throw new AppError(500, 'Failed to fetch inbox threads', repliesResult.error ?? messagesResult.error);
    }

    const sentEmailMessageIds = new Set<string>();
    const sentLeadIds = new Set<string>();

    const replyThreads = (repliesResult.data ?? []).map(reply => {
      const lead = reply.leads as any;
      const msg = reply.email_messages as any;
      if (reply.email_message_id) sentEmailMessageIds.add(reply.email_message_id);
      if (reply.lead_id) sentLeadIds.add(reply.lead_id);
      return {
        id: reply.id,
        kind: 'reply',
        leadId: reply.lead_id,
        name: leadName(lead),
        company: lead?.company || '',
        email: lead?.email || '',
        subject: msg?.subject || 'No subject',
        preview: (reply.body || '').slice(0, 120),
        aiDraftStatus: reply.ai_draft_status,
        time: timeAgo(reply.received_at),
        receivedAt: reply.received_at,
        emailMessageId: reply.email_message_id,
      };
    });

    const sentThreads = [];
    for (const message of messagesResult.data ?? []) {
      if (sentEmailMessageIds.has(message.id) || sentLeadIds.has(message.lead_id)) continue;
      sentEmailMessageIds.add(message.id);
      sentLeadIds.add(message.lead_id);

      const lead = message.leads as any;
      const date = message.sent_at ?? message.created_at;
      sentThreads.push({
        id: `sent:${message.id}`,
        kind: 'sent',
        leadId: message.lead_id,
        name: leadName(lead),
        company: lead?.company || '',
        email: lead?.email || '',
        subject: message.subject || 'No subject',
        preview: (message.body || '').slice(0, 120),
        aiDraftStatus: message.status,
        time: timeAgo(date),
        sentAt: message.sent_at,
        createdAt: message.created_at,
        emailMessageId: message.id,
      });
    }

    res.json({ threads: [...replyThreads, ...sentThreads] });
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
      .maybeSingle();

    if (error) throw new AppError(500, 'Failed to fetch thread', error);
    if (reply) {
      res.json(reply);
      return;
    }

    const { data: message, error: messageError } = await supabase
      .from('email_messages')
      .select('id, subject, body, status, sent_at, created_at, lead_id, leads(name, first_name, last_name, company, email, title)')
      .eq('organization_id', orgId)
      .eq('id', sentMessageId(req.params.id))
      .maybeSingle();

    if (messageError) throw new AppError(500, 'Failed to fetch thread', messageError);
    if (!message) throw new AppError(404, 'Thread not found');

    res.json({
      id: `sent:${message.id}`,
      kind: 'sent',
      lead_id: message.lead_id,
      leads: message.leads,
      email_messages: {
        id: message.id,
        subject: message.subject,
        body: message.body,
        status: message.status,
        sent_at: message.sent_at,
        created_at: message.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/draft-follow-up', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { data: message, error } = await supabase
      .from('email_messages')
      .select('id, campaign_id, lead_id, subject')
      .eq('organization_id', orgId)
      .eq('id', sentMessageId(req.params.id))
      .maybeSingle();

    if (error) throw new AppError(500, 'Failed to fetch sent email', error);
    if (!message) throw new AppError(404, 'Sent email not found');
    if (!message.campaign_id || !message.lead_id) throw new AppError(400, 'This sent email is not attached to a campaign lead');

    const stepNumber = await getNextStepNumber(message.lead_id, message.campaign_id);
    const generated = await generateEmail(orgId, {
      campaignId: message.campaign_id,
      leadId: message.lead_id,
      stepNumber,
    });

    res.json(generated);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/follow-up', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw new AppError(400, 'Follow-up body is required');

    const { data: message, error } = await supabase
      .from('email_messages')
      .select('id, campaign_id, lead_id, subject, gmail_thread_id, provider_thread_id')
      .eq('organization_id', orgId)
      .eq('id', sentMessageId(req.params.id))
      .maybeSingle();

    if (error) throw new AppError(500, 'Failed to fetch sent email', error);
    if (!message) throw new AppError(404, 'Sent email not found');

    const stepNumber = await getNextStepNumber(message.lead_id, message.campaign_id ?? null);
    const subject = message.subject?.toLowerCase().startsWith('re:')
      ? message.subject
      : `Re: ${message.subject || 'Your message'}`;

    const { data: queued, error: queueError } = await supabase
      .from('email_messages')
      .insert({
        organization_id: orgId,
        campaign_id: message.campaign_id ?? null,
        lead_id: message.lead_id,
        step_number: stepNumber,
        subject,
        body,
        provider_thread_id: message.provider_thread_id ?? message.gmail_thread_id ?? null,
        gmail_thread_id: message.gmail_thread_id ?? null,
        status: 'queued',
      })
      .select('id')
      .single();

    if (queueError || !queued) throw new AppError(500, 'Failed to queue follow-up email', queueError);

    await enqueueSendEmail({
      emailMessageId: queued.id,
      organizationId: orgId,
      campaignId: message.campaign_id ?? undefined,
      leadId: message.lead_id,
      stepNumber,
    }, {
      jobId: `send-email-${queued.id}`,
    });

    res.json({ id: queued.id, status: 'queued', queuedEmailMessageId: queued.id });
  } catch (err) {
    next(err);
  }
});

export default router;
