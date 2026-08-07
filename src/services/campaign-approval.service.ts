/**
 * Draft approval and autopilot.
 *
 * Autopilot is an approval *policy*, not a generation flag. Flipping it on
 * approves the drafts already waiting as well as everything generated later -
 * without that, the tour moment where a customer approves one email and then
 * enables autopilot would leave the other twenty-nine sitting untouched, which
 * is worse than not offering the switch.
 *
 * What autopilot never does is skip validation. It means "I trust the writing,
 * stop asking me", not "send emails addressed to the wrong person" - and by
 * this point nothing invalid exists to approve anyway, since a draft that
 * failed validation was never saved.
 *
 * It lives on the campaign, copied from the org default at creation, so you
 * can always see what *this* campaign will do without going hunting in
 * Settings.
 */

import { supabase } from '../lib/supabase';
import { AppError } from '../types';

type JsonRecord = Record<string, unknown>;

function log(event: string, fields: JsonRecord) {
  console.log(JSON.stringify({ event, ...fields }));
}

/** The org-wide default a new campaign inherits. */
export async function resolveAutopilotDefault(organizationId: string): Promise<boolean> {
  const { data } = await supabase
    .from('agent_configs')
    .select('autopilot_default')
    .eq('organization_id', organizationId)
    .maybeSingle();

  return data?.autopilot_default === true;
}

export async function getCampaignApprovalState(organizationId: string, campaignId: string) {
  const [campaignResult, countsResult] = await Promise.all([
    supabase
      .from('campaigns')
      .select('id,autopilot_enabled,autopilot_enabled_at,status')
      .eq('organization_id', organizationId)
      .eq('id', campaignId)
      .maybeSingle(),
    supabase
      .from('email_messages')
      .select('status')
      .eq('organization_id', organizationId)
      .eq('campaign_id', campaignId),
  ]);

  if (campaignResult.error) throw new AppError(500, 'Failed to load campaign', campaignResult.error);
  if (!campaignResult.data) throw new AppError(404, 'Campaign not found');
  if (countsResult.error) throw new AppError(500, 'Failed to load campaign messages', countsResult.error);

  const counts = { draft: 0, approved: 0, sent: 0, other: 0 };
  for (const message of countsResult.data ?? []) {
    if (message.status === 'draft') counts.draft++;
    else if (message.status === 'approved' || message.status === 'queued') counts.approved++;
    else if (message.status === 'sent') counts.sent++;
    else counts.other++;
  }

  return {
    campaignId,
    autopilotEnabled: campaignResult.data.autopilot_enabled === true,
    autopilotEnabledAt: campaignResult.data.autopilot_enabled_at ?? null,
    status: campaignResult.data.status,
    counts,
    // What the launch gate checks. An active campaign with nothing approved
    // sends nothing while looking like it is running.
    canLaunch: counts.approved > 0 || counts.sent > 0,
  };
}

/**
 * The review screen's payload.
 *
 * Carries the lead's name, title, company and address alongside each email so
 * a reviewer can verify the recipient without leaving the screen - which is
 * what let the separate "skim your leads" step be dropped from the setup arc.
 * The thin-context flag makes a batch built on sparse data visible at a glance
 * rather than discovered after sending.
 */
export async function listCampaignMessages(input: {
  organizationId: string;
  campaignId: string;
  status?: 'draft' | 'approved' | 'sent';
  stepNumber?: number;
}) {
  let query = supabase
    .from('email_messages')
    .select(`
      id,step_number,subject,body,status,approved_at,approved_by,thin_context,
      context_score,generation_meta,edited_at,created_at,error_message,
      leads(id,first_name,last_name,name,title,company,email,context_score,context_score_max,context_ingredients)
    `)
    .eq('organization_id', input.organizationId)
    .eq('campaign_id', input.campaignId)
    .order('step_number', { ascending: true })
    .order('created_at', { ascending: true });

  if (input.status) query = query.eq('status', input.status);
  if (input.stepNumber) query = query.eq('step_number', input.stepNumber);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'Failed to load campaign messages', error);

  return (data ?? []).map(message => {
    const lead = message.leads as unknown as JsonRecord | null;
    return {
      id: message.id,
      stepNumber: message.step_number,
      subject: message.subject,
      body: message.body,
      status: message.status,
      approvedAt: message.approved_at,
      approvedBy: message.approved_by,
      editedAt: message.edited_at,
      thinContext: message.thin_context === true,
      contextScore: message.context_score,
      contextScoreMax: (lead?.context_score_max as number | null) ?? null,
      error: message.error_message ?? null,
      generationMeta: message.generation_meta ?? {},
      lead: lead
        ? {
          id: lead.id,
          name: lead.name ?? [lead.first_name, lead.last_name].filter(Boolean).join(' '),
          firstName: lead.first_name,
          title: lead.title,
          company: lead.company,
          email: lead.email,
          contextIngredients: lead.context_ingredients ?? {},
        }
        : null,
    };
  });
}

