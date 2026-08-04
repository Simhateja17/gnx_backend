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

const BILLING_EMAIL_COPY: Record<'reminder' | 'grace_period' | 'restricted', (input: { orgName: string; graceDays?: number }) => { subject: string; text: string }> = {
  reminder: ({ orgName }) => ({
    subject: 'Your Globonexo plan renews soon',
    text: `Hi,\n\n${orgName}'s current billing period is ending in the next few days. Visit the Billing page in the app to renew and avoid any interruption.\n\n— Globonexo`,
  }),
  grace_period: ({ orgName, graceDays }) => ({
    subject: 'Payment needed — Globonexo billing period ended',
    text: `Hi,\n\n${orgName}'s billing period has ended and we haven't received a renewal payment yet. You have ${graceDays} day(s) of grace before access is restricted. Visit the Billing page in the app to renew.\n\n— Globonexo`,
  }),
  restricted: ({ orgName }) => ({
    subject: 'Access restricted — Globonexo billing overdue',
    text: `Hi,\n\n${orgName}'s grace period has ended without a renewal payment, so account access has been restricted. Visit the Billing page in the app to renew and restore full access.\n\n— Globonexo`,
  }),
};

export async function sendBillingReminderEmail(input: {
  to: string;
  orgName: string;
  kind: 'reminder' | 'grace_period' | 'restricted';
  graceDays?: number;
}) {
  const { subject, text } = BILLING_EMAIL_COPY[input.kind](input);

  return getResendClient().emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: input.to,
    subject,
    text,
  });
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
