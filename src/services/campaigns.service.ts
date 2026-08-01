import { supabase } from '../lib/supabase';
import { enqueueSendEmail } from '../jobs/send-email.job';
import { enqueueScheduleCall } from '../jobs/schedule-call.job';
import { posthog } from '../lib/posthog';
import { AppError } from '../types';
import { ensureAgentConfig } from './agent-config.service';
import { parsePromptContext, serializePromptContext } from '../lib/prompt-context';
import type { AssignLeadsInput, CampaignCreateInput, CampaignUpdateInput, SequenceStepsUpsertInput } from '../schemas/campaigns.schema';
import { normalizePhoneForCalling } from '../lib/phone';

type CampaignChannel = 'email' | 'voice' | 'both';

// 'both' runs the email sequence and the calling cadence off the same campaign,
// so every channel branch has to ask "does this campaign use email/voice?"
// rather than comparing the column to a single value.
function usesEmail(channel: string) {
  return channel === 'email' || channel === 'both';
}

function usesVoice(channel: string) {
  return channel === 'voice' || channel === 'both';
}

type CampaignRow = {
  id: string;
  organization_id: string;
  name: string;
  channel: CampaignChannel;
  status: 'draft' | 'active' | 'paused' | 'completed';
  agent_config_id: string | null;
  prompt_context: string | null;
  max_leads: number;
  daily_send_cap: number;
  call_cadence_per_hour: number;
  voice_mode: 'ai' | 'manual';
  business_hours_start: string;
  business_hours_end: string;
  timezone: string;
  created_at: string;
  updated_at: string;
};

type CampaignStats = {
  enrolled: number;
  ready: number;
  missingEmail: number;
  stopped: number;
  queued: number;
  sent: number;
  meetings: number;
};

const STOP_SEQUENCE_STATUSES = ['engaged', 'meeting_booked', 'not_interested', 'unsubscribed'];

// Calling is narrower than emailing: an 'engaged' lead is still worth a call,
// so voice only stops on the terminal statuses.
const STOP_CALLING_STATUSES = ['meeting_booked', 'not_interested', 'unsubscribed'];

const CAMPAIGN_COLUMNS = [
  'id',
  'organization_id',
  'name',
  'channel',
  'status',
  'agent_config_id',
  'prompt_context',
  'max_leads',
  'daily_send_cap',
  'call_cadence_per_hour',
  'voice_mode',
  'business_hours_start',
  'business_hours_end',
  'timezone',
  'created_at',
  'updated_at',
].join(',');

function toApiCampaign(row: CampaignRow, stats?: CampaignStats) {
  const prompt = parsePromptContext(row.prompt_context);

  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    status: row.status,
    icpSource: prompt.icpSource,
    promptNotes: prompt.promptNotes,
    maxLeads: row.max_leads,
    dailySendCap: row.daily_send_cap,
    callCadencePerHour: row.call_cadence_per_hour,
    voiceMode: row.voice_mode,
    businessHoursStart: row.business_hours_start?.slice(0, 5),
    businessHoursEnd: row.business_hours_end?.slice(0, 5),
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: stats ?? { enrolled: 0, ready: 0, missingEmail: 0, stopped: 0, queued: 0, sent: 0, meetings: 0 },
  };
}

async function getDefaultAgentConfigId(orgId: string) {
  const config = await ensureAgentConfig(orgId);
  return config.id;
}

async function getStatsByCampaign(orgId: string, campaignIds: string[]) {
  const stats = new Map<string, CampaignStats>();
  campaignIds.forEach(id => stats.set(id, { enrolled: 0, ready: 0, missingEmail: 0, stopped: 0, queued: 0, sent: 0, meetings: 0 }));

  if (campaignIds.length === 0) return stats;

  const [leadsResult, emailResult, callsResult] = await Promise.all([
    supabase
      .from('leads')
      .select('campaign_id,status,email')
      .eq('organization_id', orgId)
      .in('campaign_id', campaignIds),
    supabase
      .from('email_messages')
      .select('campaign_id,status')
      .eq('organization_id', orgId)
      .in('campaign_id', campaignIds),
    supabase
      .from('calls')
      .select('campaign_id,disposition')
      .eq('organization_id', orgId)
      .in('campaign_id', campaignIds),
  ]);

  if (leadsResult.error) throw new AppError(500, 'Failed to read campaign leads', leadsResult.error);
  if (emailResult.error) throw new AppError(500, 'Failed to read campaign messages', emailResult.error);
  if (callsResult.error) throw new AppError(500, 'Failed to read campaign calls', callsResult.error);

  for (const lead of leadsResult.data ?? []) {
    if (!lead.campaign_id) continue;
    const entry = stats.get(lead.campaign_id);
    if (!entry) continue;
    entry.enrolled += 1;
    if (!lead.email) entry.missingEmail += 1;
    else if (STOP_SEQUENCE_STATUSES.includes(lead.status)) entry.stopped += 1;
    else entry.ready += 1;
    if (lead.status === 'meeting_booked') entry.meetings += 1;
  }

  for (const message of emailResult.data ?? []) {
    if (!message.campaign_id) continue;
    const entry = stats.get(message.campaign_id);
    if (!entry) continue;
    if (message.status === 'queued') entry.queued += 1;
    if (message.status === 'sent') entry.sent += 1;
  }

  for (const call of callsResult.data ?? []) {
    if (!call.campaign_id || call.disposition !== 'meeting_booked') continue;
    const entry = stats.get(call.campaign_id);
    if (entry) entry.meetings += 1;
  }

  return stats;
}