/**
 * Approves specific drafts.
 *
 * Only drafts move. A sent message is history and an already-approved one is
 * settled, so both are reported as skipped rather than silently rewritten.
 */
export async function approveMessages(input: {
  organizationId: string;
  campaignId: string;
  messageIds?: string[];
  approvedBy?: 'user' | 'autopilot';
}) {
  const { organizationId, campaignId } = input;

  let query = supabase
    .from('email_messages')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: input.approvedBy ?? 'user',
    })
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('status', 'draft');

  if (input.messageIds?.length) {
    query = query.in('id', input.messageIds);
  }

  const { data, error } = await query.select('id,lead_id,step_number');
  if (error) throw new AppError(500, 'Failed to approve drafts', error);

  const approved = data ?? [];
  log('campaign_drafts_approved', {
    organizationId,
    campaignId,
    approvedCount: approved.length,
    requested: input.messageIds?.length ?? 'all',
    approvedBy: input.approvedBy ?? 'user',
  });

  return {
    approved: approved.length,
    // A requested id that did not move was already sent or already approved.
    skipped: input.messageIds?.length ? input.messageIds.length - approved.length : 0,
    messageIds: approved.map(message => message.id as string),
  };
}

/**
 * Turns autopilot on or off for a campaign.
 *
 * Turning it on approves every pending draft; turning it off leaves already
 * approved messages alone, because un-approving something the customer already
 * cleared would be a surprising way to lose work.
 */
export async function setCampaignAutopilot(input: {
  organizationId: string;
  campaignId: string;
  enabled: boolean;
}) {
  const { organizationId, campaignId, enabled } = input;

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .update({
      autopilot_enabled: enabled,
      autopilot_enabled_at: enabled ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', organizationId)
    .eq('id', campaignId)
    .select('id,autopilot_enabled')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to update campaign autopilot', error);
  if (!campaign) throw new AppError(404, 'Campaign not found');

  // The retroactive half. Without this the switch only affects future drafts
  // and the ones already on screen stay stuck, which reads as a broken button.
  const approval = enabled
    ? await approveMessages({ organizationId, campaignId, approvedBy: 'autopilot' })
    : { approved: 0, skipped: 0, messageIds: [] };

  log('campaign_autopilot_changed', {
    organizationId,
    campaignId,
    enabled,
    retroactivelyApproved: approval.approved,
  });

  return {
    autopilotEnabled: enabled,
    retroactivelyApproved: approval.approved,
  };
}

/**
 * Reverts an edited message to draft.
 *
 * Editing an approved message withdraws its approval: the thing that was
 * approved is no longer the thing that would send. Under autopilot it is
 * re-approved immediately, which keeps the policy honest - the customer said
 * they trust this campaign's output, and an edit of their own is not a reason
 * to start asking again.
 */
export async function markMessageEdited(input: {
  organizationId: string;
  campaignId: string;
  messageId: string;
  subject?: string;
  body?: string;
}) {
  const { organizationId, campaignId, messageId } = input;

  const { data: message, error: loadError } = await supabase
    .from('email_messages')
    .select('id,status')
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .eq('id', messageId)
    .maybeSingle();

  if (loadError) throw new AppError(500, 'Failed to load message', loadError);
  if (!message) throw new AppError(404, 'Message not found');
  if (message.status === 'sent') throw new AppError(400, 'This email has already been sent and cannot be edited');

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('autopilot_enabled')
    .eq('organization_id', organizationId)
    .eq('id', campaignId)
    .maybeSingle();

  const autopilot = campaign?.autopilot_enabled === true;

  const patch: JsonRecord = {
    edited_at: new Date().toISOString(),
    status: autopilot ? 'approved' : 'draft',
    approved_at: autopilot ? new Date().toISOString() : null,
    approved_by: autopilot ? 'autopilot' : null,
  };
  if (typeof input.subject === 'string') patch.subject = input.subject.trim();
  if (typeof input.body === 'string') patch.body = input.body.trim();

  const { data: updated, error } = await supabase
    .from('email_messages')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', messageId)
    .select('id,subject,body,status,step_number,lead_id')
    .single();

  if (error) throw new AppError(500, 'Failed to save message edit', error);
  return updated;
}

/**
 * The launch precondition.
 *
 * Blocking is deliberate. Allowing launch with nothing approved lets someone
 * finish the setup arc, walk away satisfied, and discover days later that no
 * email ever went out - a failure that is invisible exactly when it matters.
 */
export async function assertCampaignLaunchable(organizationId: string, campaignId: string) {
  const state = await getCampaignApprovalState(organizationId, campaignId);

  if (!state.canLaunch) {
    throw new AppError(
      400,
      state.counts.draft > 0
        ? `This campaign has ${state.counts.draft} draft${state.counts.draft === 1 ? '' : 's'} and none approved yet. Approve at least one email, or turn on autopilot to approve them all.`
        : 'This campaign has no emails to send yet. Wait for drafts to finish generating.',
    );
  }

  return state;
}
