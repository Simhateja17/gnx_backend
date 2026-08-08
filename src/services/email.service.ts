import { supabase } from '../lib/supabase';
import { sendGmailMessage } from '../lib/gmail';
import { sendSmtpMessage } from '../lib/smtp';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { generateEmail, generateReply } from './ai.service';
import {
  getActiveEmailConnection,
  smtpConfigFromConnection,
} from './email-connection.service';
import { posthog } from '../lib/posthog';
import { AppError } from '../types';

const UNSUBSCRIBE_FOOTER = `\n\n---\nIf you'd like to stop receiving emails, reply "unsubscribe"\nGlobonexo | Company Address`;
const STOP_SEQUENCE_STATUSES = ['engaged', 'meeting_booked', 'not_interested', 'unsubscribed'];

// There's no org-level timezone column — only campaigns.timezone, which is
// per-campaign — so this uses the org's most recently created campaign's
// timezone as a stand-in for "the org's timezone", falling back to the same
// default campaigns.timezone itself defaults to when the org has none yet.
async function getOrgTimezone(organizationId: string): Promise<string> {
  const { data } = await supabase
    .from('campaigns')
    .select('timezone')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.timezone ?? 'America/New_York';
}

function getTimezoneOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);

  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

// Computes the UTC instant of local midnight in `timeZone`, for the day
// `reference` falls on. Recomputes the offset from `reference` itself
// (rather than assuming a fixed UTC offset) so this stays correct across
// DST transitions.
export function startOfDayUtcForTimezone(timeZone: string, reference = new Date()): Date {
  const offsetMinutes = getTimezoneOffsetMinutes(timeZone, reference);
  const shifted = new Date(reference.getTime() + offsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
}

async function getTodaySentCount(organizationId: string) {
  const timezone = await getOrgTimezone(organizationId);
  const startOfDay = startOfDayUtcForTimezone(timezone);

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

// email_messages has a unique index on (campaign_id, lead_id, step_number),
// meant to stop the same sequence step being sent twice. A reply isn't a
// sequence step at all, but it still has to satisfy that constraint - reusing
// step_number 1 collides with the lead's original campaign email every time,
// so this finds the next free number for that lead/campaign pair instead.
export async function getNextStepNumber(leadId: string, campaignId: string | null) {
  let query = supabase.from('email_messages').select('step_number').eq('lead_id', leadId);
  query = campaignId ? query.eq('campaign_id', campaignId) : query.is('campaign_id', null);
  const { data } = await query.order('step_number', { ascending: false }).limit(1);
  return (data?.[0]?.step_number ?? 0) + 1;
}

export async function approveAiDraftReply(organizationId: string, replyId: string, editedBody?: string) {
  const { data: reply, error } = await supabase
    .from('email_replies')
    .select('id, lead_id, provider_thread_id, ai_draft_reply, ai_draft_status, email_messages(subject, campaign_id, gmail_thread_id, provider_thread_id)')
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

  const nextStepNumber = await getNextStepNumber(reply.lead_id, originalMessage?.campaign_id ?? null);

  const { data: queued, error: queueError } = await supabase
    .from('email_messages')
    .insert({
      organization_id: organizationId,
      campaign_id: originalMessage?.campaign_id ?? null,
      lead_id: reply.lead_id,
      step_number: nextStepNumber,
      subject,
      body: approvedBody,
      provider_thread_id: reply.provider_thread_id ?? originalMessage?.provider_thread_id ?? originalMessage?.gmail_thread_id ?? null,
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

type EarlyFollowUpCandidate = {
  id: string;
  campaign_id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  company: string | null;
  campaigns?: { status?: string } | null;
};

type DraftedFollowUp = {
  id: string;
  leadId: string;
  leadName: string;
  company: string | null;
  subject: string;
  body: string;
};

async function draftFollowUpForLead(
  organizationId: string,
  lead: EarlyFollowUpCandidate,
): Promise<DraftedFollowUp | null> {
  const nextStepNumber = await getNextStepNumber(lead.id, lead.campaign_id);

  const { data: nextStep, error: stepError } = await supabase
    .from('email_sequence_steps')
    .select('id, step_number')
    .eq('campaign_id', lead.campaign_id)
    .eq('step_number', nextStepNumber)
    .maybeSingle();

  if (stepError) throw new AppError(500, 'Failed to fetch next sequence step', stepError);
  if (!nextStep) return null;

  const { data: existing, error: existingError } = await supabase
    .from('email_messages')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('campaign_id', lead.campaign_id)
    .eq('lead_id', lead.id)
    .eq('step_number', nextStep.step_number)
    .maybeSingle();

  if (existingError) throw new AppError(500, 'Failed to check existing follow-up draft', existingError);
  if (existing) return null;

  const generated = await generateEmail(organizationId, {
    campaignId: lead.campaign_id,
    leadId: lead.id,
    stepNumber: nextStep.step_number,
  });

  const { data: inserted, error: insertError } = await supabase
    .from('email_messages')
    .insert({
      organization_id: organizationId,
      campaign_id: lead.campaign_id,
      lead_id: lead.id,
      sequence_step_id: nextStep.id,
      step_number: nextStep.step_number,
      subject: generated.subject,
      body: generated.body,
      status: 'pending_review',
    })
    .select('id, subject, body')
    .single();

  if (insertError || !inserted) throw new AppError(500, 'Failed to save drafted follow-up', insertError);

  const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.name || 'Unknown';

  return {
    id: inserted.id,
    leadId: lead.id,
    leadName,
    company: lead.company,
    subject: inserted.subject,
    body: inserted.body,
  };
}

// Powers the AI agent's "draft follow-ups for no-replies" tool. Sequences
// already auto-send step 2/3 on their own delay_days schedule via
// enqueueNextSequenceStep() above - this generates that same next step early,
// on demand, but holds it as 'pending_review' instead of queuing it for send,
// so a human approves before it goes out.
export async function draftEarlyFollowUps(
  organizationId: string,
  options: { leadId?: string; limit?: number } = {},
) {
  const limit = Math.min(options.limit ?? 10, 10);

  let query = supabase
    .from('leads')
    .select('id, campaign_id, first_name, last_name, name, company, email, status, campaigns(status)')
    .eq('organization_id', organizationId)
    .eq('status', 'contacted')
    .not('email', 'is', null)
    .not('campaign_id', 'is', null);

  if (options.leadId) query = query.eq('id', options.leadId);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'Failed to fetch leads for follow-up drafting', error);

  const candidates = ((data ?? []) as unknown as EarlyFollowUpCandidate[])
    .filter(lead => lead.campaigns?.status === 'active');

  const totalOverdue = candidates.length;
  const batch = candidates.slice(0, limit);

  const results = await Promise.allSettled(batch.map(lead => draftFollowUpForLead(organizationId, lead)));

  const drafted = results
    .filter((r): r is PromiseFulfilledResult<DraftedFollowUp> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  return { drafted, draftedCount: drafted.length, totalOverdue };
}

export async function approvePendingDraft(organizationId: string, messageId: string) {
  const { data: message, error } = await supabase
    .from('email_messages')
    .select('id, campaign_id, lead_id, status')
    .eq('id', messageId)
    .eq('organization_id', organizationId)
    .single();

  if (error || !message) throw new AppError(404, 'Draft email not found');
  if (message.status !== 'pending_review') {
    throw new AppError(400, `Draft is not pending review (status: ${message.status})`);
  }

  await supabase
    .from('email_messages')
    .update({ status: 'queued' })
    .eq('id', messageId)
    .eq('organization_id', organizationId);

  await enqueueSendEmail({
    emailMessageId: messageId,
    organizationId,
    campaignId: message.campaign_id ?? undefined,
    leadId: message.lead_id,
  }, {
    jobId: `send-email-${messageId}`,
  });

  return { id: messageId, status: 'queued' };
}

export async function rejectPendingDraft(organizationId: string, messageId: string) {
  const { data, error } = await supabase
    .from('email_messages')
    .update({ status: 'skipped' })
    .eq('id', messageId)
    .eq('organization_id', organizationId)
    .eq('status', 'pending_review')
    .select('id, status')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to reject draft', error);
  if (!data) throw new AppError(404, 'Pending draft not found');
  return data;
}

export async function updatePendingDraft(
  organizationId: string,
  messageId: string,
  updates: { subject?: string; body?: string },
) {
  const patch: Record<string, unknown> = {};
  if (updates.subject !== undefined) patch.subject = updates.subject.trim();
  if (updates.body !== undefined) patch.body = updates.body.trim();
  if (Object.keys(patch).length === 0) throw new AppError(400, 'No fields to update');

  const { data, error } = await supabase
    .from('email_messages')
    .update(patch)
    .eq('id', messageId)
    .eq('organization_id', organizationId)
    .eq('status', 'pending_review')
    .select('id, subject, body, status')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to update draft', error);
  if (!data) throw new AppError(404, 'Pending draft not found');
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
    .select('*, leads(id, email, first_name, last_name, name, title, company, status, do_not_email, email_unsubscribed, dnc_status, qualification_status, outbound_paused_at, outbound_pause_reason, outbound_resume_at), campaigns(status)')
    .eq('id', emailMessageId)
    .eq('organization_id', organizationId)
    .single();

  if (msgError || !msg) throw new AppError(404, 'Email message not found');
  console.log(
    `[send-email] Loaded message ${emailMessageId}: campaign=${msg.campaign_id ?? 'none'}, lead=${msg.lead_id ?? 'none'}, step=${msg.step_number ?? 1}, status=${msg.status}`
  );

  // If this message already sent successfully, never send it again. Without
  // this, a job retried after the Gmail send already succeeded (e.g. a later
  // step in this same function throwing, or any transient BullMQ retry) would
  // silently send a real duplicate email with no guard against it.
  if (msg.status === 'sent') {
    const providerMessageId = msg.provider_message_id ?? msg.gmail_message_id;
    console.log(`[send-email] Message ${emailMessageId} already sent (providerMessageId=${providerMessageId}), skipping duplicate send`);
    return {
      success: true,
      alreadySent: true,
      providerMessageId,
      gmailMessageId: msg.gmail_message_id ?? providerMessageId,
    };
  }

  const toEmail = msg.leads?.email;
  if (!toEmail) {
    console.warn(`[send-email] Message ${emailMessageId} cannot send because lead ${msg.lead_id ?? 'unknown'} has no email address`);
    throw new AppError(400, 'Lead has no email address');
  }

  // Suppression, checked at the last possible moment. These flags were being
  // written by Apollo enrichment and read by nothing, so a contact Apollo had
  // already marked as unsubscribed could still be emailed. Enforced here
  // rather than only at selection time because a lead can be suppressed by a
  // reply that arrives after the message was queued.
  if (msg.leads?.do_not_email === true || msg.leads?.email_unsubscribed === true) {
    console.warn(`[send-email] Message ${emailMessageId} blocked: lead ${msg.lead_id} is suppressed`);
    await markEmailSkipped(emailMessageId);
    return { success: false, reason: 'lead_suppressed' };
  }

  // Approval. A draft has never been cleared by anyone - not by a human, and
  // not by autopilot on this campaign's behalf - so it must not send. This is
  // the gate that makes "no draft sends merely because it was generated" true
  // in the one place it can actually be enforced.
  if (msg.status === 'draft') {
    console.warn(`[send-email] Message ${emailMessageId} blocked: still an unapproved draft`);
    return { success: false, reason: 'not_approved' };
  }

  const stepNumber = msg.step_number ?? 1;
  // Only genuine automated sequence steps (step 2/3 follow-ups) carry a
  // sequence_step_id - these two guards exist to stop those follow-ups once
  // a lead has responded or the campaign's been paused. An approved reply
  // reuses a step_number > 1 just to satisfy the DB's uniqueness constraint,
  // but it's a direct human-approved send, not a stale automated follow-up,
  // so it must never be silently skipped by either check.
  if (msg.sequence_step_id && STOP_SEQUENCE_STATUSES.includes(msg.leads?.status)) {
    await markEmailSkipped(emailMessageId);
    return { success: false, reason: 'sequence_stopped', leadStatus: msg.leads?.status };
  }

  if (msg.sequence_step_id && msg.leads?.outbound_paused_at) {
    const resumeAt = msg.leads.outbound_resume_at ? new Date(msg.leads.outbound_resume_at).getTime() : null;
    if (!resumeAt || resumeAt > Date.now()) {
      const delayMs = resumeAt ? Math.max(1_000, resumeAt - Date.now()) : 5 * 60 * 1000;
      await enqueueSendEmail({
        emailMessageId,
        organizationId,
        leadId: msg.lead_id,
        campaignId: msg.campaign_id,
        stepNumber,
      }, { delay: delayMs });
      return { success: false, reason: 'outbound_paused_for_inbound', requeued: true, delayMs };
    }
    await supabase.from('leads').update({
      outbound_paused_at: null,
      outbound_pause_reason: null,
      outbound_resume_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', msg.lead_id).eq('organization_id', organizationId);
  }

  if (msg.sequence_step_id && msg.campaigns?.status !== 'active') {
    await markEmailSkipped(emailMessageId);
    return { success: false, reason: 'campaign_not_active', campaignStatus: msg.campaigns?.status };
  }

  const subject = msg.subject;
  const body = msg.body;

  // Copy is written ahead of time by the generation pipeline, where it is
  // validated (right recipient, no placeholders, no markup) before it is ever
  // saved. Generating here instead would put unvalidated text straight onto
  // the wire with nobody having read it, so an empty message is a failure to
  // report rather than a gap to fill.
  if (!subject || !body) {
    console.error(`[send-email] Message ${emailMessageId} has no generated copy; refusing to send`);
    await markEmailFailed(emailMessageId, 'Message has no generated copy');
    return { success: false, reason: 'not_generated' };
  }

  // The footer is appended at send time, never stored on the draft - the
  // reviewer reads the email the prospect will read, minus the boilerplate the
  // platform is responsible for.
  const outgoingBody = body + UNSUBSCRIBE_FOOTER;

  const connection = await getActiveEmailConnection(organizationId);
  if (!connection || !connection.email) {
    throw new AppError(400, 'No active email account is connected for this organization');
  }

  const providerLabel = connection.provider === 'smtp' ? 'custom SMTP' : 'Gmail';
  const parentThreadId = connection.provider === 'gmail'
    ? (msg.gmail_thread_id ?? msg.provider_thread_id)
    : msg.provider_thread_id;
  console.log(`[send-email] Sending message ${emailMessageId} via ${providerLabel} to ${toEmail} from ${connection.email}`);

  try {
    let providerMessageId: string | null = null;
    let providerThreadId: string | null = null;
    let gmailMessageId: string | null = null;
    let gmailThreadId: string | null = null;

    if (connection.provider === 'gmail') {
      if (!connection.accessToken || !connection.refreshToken) {
        throw new AppError(400, 'Gmail is not connected correctly. Reconnect Gmail in Settings.');
      }

      const result = await sendGmailMessage(
        connection.accessToken,
        connection.refreshToken,
        connection.email,
        toEmail,
        subject,
        outgoingBody,
        {
          threadId: parentThreadId,
          onTokenRefresh: (tokens) => {
            void supabase
              .from('connected_accounts')
              .update({
                access_token: tokens.access_token,
                expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
                updated_at: new Date().toISOString(),
              })
              .eq('id', connection.id)
              .then(({ error }) => {
                if (error) console.error(`[send-email] Failed to persist refreshed Gmail token for org ${organizationId}:`, error.message);
              });
          },
        },
      );

      providerMessageId = result.messageId;
      providerThreadId = result.threadId;
      gmailMessageId = result.messageId;
      gmailThreadId = result.threadId;
    } else {
      const smtpConnection = smtpConfigFromConnection(connection);
      const result = await sendSmtpMessage(smtpConnection.smtp, {
        from: connection.email,
        displayName: smtpConnection.displayName,
        to: toEmail,
        subject,
        text: outgoingBody,
        inReplyTo: parentThreadId,
      });

      providerMessageId = result.messageId;
      // SMTP/IMAP does not expose a provider thread identifier. We use the
      // first outbound Message-ID as the conversation anchor and carry it
      // through subsequent sequence messages.
      providerThreadId = parentThreadId ?? result.messageId;
    }

    if (!providerMessageId) throw new AppError(502, `${providerLabel} did not return a message ID`);

    await supabase
      .from('email_messages')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        ...(connection.provider === 'gmail'
          ? { gmail_message_id: gmailMessageId, gmail_thread_id: gmailThreadId }
          : {}),
      })
      .eq('id', emailMessageId);

    await supabase
      .from('leads')
      .update({ status: 'contacted', updated_at: new Date().toISOString() })
      .eq('id', msg.lead_id)
      .eq('status', 'queued');

    console.log(`[send-email] Sent message ${emailMessageId}. provider=${connection.provider}, providerMessageId=${providerMessageId}, threadId=${providerThreadId}`);
    posthog?.capture({
      distinctId: organizationId,
      event: 'email_sent',
      properties: { emailMessageId, campaignId: msg.campaign_id, leadId: msg.lead_id, stepNumber, provider: connection.provider },
    });

    if (msg.sequence_step_id && msg.campaign_id && msg.lead_id) {
      await enqueueNextSequenceStep({
        organizationId,
        campaignId: msg.campaign_id,
        leadId: msg.lead_id,
        currentStepNumber: stepNumber,
        providerThreadId,
        provider: connection.provider,
      });
    }

    return {
      success: true,
      provider: connection.provider,
      providerMessageId,
      gmailMessageId: gmailMessageId ?? providerMessageId,
    };
  } catch (err: any) {
    console.error(`[send-email] Failed message ${emailMessageId} via ${providerLabel}: ${err.message}`);
    await supabase
      .from('email_messages')
      .update({ status: 'failed' })
      .eq('id', emailMessageId);

    const providerError = err.response?.data?.error ?? err.message;
    if (connection.provider === 'gmail' && providerError === 'unauthorized_client') {
      throw new AppError(
        502,
        'Gmail send failed: this Gmail connection is not authorized. Reconnect Gmail in Settings, then try again.',
        err.response?.data,
      );
    }

    throw new AppError(502, `${providerLabel} send failed: ${err.message}`, err.response?.data);
  }
}

async function markEmailSkipped(emailMessageId: string) {
  await supabase
    .from('email_messages')
    .update({ status: 'skipped' })
    .eq('id', emailMessageId);
}

async function markEmailFailed(emailMessageId: string, reason: string) {
  await supabase
    .from('email_messages')
    .update({ status: 'failed', error_message: reason })
    .eq('id', emailMessageId);
}

async function enqueueNextSequenceStep(input: {
  organizationId: string;
  campaignId: string;
  leadId: string;
  currentStepNumber: number;
  providerThreadId: string | null;
  provider: 'gmail' | 'smtp';
}) {
  const { organizationId, campaignId, leadId, currentStepNumber, providerThreadId, provider } = input;

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
      provider_thread_id: providerThreadId,
      ...(provider === 'gmail' ? { gmail_thread_id: providerThreadId } : {}),
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
