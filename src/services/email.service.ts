import { supabase } from '../lib/supabase';
import { sendGmailMessage } from '../lib/gmail';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { generateEmail, generateReply } from './ai.service';
import { posthog } from '../lib/posthog';
import { AppError } from '../types';

const UNSUBSCRIBE_FOOTER = `\n\n---\nIf you'd like to stop receiving emails, reply "unsubscribe"\nGlobonexo | Company Address`;
const STOP_SEQUENCE_STATUSES = ['engaged', 'meeting_booked', 'not_interested', 'unsubscribed'];

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

export async function approveAiDraftReply(organizationId: string, replyId: string, editedBody?: string) {
  const { data: reply, error } = await supabase
    .from('email_replies')
    .select('id, lead_id, ai_draft_reply, ai_draft_status, email_messages(subject, campaign_id, gmail_thread_id)')
    .eq('id', replyId)
    .eq('organization_id', organizationId)
    .single();

  if (error || !reply) throw new AppError(404, 'Email reply not found', error);
  const approvedBody = editedBody?.trim() || reply.ai_draft_reply;
  if (!approvedBody) throw new AppError(400, 'No AI draft reply is available to approve');

  const originalMessage = reply.email_messages as any;
  const subject = originalMessage?.subject?.toLowerCase().startsWith('re:')
    ? originalMessage.subject
    : `Re: ${originalMessage?.subject || 'Your message'}`;

  const { data: queued, error: queueError } = await supabase
    .from('email_messages')
    .insert({
      organization_id: organizationId,
      campaign_id: originalMessage?.campaign_id ?? null,
      lead_id: reply.lead_id,
      step_number: 1,
      subject,
      body: approvedBody,
      gmail_thread_id: originalMessage?.gmail_thread_id ?? null,
      status: 'queued',
    })
    .select('id')
    .single();

  if (queueError || !queued) throw new AppError(500, 'Failed to queue approved AI reply', queueError);

  await supabase
    .from('email_replies')
    .update({
      ai_draft_reply: approvedBody,
      ai_draft_status: 'approved',
    })
    .eq('id', replyId)
    .eq('organization_id', organizationId);

  await enqueueSendEmail({
    emailMessageId: queued.id,
    organizationId,
    campaignId: originalMessage?.campaign_id ?? undefined,
    leadId: reply.lead_id,
  }, {
    jobId: `send-email-${queued.id}`,
  });

  return {
    id: reply.id,
    ai_draft_reply: approvedBody,
    ai_draft_status: 'approved',
    queuedEmailMessageId: queued.id,
  };
}

export async function updateAiDraftReply(organizationId: string, replyId: string, body: string) {
  const draft = body.trim();
  if (!draft) throw new AppError(400, 'AI draft reply body is required');

  const { data, error } = await supabase
    .from('email_replies')
    .update({
      ai_draft_reply: draft,
      ai_draft_status: 'pending',
    })
    .eq('id', replyId)
    .eq('organization_id', organizationId)
    .select('id, ai_draft_reply, ai_draft_status')
    .single();

  if (error || !data) throw new AppError(404, 'Email reply not found', error);
  return data;
}

export async function regenerateAiDraftReply(organizationId: string, replyId: string) {
  const generated = await generateReply(organizationId, { emailReplyId: replyId });

  const { data, error } = await supabase
    .from('email_replies')
    .update({
      ai_draft_reply: generated.body,
      ai_draft_status: 'pending',
    })
    .eq('id', replyId)
    .eq('organization_id', organizationId)
    .select('id, ai_draft_reply, ai_draft_status')
    .single();

  if (error || !data) throw new AppError(404, 'Email reply not found', error);
  return data;
}

export async function rejectAiDraftReply(organizationId: string, replyId: string) {
  const { data, error } = await supabase
    .from('email_replies')
    .update({ ai_draft_status: 'rejected' })
    .eq('id', replyId)
    .eq('organization_id', organizationId)
    .select('id, ai_draft_reply, ai_draft_status')
    .single();

  if (error || !data) throw new AppError(404, 'Email reply not found', error);
  return data;
}

