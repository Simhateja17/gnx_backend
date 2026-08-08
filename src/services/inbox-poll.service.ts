import { getEmailConnection } from './email-connection.service';
import { pollGmailInbox } from './gmail.service';
import { pollSmtpInbox } from './smtp.service';
import { AppError } from '../types';

export async function pollInbox(organizationId: string, connectedAccountId: string) {
  const connection = await getEmailConnection(organizationId, connectedAccountId);
  // A recurring job can outlive a provider switch or disconnect. Treat that
  // stale job as a no-op instead of retrying forever against a deleted or
  // inactive connection.
  if (!connection) return { newReplies: 0, skipped: true };
  if (connection.provider === 'gmail') return pollGmailInbox(organizationId, connectedAccountId);
  if (connection.provider === 'smtp') return pollSmtpInbox(organizationId, connectedAccountId);
  throw new AppError(400, `Unsupported email provider: ${connection.provider}`);
}