export async function listCampaigns(orgId: string) {
  const { data, error } = await supabase
    .from('campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw new AppError(500, 'Failed to fetch campaigns', error);

  const rows = (data ?? []) as unknown as CampaignRow[];
  const stats = await getStatsByCampaign(orgId, rows.map(row => row.id));
  const items = rows.map(row => toApiCampaign(row, stats.get(row.id)));
  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc.active += item.status === 'active' ? 1 : 0;
      acc.enrolled += item.stats.enrolled;
      acc.sent += item.stats.sent;
      acc.meetings += item.stats.meetings;
      return acc;
    },
    { total: 0, active: 0, enrolled: 0, sent: 0, meetings: 0 }
  );

  return { items, summary };
}

export async function createCampaign(orgId: string, input: CampaignCreateInput) {
  const agentConfigId = await getDefaultAgentConfigId(orgId);
  const record = {
    organization_id: orgId,
    name: input.name,
    channel: input.channel,
    status: 'draft',
    agent_config_id: agentConfigId,
    prompt_context: serializePromptContext(input),
    max_leads: input.maxLeads,
    daily_send_cap: input.dailySendCap,
    call_cadence_per_hour: input.callCadencePerHour,
    voice_mode: input.voiceMode,
    business_hours_start: input.businessHoursStart,
    business_hours_end: input.businessHoursEnd,
    timezone: input.timezone,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('campaigns')
    .insert(record)
    .select(CAMPAIGN_COLUMNS)
    .single();

  if (error) throw new AppError(500, 'Failed to create campaign', error);
  return toApiCampaign(data as unknown as CampaignRow);
}

export async function getCampaign(orgId: string, id: string) {
  const { data, error } = await supabase
    .from('campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('organization_id', orgId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch campaign', error);
  if (!data) throw new AppError(404, 'Campaign not found');

  const stats = await getStatsByCampaign(orgId, [id]);
  return toApiCampaign(data as unknown as CampaignRow, stats.get(id));
}

export async function updateCampaign(orgId: string, id: string, input: CampaignUpdateInput) {
  const current = await getCampaign(orgId, id);
  const record: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (input.name !== undefined) record.name = input.name;
  if (input.channel !== undefined) record.channel = input.channel;
  if (input.maxLeads !== undefined) record.max_leads = input.maxLeads;
  if (input.dailySendCap !== undefined) record.daily_send_cap = input.dailySendCap;
  if (input.callCadencePerHour !== undefined) record.call_cadence_per_hour = input.callCadencePerHour;
  if (input.voiceMode !== undefined) record.voice_mode = input.voiceMode;
  if (input.businessHoursStart !== undefined) record.business_hours_start = input.businessHoursStart;
  if (input.businessHoursEnd !== undefined) record.business_hours_end = input.businessHoursEnd;
  if (input.timezone !== undefined) record.timezone = input.timezone;

  if (input.icpSource !== undefined || input.promptNotes !== undefined) {
    record.prompt_context = serializePromptContext({
      icpSource: input.icpSource ?? current.icpSource,
      promptNotes: input.promptNotes ?? current.promptNotes,
    });
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update(record)
    .eq('organization_id', orgId)
    .eq('id', id)
    .select(CAMPAIGN_COLUMNS)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to update campaign', error);
  if (!data) throw new AppError(404, 'Campaign not found');
  return toApiCampaign(data as unknown as CampaignRow, current.stats);
}

export async function setCampaignStatus(
  orgId: string,
  id: string,
  status: 'active' | 'paused' | 'completed'
) {
  console.log(`[campaigns] Setting campaign ${id} to ${status} for org ${orgId}`);

  const { data: currentData, error: currentError } = await supabase
    .from('campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('organization_id', orgId)
    .eq('id', id)
    .maybeSingle();

  if (currentError) throw new AppError(500, 'Failed to fetch campaign before status change', currentError);
  if (!currentData) throw new AppError(404, 'Campaign not found');

  const current = currentData as unknown as CampaignRow;
  const emailEnabled = usesEmail(current.channel);
  const voiceEnabled = usesVoice(current.channel);

  if (status === 'active' && emailEnabled) {
    const readiness = await getEmailLaunchReadiness(orgId, id);
    // An email-only campaign with nothing send-ready is a hard error. On a
    // 'both' campaign the calls can still carry the launch, so only block when
    // neither channel has anything to work with.
    if (readiness.ready === 0) {
      const callable = voiceEnabled ? await countCallableLeads(orgId, id, current.timezone) : 0;
      if (callable === 0) {
        throw new AppError(
          400,
          voiceEnabled
            ? 'Campaign has no send-ready or callable leads. Add lead emails or phone numbers before launching.'
            : 'Campaign has no send-ready leads. Reveal or upload lead emails before launching.',
          readiness
        );
      }
    }
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('id', id)
    .select(CAMPAIGN_COLUMNS)
    .maybeSingle();

  if (error) throw new AppError(500, `Failed to set campaign ${status}`, error);
  if (!data) throw new AppError(404, 'Campaign not found');
  const stats = await getStatsByCampaign(orgId, [id]);
  const campaign = toApiCampaign(data as unknown as CampaignRow, stats.get(id));

  if (status === 'active') {
    posthog?.capture({
      distinctId: orgId,
      event: 'campaign_launched',
      properties: { campaignId: id, channel: campaign.channel },
    });
  }

  if (status === 'active' && (emailEnabled || voiceEnabled)) {
    try {
      let emailQueued = 0;
      let voiceQueued = 0;
      let voiceSkipped = 0;

      if (emailEnabled) {
        emailQueued = await enqueueInitialEmailStep(orgId, id);
        console.log(`[campaigns] Campaign ${id} launched. Queued ${emailQueued} initial email job(s).`);
      }

      if (voiceEnabled) {
        const result = await enqueueVoiceCalls(orgId, id, campaign);
        voiceQueued = result.queued;
        voiceSkipped = result.skipped;
        console.log(`[campaigns] Campaign ${id} launched. Queued ${voiceQueued} call(s), skipped ${voiceSkipped}.`);
      }

      return {
        ...campaign,
        queued: emailQueued + voiceQueued,
        skipped: voiceSkipped,
        emailQueued,
        voiceQueued,
      };
    } catch (err) {
      // Roll the campaign back to paused so a partial fan-out (e.g. emails
      // queued, calls rejected for a missing Retell number) doesn't leave it
      // sitting active and half-launched.
      await supabase
        .from('campaigns')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('id', id);
      throw err;
    }
  }

  console.log(`[campaigns] Campaign ${id} status set to ${status}. No email jobs queued for channel ${campaign.channel}.`);
  return campaign;
}

async function enqueueVoiceCalls(
  orgId: string,
  campaignId: string,
  campaign: ReturnType<typeof toApiCampaign>,
) {
  const { data: agentConfig } = await supabase
    .from('agent_configs')
    .select('retell_phone_number')
    .eq('organization_id', orgId)
    .single();

  if (!agentConfig?.retell_phone_number) {
    throw new AppError(400, 'Add your Retell phone number in Settings before launching a voice campaign');
  }

  const fromNumber = agentConfig.retell_phone_number;

  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, phone, status')
    .eq('organization_id', orgId)
    .eq('campaign_id', campaignId)
    .not('phone', 'is', null);

  if (leadsError) throw new AppError(500, 'Failed to fetch campaign leads', leadsError);

  const eligibleLeads = (leads ?? []).flatMap(lead => {
    if (!lead.phone || STOP_CALLING_STATUSES.includes(lead.status)) return [];
    const toNumber = normalizePhoneForCalling(lead.phone, campaign.timezone);
    return toNumber ? [{ ...lead, toNumber }] : [];
  });

  const skipped = (leads?.length ?? 0) - eligibleLeads.length;
  const msPerCall = Math.floor(3_600_000 / (campaign.callCadencePerHour || 5));
  let queued = 0;

  for (let i = 0; i < eligibleLeads.length; i++) {
    const lead = eligibleLeads[i];
    await enqueueScheduleCall(
      { leadId: lead.id, campaignId, organizationId: orgId, fromNumber, toNumber: lead.toNumber },
      i * msPerCall,
    );
    queued++;
  }

  return { queued, skipped };
}

async function getEmailLaunchReadiness(orgId: string, campaignId: string) {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id,email,status')
    .eq('organization_id', orgId)
    .eq('campaign_id', campaignId);

  if (error) throw new AppError(500, 'Failed to inspect campaign lead readiness', error);

  const rows = leads ?? [];
  const missingEmail = rows.filter(lead => !lead.email).length;
  const stopped = rows.filter(lead => lead.email && STOP_SEQUENCE_STATUSES.includes(lead.status)).length;
  const ready = rows.filter(lead => lead.email && !STOP_SEQUENCE_STATUSES.includes(lead.status)).length;

  return {
    enrolled: rows.length,
    ready,
    missingEmail,
    stopped,
  };
}

// Mirrors the eligibility filter in enqueueVoiceCalls, so a 'both' campaign
// can tell whether the calling side has anything to launch with.
async function countCallableLeads(orgId: string, campaignId: string, timezone: string) {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id,phone,status')
    .eq('organization_id', orgId)
    .eq('campaign_id', campaignId)
    .not('phone', 'is', null);

  if (error) throw new AppError(500, 'Failed to inspect campaign call readiness', error);

  return (leads ?? []).filter(
    lead => lead.phone &&
      !STOP_CALLING_STATUSES.includes(lead.status) &&
      Boolean(normalizePhoneForCalling(lead.phone, timezone))
  ).length;
}

async function enqueueInitialEmailStep(orgId: string, campaignId: string) {
  console.log(`[campaigns] Preparing initial email queue for campaign ${campaignId}`);

  const { data: firstStep, error: stepError } = await supabase
    .from('email_sequence_steps')
    .select('id,step_number')
    .eq('campaign_id', campaignId)
    .eq('step_number', 1)
    .maybeSingle();

  if (stepError) throw new AppError(500, 'Failed to fetch first sequence step', stepError);
  if (!firstStep) {
    console.warn(`[campaigns] Campaign ${campaignId} has no step 1 email sequence. Jobs will still be created without a sequence_step_id.`);
  }

  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id,email,status')
    .eq('organization_id', orgId)
    .eq('campaign_id', campaignId);

  if (leadsError) throw new AppError(500, 'Failed to fetch campaign leads', leadsError);

  const enrolledLeads = leads ?? [];
  const eligibleLeads = (leads ?? []).filter(lead =>
    lead.email &&
    !STOP_SEQUENCE_STATUSES.includes(lead.status)
  );
  const missingEmailCount = enrolledLeads.filter(lead => !lead.email).length;
  const stoppedCount = enrolledLeads.filter(lead =>
    lead.email && STOP_SEQUENCE_STATUSES.includes(lead.status)
  ).length;

  console.log(
    `[campaigns] Campaign ${campaignId} enrolled=${enrolledLeads.length}, eligible=${eligibleLeads.length}, missing_email=${missingEmailCount}, stopped_status=${stoppedCount}`
  );

  let queued = 0;

  for (const lead of eligibleLeads) {
    const { data: existing, error: existingError } = await supabase
      .from('email_messages')
      .select('id,status')
      .eq('organization_id', orgId)
      .eq('campaign_id', campaignId)
      .eq('lead_id', lead.id)
      .eq('step_number', 1)
      .maybeSingle();

    if (existingError) throw new AppError(500, 'Failed to check existing campaign email', existingError);
    if (existing) {
      if (existing.status === 'queued') {
        const job = await enqueueSendEmail({
          emailMessageId: existing.id,
          organizationId: orgId,
          campaignId,
          leadId: lead.id,
          stepNumber: 1,
        }, {
          jobId: `send-email-${existing.id}`,
        });
        queued++;
        console.log(`[campaigns] Re-queued existing send-email job ${job.id} for message ${existing.id}, lead ${lead.id}, campaign ${campaignId}`);
      } else {
        console.log(`[campaigns] Existing step 1 email found for campaign ${campaignId}, lead ${lead.id}, status ${existing.status}. Skipping duplicate queue.`);
      }
      continue;
    }

    const { data: message, error: messageError } = await supabase
      .from('email_messages')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_id: lead.id,
        sequence_step_id: firstStep?.id ?? null,
        step_number: 1,
        subject: '',
        body: '',
        status: 'queued',
      })
      .select('id')
      .single();

    if (messageError || !message) throw new AppError(500, 'Failed to create initial email message', messageError);

    const job = await enqueueSendEmail({
      emailMessageId: message.id,
      organizationId: orgId,
      campaignId,
      leadId: lead.id,
      stepNumber: 1,
    }, {
      jobId: `send-email-${message.id}`,
    });

    queued++;
    await supabase
      .from('leads')
      .update({ status: 'queued', updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', lead.id)
      .eq('status', 'new');

    console.log(`[campaigns] Queued send-email job ${job.id} for message ${message.id}, lead ${lead.id}, campaign ${campaignId}`);
  }

  console.log(`[campaigns] Initial queue complete for campaign ${campaignId}: ${queued} job(s) queued.`);
  return queued;
}

export async function deleteCampaign(orgId: string, id: string) {
  const { data, error } = await supabase
    .from('campaigns')
    .delete()
    .eq('organization_id', orgId)
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to delete campaign', error);
  if (!data) throw new AppError(404, 'Campaign not found');
  return { success: true };
}

export async function getSequenceSteps(orgId: string, campaignId: string) {
  await getCampaign(orgId, campaignId);

  const { data, error } = await supabase
    .from('email_sequence_steps')
    .select('id,campaign_id,step_number,delay_days,subject_template,body_prompt_context')
    .eq('campaign_id', campaignId)
    .order('step_number', { ascending: true });

  if (error) throw new AppError(500, 'Failed to fetch sequence steps', error);

  return {
    items: (data ?? []).map(row => ({
      id: row.id,
      stepNumber: row.step_number,
      delayDays: row.delay_days,
      subjectTemplate: row.subject_template,
      bodyPromptContext: row.body_prompt_context,
    })),
  };
}

export async function upsertSequenceSteps(orgId: string, campaignId: string, input: SequenceStepsUpsertInput) {
  await getCampaign(orgId, campaignId);

  const { error: deleteError } = await supabase
    .from('email_sequence_steps')
    .delete()
    .eq('campaign_id', campaignId);

  if (deleteError) throw new AppError(500, 'Failed to clear existing steps', deleteError);

  const records = input.steps.map(step => ({
    campaign_id: campaignId,
    step_number: step.stepNumber,
    delay_days: step.delayDays,
    subject_template: step.subjectTemplate,
    body_prompt_context: step.bodyPromptContext,
  }));

  const { data, error } = await supabase
    .from('email_sequence_steps')
    .insert(records)
    .select('id,campaign_id,step_number,delay_days,subject_template,body_prompt_context');

  if (error) throw new AppError(500, 'Failed to save sequence steps', error);

  return {
    items: (data ?? []).map(row => ({
      id: row.id,
      stepNumber: row.step_number,
      delayDays: row.delay_days,
      subjectTemplate: row.subject_template,
      bodyPromptContext: row.body_prompt_context,
    })),
  };
}

export async function assignLeadsToCampaign(orgId: string, campaignId: string, input: AssignLeadsInput) {
  const campaign = await getCampaign(orgId, campaignId);

  const { data, error } = await supabase
    .from('leads')
    .update({ campaign_id: campaignId, updated_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .in('id', input.leadIds)
    .select('id');

  if (error) throw new AppError(500, 'Failed to assign leads', error);

  await enqueueInitialEmailStepIfActive(orgId, campaignId, campaign);

  return { assigned: data?.length ?? 0 };
}

// Leads can be attached to a campaign well after it was launched (assigning
// existing leads, CSV import, Apollo search-and-save all take an optional
// campaignId). The "queue the first email" step normally only runs once, at
// the moment a campaign is launched, so without this, leads added afterward
// would silently never receive anything. enqueueInitialEmailStep already
// skips leads that already have a step-1 email, so it's safe to call again
// here - only the newly-added, still-eligible leads actually get queued.
export async function enqueueInitialEmailStepIfActive(
  orgId: string,
  campaignId: string,
  campaign?: { status: string; channel: string },
) {
  const current = campaign ?? await getCampaign(orgId, campaignId);
  if (current.status !== 'active' || !usesEmail(current.channel)) return;
  await enqueueInitialEmailStep(orgId, campaignId);
}
