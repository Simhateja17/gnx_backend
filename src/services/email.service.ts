import { supabase } from '../lib/supabase';
import { sendGmailMessage } from '../lib/gmail';
import { generateEmail } from './ai.service';
import { AppError } from '../types';

const UNSUBSCRIBE_FOOTER = `\n\n---\nIf you'd like to stop receiving emails, reply "unsubscribe"\nGlobonexo | Company Address`;

async function getGmailCredentials(organizationId: string) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('provider_account_id,access_token,refresh_token')
    .eq('organization_id', organizationId)
    .eq('provider', 'gmail')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch Gmail credentials', error);
  if (!data || !data.access_token) throw new AppError(400, 'Gmail is not connected for this organization');

  return {
    email: data.provider_account_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

async function getTodaySentCount(organizationId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'sent')
    .gte('sent_at', startOfDay.toISOString());

  if (error) throw new AppError(500, 'Failed to count sent emails', error);
  return count ?? 0;
}

async function getDailySendCap(organizationId: string) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('daily_email_send_cap')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch send cap', error);
  return data?.daily_email_send_cap ?? 100;
}

export async function checkSendCap(organizationId: string) {
  const [sentToday, cap] = await Promise.all([
    getTodaySentCount(organizationId),
    getDailySendCap(organizationId),
  ]);

  return {
    sentToday,
    cap,
    remaining: Math.max(0, cap - sentToday),
    paused: sentToday >= cap,
  };
}

export async function sendEmail(emailMessageId: string, organizationId: string) {
  const capStatus = await checkSendCap(organizationId);
  if (capStatus.paused) {
    console.log(`[send-email] Daily cap reached (${capStatus.sentToday}/${capStatus.cap}), skipping ${emailMessageId}`);
    return { success: false, reason: 'daily_cap_reached', sentToday: capStatus.sentToday, cap: capStatus.cap };
  }

  const { data: msg, error: msgError } = await supabase
    .from('email_messages')
    .select('*, leads(id, email, first_name, last_name, name, title, company)')
    .eq('id', emailMessageId)
    .eq('organization_id', organizationId)
    .single();

  if (msgError || !msg) throw new AppError(404, 'Email message not found');

  const toEmail = msg.leads?.email;
  if (!toEmail) throw new AppError(400, 'Lead has no email address');

  let subject = msg.subject;
  let body = msg.body;

  if (!subject || !body) {
    const campaignId = msg.campaign_id;
    const leadId = msg.lead_id;
    const stepNumber = msg.step_number ?? 1;

    if (campaignId && leadId) {
      const generated = await generateEmail(organizationId, { campaignId, leadId, stepNumber });
      subject = subject || generated.subject;
      body = body || generated.body;

      await supabase
        .from('email_messages')
        .update({ subject, body })
        .eq('id', emailMessageId);
    }
  }

  if (!subject || !body) throw new AppError(400, 'Email has no subject or body and could not be generated');

  body += UNSUBSCRIBE_FOOTER;

  const gmail = await getGmailCredentials(organizationId);

  try {
    const result = await sendGmailMessage(
      gmail.accessToken,
      gmail.refreshToken,
      gmail.email,
      toEmail,
      subject,
      body,
    );

    await supabase
      .from('email_messages')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        gmail_message_id: result.messageId,
        gmail_thread_id: result.threadId,
      })
      .eq('id', emailMessageId);

    await supabase
      .from('leads')
      .update({ status: 'contacted', updated_at: new Date().toISOString() })
      .eq('id', msg.lead_id)
      .eq('status', 'queued');

    return { success: true, gmailMessageId: result.messageId };
  } catch (err: any) {
    await supabase
      .from('email_messages')
      .update({ status: 'failed' })
      .eq('id', emailMessageId);

    throw new AppError(502, `Gmail send failed: ${err.message}`);
  }
}
