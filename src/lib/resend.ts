import { Resend } from 'resend';
import { env } from '../config/env';

export const resend = new Resend(env.RESEND_API_KEY);

export async function sendSupportReplyNotification(input: {
  to: string;
  userName: string;
  subject: string;
  ticketId: string;
  message: string;
}) {
  const preview = input.message.replace(/\s+/g, ' ').trim().slice(0, 240);

  return resend.emails.send({
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
