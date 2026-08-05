import { google } from 'googleapis';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { env } from '../config/env';
import { processInboundReply } from './reply-processing.service';

function createOAuth2Client(accessToken: string, refreshToken: string) {
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
  oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return oauth2;
}

export async function pollGmailInbox(organizationId: string, connectedAccountId: string) {
  const { data: account, error: accError } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', connectedAccountId)
    .eq('organization_id', organizationId)
    .eq('provider', 'gmail')
    .eq('is_active', true)
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
    .select('gmail_message_id,provider_message_id')
    .eq('organization_id', organizationId);
  const knownIds = new Set((existingReplies ?? [])
    .flatMap(r => [r.gmail_message_id, r.provider_message_id])
    .filter(Boolean));

  const { data: allOurMessages } = await supabase
    .from('email_messages')
    .select('id, lead_id, campaign_id, subject, gmail_thread_id, gmail_message_id, provider_thread_id, provider_message_id, created_at')
    .eq('organization_id', organizationId)
    .in('gmail_thread_id', threadIds)
    .order('created_at', { ascending: true });

  const ourIdsByThread = new Map<string, Set<string>>();
  const originalMsgByThread = new Map<string, {
    id: string;
    lead_id: string;
    campaign_id: string | null;
    subject: string | null;
    gmail_thread_id: string | null;
    provider_thread_id: string | null;
  }>();
  for (const m of allOurMessages ?? []) {
    if (!m.gmail_thread_id) continue;
    const providerMessageId = m.gmail_message_id ?? m.provider_message_id;
    if (providerMessageId) {
      if (!ourIdsByThread.has(m.gmail_thread_id)) ourIdsByThread.set(m.gmail_thread_id, new Set());
      ourIdsByThread.get(m.gmail_thread_id)!.add(providerMessageId);
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
        if (!originalMsg) continue;
        const result = await processInboundReply({
          organizationId,
          emailMessageId: originalMsg.id,
          leadId: originalMsg.lead_id,
          campaignId: originalMsg.campaign_id,
          subject: originalMsg.subject,
          provider: 'gmail',
          providerMessageId: msgId,
          providerThreadId: originalMsg.provider_thread_id ?? originalMsg.gmail_thread_id,
          body: rawBody,
          receivedAt: new Date().toISOString(),
          autoApproveReplies,
        });

        if (result.processed) newReplies++;
      }
    } catch (err: any) {
      console.error(`[poll-inbox] Error processing thread ${threadId}:`, err.message);
    }
  }

  return { newReplies };
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
