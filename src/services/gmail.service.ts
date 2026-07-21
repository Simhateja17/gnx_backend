import { google } from 'googleapis';
import { supabase } from '../lib/supabase';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { generateReply } from './ai.service';
import { getNextStepNumber } from './email.service';
import { AppError } from '../types';
import { env } from '../config/env';

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bstop emailing\b/i,
  /\bremove me\b/i,
  /\bopt out\b/i,
  /\bdon'?t contact\b/i,
  /\bdo not contact\b/i,
];

function createOAuth2Client(accessToken: string, refreshToken: string) {
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
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

  const threadIds = [...new Set((trackedThreads ?? []).map(t => t.gmail_thread_id).filter(Boolean))] as string[];
  if (threadIds.length === 0) return { newReplies: 0 };

  // Hoisted out of the per-thread loop below: these previously re-ran on
  // every thread iteration (existingReplyIds org-wide, ourMessageIds
  // per-thread), turning inbox polling into an N+1 query pattern that gets
  // slower as an org's tracked thread count grows. Fetched once here instead.
  const { data: existingReplies } = await supabase
    .from('email_replies')
    .select('gmail_message_id')
    .eq('organization_id', organizationId);
  const knownIds = new Set((existingReplies ?? []).map(r => r.gmail_message_id));

  const { data: allOurMessages } = await supabase
    .from('email_messages')
    .select('id, lead_id, campaign_id, subject, gmail_thread_id, gmail_message_id, created_at')
    .eq('organization_id', organizationId)
    .in('gmail_thread_id', threadIds)
    .order('created_at', { ascending: true });

  const ourIdsByThread = new Map<string, Set<string>>();
  const originalMsgByThread = new Map<string, { id: string; lead_id: string; campaign_id: string | null; subject: string | null; gmail_thread_id: string | null }>();
  for (const m of allOurMessages ?? []) {
    if (!m.gmail_thread_id) continue;
    if (m.gmail_message_id) {
      if (!ourIdsByThread.has(m.gmail_thread_id)) ourIdsByThread.set(m.gmail_thread_id, new Set());
      ourIdsByThread.get(m.gmail_thread_id)!.add(m.gmail_message_id);
    }
    // Rows are ordered oldest-first, so the first one seen per thread is the original message.
    if (!originalMsgByThread.has(m.gmail_thread_id)) originalMsgByThread.set(m.gmail_thread_id, m);
  }

  let newReplies = 0;

  for (const threadId of threadIds) {
    try {
      const thread = await gmail.users.threads.get({ userId: 'me', id: threadId });
      const messages = thread.data.messages ?? [];
      const ourIds = ourIdsByThread.get(threadId) ?? new Set();
      const originalMsg = originalMsgByThread.get(threadId);

      for (const message of messages) {
        const msgId = message.id;
        if (!msgId || ourIds.has(msgId) || knownIds.has(msgId)) continue;

        const rawBody = extractPlainTextBody(message);
        if (!rawBody) continue;
        const body = stripQuotedText(rawBody);
        if (!body) continue;

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

// Plain-text replies include the entire original message quoted below the
// new text (lines starting with '>', preceded by an 'On ... wrote:' line).
// Since every outbound email includes a CAN-SPAM 'reply "unsubscribe"'
// footer, leaving the quote in would make isUnsubscribeReply (and the AI
// reply-draft context) see that footer as if the prospect wrote it,
// misreading every single reply as an unsubscribe request.
function stripQuotedText(body: string): string {
  const lines = body.split(/\r?\n/);
  const quoteStartIndex = lines.findIndex(
    line => /^>/.test(line.trim()) || /^On .+wrote:\s*$/.test(line.trim())
  );
  const kept = quoteStartIndex === -1 ? lines : lines.slice(0, quoteStartIndex);
  return kept.join('\n').trim();
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
