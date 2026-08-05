import { supabase } from '../lib/supabase';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { generateReply } from './ai.service';
import { getNextStepNumber } from './email.service';
import { AppError } from '../types';

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bstop emailing\b/i,
  /\bremove me\b/i,
  /\bopt out\b/i,
  /\bdon'?t contact\b/i,
  /\bdo not contact\b/i,
];

export type InboundReplyContext = {
  organizationId: string;
  emailMessageId: string;
  leadId: string;
  campaignId: string | null;
  subject: string | null;
  provider: 'gmail' | 'smtp';
  providerMessageId: string;
  providerThreadId: string | null;
  body: string;
  receivedAt: string;
  autoApproveReplies: boolean;
};

export function isUnsubscribeReply(body: string) {
  return UNSUBSCRIBE_PATTERNS.some(pattern => pattern.test(body));
}

// Plain-text replies include the original message quoted below the new text.
// Removing it prevents our own unsubscribe footer from being misclassified as
// a prospect opt-out and keeps the AI draft focused on the new reply.
export function stripQuotedText(body: string): string {
  const lines = body.split(/\r?\n/);
  const quoteStartIndex = lines.findIndex(
    line => /^>/.test(line.trim()) || /^On .+wrote:\s*$/.test(line.trim()),
  );
  const kept = quoteStartIndex === -1 ? lines : lines.slice(0, quoteStartIndex);
  return kept.join('\n').trim();
}

export async function processInboundReply(input: InboundReplyContext) {
  const body = stripQuotedText(input.body);
  if (!body) return { processed: false, reason: 'empty_body' as const };

  const unsubscribed = isUnsubscribeReply(body);
  // Gmail supplies a stable thread ID. IMAP does not, so for custom mailboxes
  // the inbound Message-ID is the correct parent for an automated reply.
  const replyThreadId = input.provider === 'smtp'
    ? input.providerMessageId
    : input.providerThreadId;
  const { data: insertedReply, error: replyError } = await supabase
    .from('email_replies')
    .insert({
      organization_id: input.organizationId,
      email_message_id: input.emailMessageId,
      lead_id: input.leadId,
      body,
      provider_message_id: input.providerMessageId,
      provider_thread_id: replyThreadId,
      gmail_message_id: input.provider === 'gmail' ? input.providerMessageId : null,
      gmail_thread_id: input.provider === 'gmail' ? replyThreadId : null,
      ai_draft_status: unsubscribed ? 'rejected' : 'pending',
      received_at: input.receivedAt,
    })
    .select('id')
    .single();

  if (replyError || !insertedReply) {
    // The unique provider-message index makes retries idempotent. A duplicate
    // is a successful no-op, not a failed poll.
    if (replyError?.code === '23505') return { processed: false, reason: 'duplicate' as const };
    throw new AppError(500, 'Failed to save email reply', replyError);
  }

  await supabase
    .from('leads')
    .update({ status: unsubscribed ? 'unsubscribed' : 'engaged', updated_at: new Date().toISOString() })
    .eq('id', input.leadId);

  if (!unsubscribed) {
    await saveAiDraftReply({
      organizationId: input.organizationId,
      emailReplyId: insertedReply.id,
      originalMessage: {
        id: input.emailMessageId,
        lead_id: input.leadId,
        campaign_id: input.campaignId,
        subject: input.subject,
        provider_thread_id: replyThreadId,
        gmail_thread_id: input.provider === 'gmail' ? replyThreadId : null,
      },
      autoApproveReplies: input.autoApproveReplies,
    });
  }

  return { processed: true, replyId: insertedReply.id };
}

async function saveAiDraftReply(input: {
  organizationId: string;
  emailReplyId: string;
  originalMessage: {
    id: string;
    lead_id: string;
    campaign_id: string | null;
    subject: string | null;
    provider_thread_id: string | null;
    gmail_thread_id: string | null;
  };
  autoApproveReplies: boolean;
}) {
  const { organizationId, emailReplyId, originalMessage, autoApproveReplies } = input;
  const generated = await generateReply(organizationId, { emailReplyId });

  let replyMessageId: string | null = null;
  if (autoApproveReplies) {
    const subject = originalMessage.subject?.toLowerCase().startsWith('re:')
      ? originalMessage.subject
      : `Re: ${originalMessage.subject || 'Your message'}`;
    const nextStepNumber = await getNextStepNumber(originalMessage.lead_id, originalMessage.campaign_id);

    const { data: replyMessage, error: messageError } = await supabase
      .from('email_messages')
      .insert({
        organization_id: organizationId,
        campaign_id: originalMessage.campaign_id,
        lead_id: originalMessage.lead_id,
        step_number: nextStepNumber,
        subject,
        body: generated.body,
        provider_thread_id: originalMessage.provider_thread_id,
        gmail_thread_id: originalMessage.gmail_thread_id,
        status: 'queued',
      })
      .select('id')
      .single();

    if (messageError || !replyMessage) throw new AppError(500, 'Failed to queue approved AI reply', messageError);
    replyMessageId = replyMessage.id;
  }

  await supabase
    .from('email_replies')
    .update({
      ai_draft_reply: generated.body,
      ai_draft_status: autoApproveReplies ? 'sent' : 'pending',
    })
    .eq('id', emailReplyId)
    .eq('organization_id', organizationId);

  if (replyMessageId) {
    await enqueueSendEmail({
      emailMessageId: replyMessageId,
      organizationId,
      campaignId: originalMessage.campaign_id ?? undefined,
      leadId: originalMessage.lead_id,
    }, {
      jobId: `send-email-${replyMessageId}`,
    });
  }
}
