import { supabase } from '../lib/supabase';
import { fetchImapMessages, parseIncomingMessage } from '../lib/smtp';
import {
  getEmailConnection,
  smtpConfigFromConnection,
  updateSmtpPollCursor,
} from './email-connection.service';
import { processInboundReply } from './reply-processing.service';
import { AppError } from '../types';

type TrackedMessage = {
  id: string;
  lead_id: string;
  campaign_id: string | null;
  subject: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  created_at: string;
  leads: { email: string | null } | null;
};

function asMessageIds(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(item => item.trim()).filter(Boolean);
}

function normalizedSubject(value: string | null | undefined): string {
  return (value ?? '').replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

export async function pollSmtpInbox(organizationId: string, connectedAccountId: string) {
  const connection = await getEmailConnection(organizationId, connectedAccountId);
  if (!connection || connection.provider !== 'smtp') {
    throw new AppError(404, 'Connected SMTP account not found');
  }
  if (!connection.metadata) throw new AppError(400, 'SMTP connection metadata is missing');

  const { imap } = smtpConfigFromConnection(connection);
  const { data: config, error: configError } = await supabase
    .from('agent_configs')
    .select('auto_approve_replies')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (configError) throw new AppError(500, 'Failed to fetch reply approval setting', configError);

  const { data: tracked, error: trackedError } = await supabase
    .from('email_messages')
    .select('id,lead_id,campaign_id,subject,provider_message_id,provider_thread_id,created_at,leads(email)')
    .eq('organization_id', organizationId)
    .is('gmail_message_id', null)
    .not('provider_message_id', 'is', null)
    .order('created_at', { ascending: true });
  if (trackedError) throw new AppError(500, 'Failed to fetch SMTP message threads', trackedError);

  const trackedMessages = (tracked ?? []) as unknown as TrackedMessage[];
  if (trackedMessages.length === 0) return { newReplies: 0 };

  const { data: existingReplies, error: repliesError } = await supabase
    .from('email_replies')
    .select('provider_message_id')
    .eq('organization_id', organizationId)
    .is('gmail_message_id', null)
    .not('provider_message_id', 'is', null);
  if (repliesError) throw new AppError(500, 'Failed to fetch known SMTP replies', repliesError);
  const knownIds = new Set((existingReplies ?? []).map(row => row.provider_message_id).filter(Boolean));

  const lastImapUid = Number((connection.metadata as any).lastImapUid ?? 0);
  const search = lastImapUid > 0
    ? { uid: `${lastImapUid + 1}:*` }
    : { since: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) };
  const messages = await fetchImapMessages(imap, search);
  let newReplies = 0;
  let highestUid = lastImapUid;

  for (const message of messages) {
    highestUid = Math.max(highestUid, message.uid);
    try {
      const parsed = await parseIncomingMessage(message.source);
      const providerMessageId = parsed.messageId?.trim();
      if (!providerMessageId || knownIds.has(providerMessageId)) continue;

      const sender = parsed.from?.value?.[0]?.address?.toLowerCase() ?? '';
      if (!sender || sender === connection.email.toLowerCase()) continue;

      const referencedIds = new Set([
        ...asMessageIds(parsed.inReplyTo),
        ...asMessageIds(parsed.references),
      ]);
      let original = trackedMessages.find(item =>
        item.provider_message_id ? referencedIds.has(item.provider_message_id) : false,
      );

      // Some providers strip In-Reply-To/References. Fall back to the lead's
      // email address plus normalized subject for those messages.
      if (!original) {
        original = trackedMessages.find(item =>
          item.leads?.email?.toLowerCase() === sender &&
          normalizedSubject(item.subject) === normalizedSubject(parsed.subject),
        );
      }
      if (!original) continue;

      const result = await processInboundReply({
        organizationId,
        emailMessageId: original.id,
        leadId: original.lead_id,
        campaignId: original.campaign_id,
        subject: original.subject,
        provider: 'smtp',
        providerMessageId,
        providerThreadId: original.provider_thread_id ?? original.provider_message_id,
        body: parsed.text ?? '',
        receivedAt: (parsed.date ?? message.internalDate ?? new Date()).toISOString(),
        autoApproveReplies: config?.auto_approve_replies ?? false,
      });

      if (result.processed) {
        knownIds.add(providerMessageId);
        newReplies++;
      }
    } catch (error: any) {
      console.error(`[poll-inbox] Failed to parse/process SMTP message UID ${message.uid}:`, error?.message ?? error);
    }
  }

  if (highestUid > lastImapUid) {
    await updateSmtpPollCursor(connection.id, connection.metadata, highestUid);
  }

  return { newReplies };
}