export async function sendEmail(emailMessageId: string, organizationId: string) {
  console.log(`[send-email] Starting message ${emailMessageId} for org ${organizationId}`);

  const capStatus = await checkSendCap(organizationId);
  if (capStatus.paused) {
    console.log(`[send-email] Daily cap reached (${capStatus.sentToday}/${capStatus.cap}), skipping ${emailMessageId}`);
    return { success: false, reason: 'daily_cap_reached', sentToday: capStatus.sentToday, cap: capStatus.cap };
  }

  const { data: msg, error: msgError } = await supabase
    .from('email_messages')
    .select('*, leads(id, email, first_name, last_name, name, title, company, status), campaigns(status)')
    .eq('id', emailMessageId)
    .eq('organization_id', organizationId)
    .single();

  if (msgError || !msg) throw new AppError(404, 'Email message not found');
  console.log(
    `[send-email] Loaded message ${emailMessageId}: campaign=${msg.campaign_id ?? 'none'}, lead=${msg.lead_id ?? 'none'}, step=${msg.step_number ?? 1}, status=${msg.status}`
  );

  const toEmail = msg.leads?.email;
  if (!toEmail) {
    console.warn(`[send-email] Message ${emailMessageId} cannot send because lead ${msg.lead_id ?? 'unknown'} has no email address`);
    throw new AppError(400, 'Lead has no email address');
  }

  const stepNumber = msg.step_number ?? 1;
  if (stepNumber > 1 && STOP_SEQUENCE_STATUSES.includes(msg.leads?.status)) {
    await markEmailSkipped(emailMessageId);
    return { success: false, reason: 'sequence_stopped', leadStatus: msg.leads?.status };
  }

  if (stepNumber > 1 && msg.campaigns?.status !== 'active') {
    await markEmailSkipped(emailMessageId);
    return { success: false, reason: 'campaign_not_active', campaignStatus: msg.campaigns?.status };
  }

  let subject = msg.subject;
  let body = msg.body;

  if (!subject || !body) {
    const campaignId = msg.campaign_id;
    const leadId = msg.lead_id;

    if (campaignId && leadId) {
      console.log(`[send-email] Generating email copy for message ${emailMessageId}, campaign ${campaignId}, lead ${leadId}, step ${stepNumber}`);
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
  console.log(`[send-email] Sending message ${emailMessageId} to ${toEmail} from ${gmail.email}`);

  try {
    const result = await sendGmailMessage(
      gmail.accessToken,
      gmail.refreshToken,
      gmail.email,
      toEmail,
      subject,
      body,
      { threadId: msg.gmail_thread_id },
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

    console.log(`[send-email] Sent message ${emailMessageId}. gmailMessageId=${result.messageId}, threadId=${result.threadId}`);
    posthog?.capture({
      distinctId: organizationId,
      event: 'email_sent',
      properties: { emailMessageId, campaignId: msg.campaign_id, leadId: msg.lead_id, stepNumber },
    });

    if (msg.sequence_step_id && msg.campaign_id && msg.lead_id) {
      await enqueueNextSequenceStep({
        organizationId,
        campaignId: msg.campaign_id,
        leadId: msg.lead_id,
        currentStepNumber: stepNumber,
      });
    }

    return { success: true, gmailMessageId: result.messageId };
  } catch (err: any) {
    console.error(`[send-email] Failed message ${emailMessageId}: ${err.message}`);
    await supabase
      .from('email_messages')
      .update({ status: 'failed' })
      .eq('id', emailMessageId);

    throw new AppError(502, `Gmail send failed: ${err.message}`);
  }
}

async function markEmailSkipped(emailMessageId: string) {
  await supabase
    .from('email_messages')
    .update({ status: 'skipped' })
    .eq('id', emailMessageId);
}

async function enqueueNextSequenceStep(input: {
  organizationId: string;
  campaignId: string;
  leadId: string;
  currentStepNumber: number;
}) {
  const { organizationId, campaignId, leadId, currentStepNumber } = input;

  const { data: nextStep, error: stepError } = await supabase
    .from('email_sequence_steps')
    .select('id,step_number,delay_days')
    .eq('campaign_id', campaignId)
    .gt('step_number', currentStepNumber)
    .order('step_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (stepError) throw new AppError(500, 'Failed to fetch next sequence step', stepError);
  if (!nextStep) {
    console.log(`[send-email] No next sequence step for campaign ${campaignId}, lead ${leadId}, current step ${currentStepNumber}`);
    return;
  }

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('status,email')
    .eq('organization_id', organizationId)
    .eq('id', leadId)
    .single();

  if (leadError || !lead) throw new AppError(404, 'Lead not found for next sequence step', leadError);
  if (!lead.email || STOP_SEQUENCE_STATUSES.includes(lead.status)) {
    console.log(`[send-email] Not queueing next step for lead ${leadId}: email=${lead.email ? 'present' : 'missing'}, status=${lead.status}`);
    return;
  }

  const { data: existing, error: existingError } = await supabase
    .from('email_messages')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('lead_id', leadId)
    .eq('step_number', nextStep.step_number)
    .maybeSingle();

  if (existingError) throw new AppError(500, 'Failed to check existing next sequence email', existingError);
  if (existing) {
    console.log(`[send-email] Existing next-step email found for campaign ${campaignId}, lead ${leadId}, step ${nextStep.step_number}. Skipping duplicate queue.`);
    return;
  }

  const { data: message, error: messageError } = await supabase
    .from('email_messages')
    .insert({
      organization_id: organizationId,
      campaign_id: campaignId,
      lead_id: leadId,
      sequence_step_id: nextStep.id,
      step_number: nextStep.step_number,
      subject: '',
      body: '',
      status: 'queued',
    })
    .select('id')
    .single();

  if (messageError || !message) throw new AppError(500, 'Failed to create next sequence email', messageError);

  const job = await enqueueSendEmail({
    emailMessageId: message.id,
    organizationId,
    campaignId,
    leadId,
    stepNumber: nextStep.step_number,
  }, {
    delay: Math.max(0, nextStep.delay_days) * 24 * 60 * 60 * 1000,
    jobId: `send-email-${message.id}`,
  });

  console.log(
    `[send-email] Queued next-step job ${job.id} for message ${message.id}, campaign ${campaignId}, lead ${leadId}, step ${nextStep.step_number}, delayDays=${nextStep.delay_days}`
  );
}
