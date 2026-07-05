import { Resend } from 'resend';
import { env } from '../config/env';

// Created lazily, not at module load: constructing this eagerly with an empty
// key throws immediately and would crash every request in any environment
// where RESEND_API_KEY isn't set, since this module gets imported regardless
// of whether Resend is actually used.
let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!env.RESEND_API_KEY) {
    throw new Error('Resend is not configured (RESEND_API_KEY is missing)');
  }
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY);
  }
  return resendClient;
}

export async function sendSupportReplyNotification(input: {
  to: string;
  userName: string;
  subject: string;
  ticketId: string;
  message: string;
}) {
  const preview = input.message.replace(/\s+/g, ' ').trim().slice(0, 240);

  return getResendClient().emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: input.to,
    subject: `Support replied: ${input.subject}`,
    text: [
      `Hi ${input.userName || 'there'},`,
      '',
      `Support replied to your ticket: ${input.subject}`,
      '',
      preview,
      '',
      `Open Globonexo Support to continue the conversation. Ticket ID: ${input.ticketId}`,
    ].join('\n'),
  });
}
