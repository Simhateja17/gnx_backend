import { Resend } from 'resend';
import { env } from '../config/env';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

const resend = new Resend(env.RESEND_API_KEY);

export async function sendEmail(emailMessageId: string, organizationId: string) {
  const { data: msg, error: msgError } = await supabase
    .from('email_messages')
    .select('*, leads(email, first_name, last_name)')
    .eq('id', emailMessageId)
    .eq('organization_id', organizationId)
    .single();

  if (msgError || !msg) throw new AppError(404, 'Email message not found');

  const toEmail = msg.leads?.email;
  if (!toEmail) throw new AppError(400, 'Lead has no email address');

  const toName = [msg.leads.first_name, msg.leads.last_name].filter(Boolean).join(' ');

  const { data: result, error: sendError } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: toEmail,
    subject: msg.subject,
    text: msg.body,
    headers: toName ? { 'X-Lead-Name': toName } : undefined,
  });

  if (sendError) {
    await supabase
      .from('email_messages')
      .update({ status: 'failed' })
      .eq('id', emailMessageId);
    throw new AppError(502, `Email send failed: ${sendError.message}`);
  }

  await supabase
    .from('email_messages')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      gmail_message_id: result?.id ?? null,
    })
    .eq('id', emailMessageId);

  await supabase
    .from('leads')
    .update({ status: 'contacted', updated_at: new Date().toISOString() })
    .eq('id', msg.lead_id)
    .eq('status', 'queued');

  return { success: true, resendId: result?.id };
}
