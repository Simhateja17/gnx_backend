import { google } from 'googleapis';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

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

  const auth = createOAuth2Client(account.access_token, account.refresh_token ?? '');
  const gmail = google.gmail({ version: 'v1', auth });

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
          .select('id, lead_id')
          .eq('gmail_thread_id', threadId)
          .eq('organization_id', organizationId)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();

        if (!originalMsg) continue;

        await supabase.from('email_replies').insert({
          organization_id: organizationId,
          email_message_id: originalMsg.id,
          lead_id: originalMsg.lead_id,
          body,
          gmail_message_id: msgId,
          received_at: new Date().toISOString(),
        });

        await supabase
          .from('leads')
          .update({ status: 'engaged', updated_at: new Date().toISOString() })
          .eq('id', originalMsg.lead_id);

        newReplies++;
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
