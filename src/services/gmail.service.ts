import { google } from 'googleapis';
import { supabase } from '../lib/supabase';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { generateReply } from './ai.service';
import { AppError } from '../types';

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bstop emailing\b/i,
  /\bremove me\b/i,
  /\bopt out\b/i,
  /\bdon'?t contact\b/i,
  /\bdo not contact\b/i,
];

function createOAuth2Client(accessToken: string, refreshToken: string) {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return oauth2;
}

export async function pollInbox(organizationId: string, connectedAccountId: string) {
  const { data: account, error: accError } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', connectedAccountId)
    .eq('organization_id', organizationId)
    .eq('provider', 'gmail')
    .single();

  if (accError || !account) throw new AppError(404, 'Connected Gmail account not found');
  if (!account.access_token) throw new AppError(400, 'Gmail account missing access token');

  const { data: config, error: configError } = await supabase
    .from('agent_configs')
    .select('auto_approve_replies')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (configError) throw new AppError(500, 'Failed to fetch reply approval setting', configError);

  const auth = createOAuth2Client(account.access_token, account.refresh_token ?? '');
  const gmail = google.gmail({ version: 'v1', auth });
  const autoApproveReplies = config?.auto_approve_replies ?? false;

  const { data: trackedThreads } = await supabase
    .from('email_messages')
    .select('gmail_thread_id')
    .eq('organization_id', organizationId)
    .not('gmail_thread_id', 'is', null);

  const threadIds = [...new Set((trackedThreads ?? []).map(t => t.gmail_thread_id).filter(Boolean))];
  if (threadIds.length === 0) return { newReplies: 0 };

  let newReplies = 0;

  for (const threadId of threadIds) {
    try {
      const thread = await gmail.users.threads.get({ userId: 'me', id: threadId! });
      const messages = thread.data.messages ?? [];

      const { data: existingReplyIds } = await supabase
        .from('email_replies')
        .select('gmail_message_id')
        .eq('organization_id', organizationId);
      const knownIds = new Set((existingReplyIds ?? []).map(r => r.gmail_message_id));

      const { data: ourMessageIds } = await supabase
        .from('email_messages')
        .select('gmail_message_id')
        .eq('gmail_thread_id', threadId);
      const ourIds = new Set((ourMessageIds ?? []).map(m => m.gmail_message_id));

      for (const message of messages) {
        const msgId = message.id;
        if (!msgId || ourIds.has(msgId) || knownIds.has(msgId)) continue;

        const body = extractPlainTextBody(message);
        if (!body) continue;

        const { data: originalMsg } = await supabase
          .from('email_messages')
          .select('id, lead_id, campaign_id, subject, gmail_thread_id')
          .eq('gmail_thread_id', threadId)
          .eq('organization_id', organizationId)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();

        if (!originalMsg) continue;
        const unsubscribed = isUnsubscribeReply(body);

        const { data: insertedReply, error: replyError } = await supabase
          .from('email_replies')
          .insert({
            organization_id: organizationId,
            email_message_id: originalMsg.id,
            lead_id: originalMsg.lead_id,
            body,
            gmail_message_id: msgId,
            ai_draft_status: unsubscribed ? 'rejected' : 'pending',
            received_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (replyError || !insertedReply) throw new AppError(500, 'Failed to save email reply', replyError);

        await supabase
          .from('leads')
          .update({ status: unsubscribed ? 'unsubscribed' : 'engaged', updated_at: new Date().toISOString() })
          .eq('id', originalMsg.lead_id);

        if (!unsubscribed) {
          await saveAiDraftReply({
            organizationId,
            emailReplyId: insertedReply.id,
            originalMessage: originalMsg,
            autoApproveReplies,
          });
        }

        newReplies++;
      }
    } catch (err: any) {
      console.error(`[poll-inbox] Error processing thread ${threadId}:`, err.message);
    }
  }

  return { newReplies };
}

async function saveAiDraftReply(input: {
  organizationId: string;
  emailReplyId: string;
  originalMessage: {
    id: string;
    lead_id: string;
    campaign_id: string | null;
    subject: string | null;
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

    const { data: replyMessage, error: messageError } = await supabase
      .from('email_messages')
      .insert({
        organization_id: organizationId,
        campaign_id: originalMessage.campaign_id,
        lead_id: originalMessage.lead_id,
        step_number: 1,
        subject,
        body: generated.body,
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

function isUnsubscribeReply(body: string) {
  return UNSUBSCRIBE_PATTERNS.some(pattern => pattern.test(body));
}

function extractPlainTextBody(message: any): string | null {
  const payload = message.payload;
  if (!payload) return null;

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  const parts = payload.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
  }

  return null;
}
