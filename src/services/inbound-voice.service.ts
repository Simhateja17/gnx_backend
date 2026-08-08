import { retell } from '../lib/retell';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { env } from '../config/env';
import { normalizePhoneForCalling } from '../lib/phone';
import { contextSnapshotToDynamicVariables, createOrReuseLeadContextSnapshot } from './lead-context.service';
import { buildInboundAgentTools } from './retell-agent-tools';
import { configureActiveRetellInboundPhoneNumbers } from './retell-phone.service';
import { verifyRetellRequest } from './retell-auth.service';

const INBOUND_MAX_SECONDS = 20 * 60;
const LOOKUP_DEADLINE_MS = 3_000;
const UNKNOWN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const UNKNOWN_ATTEMPT_LIMIT = 5;

export const INBOUND_PLAN_LIMITS = {
  starter: 0,
  growth: 20,
  scale: 60,
} as const;

type PlanId = keyof typeof INBOUND_PLAN_LIMITS;
type InboundCallContext = {
  id: string;
  organization_id: string;
  lead_id: string | null;
  campaign_id: string | null;
  from_number: string | null;
};

type MatchedLead = Record<string, any> & { id: string; campaign_id: string | null };

export function inboundPlanLimit(planId: string | null | undefined) {
  return INBOUND_PLAN_LIMITS[(planId ?? 'starter') as PlanId] ?? 0;
}

export function phoneLast10(value: string | null | undefined) {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function effectiveInboundLimit(planLimit: number, requested: number | null | undefined) {
  if (planLimit <= 0) return 0;
  if (requested == null) return planLimit;
  return Math.max(1, Math.min(planLimit, Math.floor(requested)));
}

export function leadHasDnc(lead: Record<string, any> | null | undefined) {
  const status = String(lead?.dnc_status ?? '').trim().toLowerCase();
  return lead?.do_not_call === true || ['dnc', 'do_not_call', 'do-not-call', 'do_not_contact'].includes(status);
}

export function selectBestPhoneMatch(rows: MatchedLead[] | null | undefined) {
  if (!rows?.length) return null;
  const bestRank = Math.min(...rows.map(row => Number(row.match_rank ?? 99)));
  const best = rows.filter(row => Number(row.match_rank ?? 99) === bestRank);
  return best.length === 1 ? best[0] : null;
}

function parseJson(rawBody: Buffer) {
  try {
    return JSON.parse(rawBody.toString('utf8')) as Record<string, any>;
  } catch {
    throw new AppError(400, 'Invalid Retell JSON payload');
  }
}

function inboundPrompt(config: Record<string, any>, organizationName: string) {
  const product = config.product_description || 'Unavailable';
  const value = config.value_proposition || 'Unavailable';
  return `You are ${config.agent_name || 'Nexo'}, the AI receptionist for ${organizationName}.

NON-NEGOTIABLE RULES:
1. Your very first sentence must say you are an AI assistant for ${organizationName}.
2. This call is not recorded and no transcript is retained. Never ask for recording consent and never claim that recording is occurring.
3. Never guess a caller's identity, company, history, needs, or any missing fact.
4. If caller_identity_status is phone_match, greet {{lead_name}} and naturally confirm you are speaking with them. If they say the match is wrong, call identify_caller.
5. If caller_identity_status is unknown, ask for the caller's full name and company, then call identify_caller once. If lookup fails or is ambiguous, continue as a general receptionist.
6. Treat do_not_call as an outbound-only restriction. Help an inbound caller normally, but never describe their inbound call as consent to future outbound solicitation.
7. Keep responses concise. End promptly when the caller is done.

VERIFIED ORGANIZATION FACTS:
- Organization: ${organizationName}
- Product: ${product}
- Value proposition: ${value}
${config.pain_points ? `- Problems the product addresses: ${config.pain_points}` : '- Problems the product addresses: Unavailable'}

KNOWN CALLER CONTEXT (use only if supplied):
- Name: {{lead_name}}
- Title: {{lead_title}}
- Company: {{lead_company}}
- Verified facts: {{lead_factual_summary}}
- Facts you must not claim: {{lead_do_not_claim}}

FALLBACK FLOW:
- If the caller remains unidentified, answer only from VERIFIED ORGANIZATION FACTS.
- You may take a message, arrange follow-up, or offer a meeting.
- Only when an unidentified caller explicitly requests follow-up or agrees to a meeting, confirm name, company, and email and call create_inbound_lead before booking.
- Never run Apollo or any enrichment during the live call.

MEETINGS:
- Once the caller agrees, call check_availability and offer its returned slots.
- Call book_meeting only after a specific slot is confirmed.
- Use reschedule_meeting or cancel_meeting for an existing meeting.`;
}

const INBOUND_ANALYSIS = [
  {
    type: 'enum' as const,
    name: 'disposition',
    description: 'Structured inbound call outcome',
    choices: ['interested', 'not_interested', 'meeting_booked', 'callback', 'message_taken', 'no_connect', 'wrong_person', 'technical_failure'],
  },
  {
    type: 'boolean' as const,
    name: 'identity_confirmed',
    description: 'True only if the caller explicitly confirmed their identity.',
  },
  {
    type: 'boolean' as const,
    name: 'substantive_conversation',
    description: 'True only when an identity-confirmed caller had a meaningful business conversation, requested follow-up, or booked a meeting.',
  },
  {
    type: 'boolean' as const,
    name: 'requested_no_future_contact',
    description: 'True only if the caller explicitly asked not to be contacted again.',
  },
];

async function loadPlan(organizationId: string) {
  const [{ data: subscription }, { data: organization }, { data: campaign }] = await Promise.all([
    supabase.from('subscriptions').select('plan_id,status').eq('organization_id', organizationId).maybeSingle(),
    supabase.from('organizations').select('name,plan_id,subscription_status').eq('id', organizationId).single(),
    supabase.from('campaigns').select('timezone').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!organization) throw new AppError(404, 'Organization not found');
  const planId = subscription?.plan_id ?? organization.plan_id ?? 'starter';
  const billingActive = ['active', 'past_due'].includes(organization.subscription_status)
    && (!subscription || ['active', 'authenticated'].includes(subscription.status));
  return { planId, planLimit: inboundPlanLimit(planId), organizationName: organization.name, timezone: campaign?.timezone ?? 'America/New_York', billingActive };
}

export async function getInboundVoiceStatus(organizationId: string) {
  const [{ data: config, error }, plan, { data: phone }] = await Promise.all([
    supabase
      .from('agent_configs')
      .select('inbound_enabled,inbound_retell_agent_id,inbound_daily_minute_limit,inbound_max_call_duration_seconds')
      .eq('organization_id', organizationId)
      .single(),
    loadPlan(organizationId),
    supabase
      .from('retell_phone_numbers')
      .select('phone_number,status')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle(),
  ]);
  if (error || !config) throw new AppError(404, 'Agent config not found');
  return {
    enabled: Boolean(config.inbound_enabled),
    available: plan.billingActive && plan.planLimit > 0,
    planId: plan.planId,
    planDailyMinuteLimit: plan.planLimit,
    dailyMinuteLimit: effectiveInboundLimit(plan.planLimit, config.inbound_daily_minute_limit),
    maxCallDurationSeconds: config.inbound_max_call_duration_seconds ?? INBOUND_MAX_SECONDS,
    phoneNumber: phone?.phone_number ?? null,
    phoneReady: phone?.status === 'active',
    agentReady: Boolean(config.inbound_retell_agent_id),
  };
}

async function createOrUpdateInboundAgent(organizationId: string) {
  const [{ data: config, error }, plan] = await Promise.all([
    supabase.from('agent_configs').select('*').eq('organization_id', organizationId).single(),
    loadPlan(organizationId),
  ]);
  if (error || !config) throw new AppError(404, 'Agent config not found');

  const prompt = inboundPrompt(config, plan.organizationName);
  const tools = buildInboundAgentTools();
  let llmId = config.inbound_retell_llm_id as string | null;
  let agentId = config.inbound_retell_agent_id as string | null;

  if (!llmId) {
    const llm = await retell.llm.create({ general_prompt: prompt, general_tools: tools as any });
    llmId = llm.llm_id;
  } else {
    await retell.llm.update(llmId, { general_prompt: prompt, general_tools: tools as any });
  }

  const agentInput = {
    agent_name: `${config.agent_name || 'Nexo'} - Inbound`,
    response_engine: { type: 'retell-llm' as const, llm_id: llmId },
    voice_id: 'openai-Alloy',
    data_storage_setting: 'basic_attributes_only' as const,
    max_call_duration_ms: INBOUND_MAX_SECONDS * 1000,
    webhook_url: `${env.BACKEND_PUBLIC_URL}/webhooks/retell`,
    webhook_events: ['call_started', 'call_ended', 'call_analyzed'] as any,
    post_call_analysis_data: INBOUND_ANALYSIS,
  };

  if (!agentId) {
    const agent = await retell.agent.create(agentInput as any).catch((err: any) => {
      throw new AppError(502, `Failed to create inbound Retell agent: ${err.message}`);
    });
    agentId = agent.agent_id;
  } else {
    await retell.agent.update(agentId, agentInput as any).catch((err: any) => {
      throw new AppError(502, `Failed to update inbound Retell agent: ${err.message}`);
    });
  }

  const { error: saveError } = await supabase.from('agent_configs').update({
    inbound_retell_agent_id: agentId,
    inbound_retell_llm_id: llmId,
    inbound_max_call_duration_seconds: INBOUND_MAX_SECONDS,
    updated_at: new Date().toISOString(),
  }).eq('organization_id', organizationId);
  if (saveError) throw new AppError(500, 'Inbound agent was created but could not be saved', saveError);
  return agentId;
}

export async function updateInboundVoiceSettings(
  organizationId: string,
  input: { enabled: boolean; dailyMinuteLimit?: number },
) {
  const plan = await loadPlan(organizationId);
  if (input.enabled && (!plan.billingActive || plan.planLimit <= 0)) {
    throw new AppError(403, 'Inbound AI calling is available on Growth and Scale plans');
  }
  if (input.enabled && (!env.RETELL_API_KEY || !env.RETELL_TOOL_SECRET)) {
    throw new AppError(500, 'Retell API key and tool secret must be configured before inbound calls can be enabled');
  }
  if (input.enabled && env.NODE_ENV === 'production' && !env.BACKEND_PUBLIC_URL.startsWith('https://')) {
    throw new AppError(500, 'BACKEND_PUBLIC_URL must be an HTTPS public URL before inbound calls can be enabled');
  }
  const limit = effectiveInboundLimit(plan.planLimit, input.dailyMinuteLimit);
  if (input.enabled) await createOrUpdateInboundAgent(organizationId);

  // Change the provider-side phone routing first. Only advertise the setting
  // as enabled after every active number has accepted the webhook config.
  await configureActiveRetellInboundPhoneNumbers(organizationId, input.enabled);
  const { error } = await supabase.from('agent_configs').update({
    inbound_enabled: input.enabled,
    inbound_daily_minute_limit: plan.planLimit > 0 ? limit : null,
    updated_at: new Date().toISOString(),
  }).eq('organization_id', organizationId);
  if (error) throw new AppError(500, 'Failed to save inbound calling settings', error);
  return getInboundVoiceStatus(organizationId);
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function findLeadByPhone(organizationId: string, fromNumber: string): Promise<MatchedLead | null> {
  const e164 = normalizePhoneForCalling(fromNumber) ?? fromNumber;
  const last10 = phoneLast10(fromNumber);
  if (last10.length < 7) return null;
  const { data, error } = await supabase.rpc('find_inbound_leads_by_phone', {
    p_organization_id: organizationId,
    p_e164: e164,
    p_last10: last10,
  });
  if (error) throw new AppError(500, 'Caller lookup failed', error);
  return selectBestPhoneMatch(data as MatchedLead[] | null);
}

async function pauseAutomatedOutbound(organizationId: string, leadId: string) {
  const now = new Date().toISOString();
  await supabase.from('leads').update({
    outbound_paused_at: now,
    outbound_pause_reason: 'inbound_call_in_progress',
    outbound_resume_at: null,
    updated_at: now,
  }).eq('organization_id', organizationId).eq('id', leadId);
}

function timeZoneOffsetMinutes(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {} as Record<string, string>);
  const representedAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return Math.round((representedAsUtc - date.getTime()) / 60_000);
}

export function localDayStartUtc(timeZone: string, now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {} as Record<string, string>);
  const nominalNoon = new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day), 12));
  const offset = timeZoneOffsetMinutes(timeZone, nominalNoon);
  return new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day)) - offset * 60_000);
}

async function inboundUsageSeconds(organizationId: string, timeZone: string) {
  const start = localDayStartUtc(timeZone);
  const { data, error } = await supabase
    .from('calls')
    .select('duration_seconds,status,started_at,ended_at')
    .eq('organization_id', organizationId)
    .eq('direction', 'inbound')
    .gte('created_at', start.toISOString())
    .neq('status', 'rejected');
  if (error) throw new AppError(500, 'Failed to load inbound usage', error);
  const now = Date.now();
  return (data ?? []).reduce((total, row) => {
    if (typeof row.duration_seconds === 'number') return total + row.duration_seconds;
    if (row.started_at && !row.ended_at) return total + Math.max(0, Math.floor((now - new Date(row.started_at).getTime()) / 1000));
    return total;
  }, 0);
}

async function hasActiveUnknownInbound(organizationId: string) {
  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('direction', 'inbound')
    .eq('identity_status', 'unknown')
    .in('status', ['queued', 'in_progress']);
  if (error) throw new AppError(500, 'Failed to check active inbound calls', error);
  return (count ?? 0) > 0;
}

async function tooManyUnknownAttempts(organizationId: string, fromNumber: string) {
  const since = new Date(Date.now() - UNKNOWN_ATTEMPT_WINDOW_MS).toISOString();
  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('direction', 'inbound')
    .eq('from_number', fromNumber)
    .gte('created_at', since);
  if (error) throw new AppError(500, 'Failed to check inbound caller rate', error);
  return (count ?? 0) >= UNKNOWN_ATTEMPT_LIMIT;
}

async function rejectInbound(input: Record<string, any>, reason: string, organizationId?: string) {
  if (organizationId) {
    await supabase.from('calls').insert({
      organization_id: organizationId,
      campaign_id: null,
      lead_id: null,
      direction: 'inbound',
      from_number: input.from_number ?? null,
      to_number: input.to_number ?? null,
      status: 'rejected',
      identity_status: 'unknown',
      rejection_reason: reason,
      provider_metadata: { inbound_event_id: input.call_id ?? null },
    });
  }
  return { call_inbound: { reject: true } };
}

export async function handleInboundRetellWebhook(rawBody: Buffer, signature: string) {
  verifyRetellRequest(rawBody, signature);
  const payload = parseJson(rawBody);
  if (payload.event !== 'call_inbound') throw new AppError(400, 'Expected call_inbound event');
  const inbound = (payload.call_inbound ?? payload.call ?? payload) as Record<string, any>;
  const fromNumber = String(inbound.from_number ?? '');
  const toNumber = String(inbound.to_number ?? '');
  if (!fromNumber || !toNumber) throw new AppError(400, 'Inbound call is missing phone numbers');

  const { data: phone, error: phoneError } = await supabase
    .from('retell_phone_numbers')
    .select('organization_id')
    .eq('phone_number', toNumber)
    .eq('status', 'active')
    .maybeSingle();
  if (phoneError) throw new AppError(500, 'Failed to resolve inbound number', phoneError);
  if (!phone) return rejectInbound(inbound, 'unmanaged_number');

  const organizationId = phone.organization_id;
  const [{ data: config }, plan] = await Promise.all([
    supabase.from('agent_configs').select('*').eq('organization_id', organizationId).single(),
    loadPlan(organizationId),
  ]);
  if (!config?.inbound_enabled || !config.inbound_retell_agent_id || !plan.billingActive || plan.planLimit <= 0) {
    return rejectInbound(inbound, 'inbound_disabled', organizationId);
  }

  const matchedLead = await withDeadline(findLeadByPhone(organizationId, fromNumber), LOOKUP_DEADLINE_MS).catch(() => null);
  const known = Boolean(matchedLead);
  const retrySince = new Date(Date.now() - 30_000).toISOString();
  const { data: recentCall } = await supabase
    .from('calls')
    .select('id,identity_status,max_duration_seconds')
    .eq('organization_id', organizationId)
    .eq('direction', 'inbound')
    .eq('from_number', fromNumber)
    .eq('to_number', toNumber)
    .in('status', ['queued', 'in_progress'])
    .gte('created_at', retrySince)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentCall) {
    return {
      call_inbound: {
        override_agent_id: config.inbound_retell_agent_id,
        dynamic_variables: {
          caller_identity_status: recentCall.identity_status ?? (known ? 'phone_match' : 'unknown'),
          lead_name: known ? (matchedLead!.name || [matchedLead!.first_name, matchedLead!.last_name].filter(Boolean).join(' ')) : 'Unavailable',
          lead_title: known ? (matchedLead!.title || 'Unavailable') : 'Unavailable',
          lead_company: known ? (matchedLead!.company || 'Unavailable') : 'Unavailable',
          lead_factual_summary: 'Unavailable',
          lead_do_not_claim: 'Any fact not explicitly listed as verified is unavailable.',
        },
        metadata: { gnx_call_id: recentCall.id, direction: 'inbound' },
        agent_override: { max_call_duration_ms: (recentCall.max_duration_seconds ?? INBOUND_MAX_SECONDS) * 1000 },
      },
    };
  }
  if (!known && await tooManyUnknownAttempts(organizationId, fromNumber)) {
    return rejectInbound(inbound, 'caller_rate_limited', organizationId);
  }

  const configuredLimit = effectiveInboundLimit(plan.planLimit, config.inbound_daily_minute_limit);
  const usedSeconds = await inboundUsageSeconds(organizationId, plan.timezone);
  const remainingSeconds = Math.max(0, configuredLimit * 60 - usedSeconds);
  if (!known && remainingSeconds < 60) {
    return rejectInbound(inbound, 'daily_unknown_budget_exhausted', organizationId);
  }
  if (!known && await hasActiveUnknownInbound(organizationId)) {
    return rejectInbound(inbound, 'unknown_concurrency_limit', organizationId);
  }

  const maxSeconds = known ? INBOUND_MAX_SECONDS : Math.min(INBOUND_MAX_SECONDS, remainingSeconds);
  const dncAtCall = leadHasDnc(matchedLead);
  let dynamicVariables: Record<string, string> = {
    caller_identity_status: known ? 'phone_match' : 'unknown',
    lead_name: known ? (matchedLead!.name || [matchedLead!.first_name, matchedLead!.last_name].filter(Boolean).join(' ')) : 'Unavailable',
    lead_title: known ? (matchedLead!.title || 'Unavailable') : 'Unavailable',
    lead_company: known ? (matchedLead!.company || 'Unavailable') : 'Unavailable',
    lead_factual_summary: 'Unavailable',
    lead_do_not_claim: 'Any fact not explicitly listed as verified is unavailable.',
  };

  if (matchedLead) {
    await pauseAutomatedOutbound(organizationId, matchedLead.id);
    const snapshot = await withDeadline(
      createOrReuseLeadContextSnapshot(organizationId, matchedLead.id, matchedLead.campaign_id, 'voice', config),
      Math.max(250, LOOKUP_DEADLINE_MS - 500),
    ).catch(() => null);
    if (snapshot) dynamicVariables = { ...dynamicVariables, ...contextSnapshotToDynamicVariables(snapshot, matchedLead) };
  }

  const { data: callRecord, error: insertError } = await supabase.from('calls').insert({
    organization_id: organizationId,
    campaign_id: matchedLead?.campaign_id ?? null,
    lead_id: matchedLead?.id ?? null,
    direction: 'inbound',
    from_number: fromNumber,
    to_number: toNumber,
    status: 'queued',
    identity_status: known ? 'phone_match' : 'unknown',
    identity_confirmed: false,
    dnc_at_call: dncAtCall,
    max_duration_seconds: maxSeconds,
    provider_metadata: { original_agent_id: inbound.agent_id ?? null },
  }).select('id').single();
  if (insertError || !callRecord) throw new AppError(500, 'Failed to create inbound call record', insertError);

  return {
    call_inbound: {
      override_agent_id: config.inbound_retell_agent_id,
      dynamic_variables: dynamicVariables,
      metadata: { gnx_call_id: callRecord.id, direction: 'inbound' },
      agent_override: { max_call_duration_ms: maxSeconds * 1000 },
    },
  };
}

export async function identifyInboundCaller(call: InboundCallContext, args: Record<string, unknown>) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const company = typeof args.company === 'string' ? args.company.trim() : '';
  if (!name || !company) throw new AppError(400, 'Confirmed name and company are required');
  const { data, error } = await supabase.rpc('find_inbound_leads_by_identity', {
    p_organization_id: call.organization_id,
    p_name: name,
    p_company: company,
  });
  if (error) throw new AppError(500, 'Caller identity lookup failed', error);
  if (data?.length !== 1) {
    await supabase.from('calls').update({ identity_status: data?.length ? 'mismatch' : 'unknown' }).eq('id', call.id);
    return { matched: false, reason: data?.length ? 'ambiguous' : 'not_found', instruction: 'Treat the caller as unknown. Do not guess.' };
  }
  const lead = data[0];
  await pauseAutomatedOutbound(call.organization_id, lead.id);
  await supabase.from('calls').update({
    lead_id: lead.id,
    campaign_id: lead.campaign_id,
    identity_status: 'tool_match',
    identity_confirmed: true,
    dnc_at_call: leadHasDnc(lead),
  }).eq('id', call.id);
  return {
    matched: true,
    lead: {
      name: lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(' '),
      company: lead.company || 'Unavailable',
      title: lead.title || 'Unavailable',
      dnc: leadHasDnc(lead),
    },
    instruction: 'Use only these returned facts. The caller initiated this call; preserve any DNC restriction for future outbound contact.',
  };
}

export async function createInboundLead(call: InboundCallContext, args: Record<string, unknown>) {
  if (call.lead_id) return { created: false, leadId: call.lead_id, reason: 'call_already_identified' };
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const company = typeof args.company === 'string' ? args.company.trim() : '';
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const intent = args.intent === 'meeting' || args.intent === 'follow_up' ? args.intent : null;
  if (!name || !company || !/^\S+@\S+\.\S+$/.test(email) || !intent) {
    throw new AppError(400, 'Confirmed name, company, valid email, and high-intent action are required');
  }
  const parts = name.split(/\s+/);
  const { data: lead, error } = await supabase.from('leads').insert({
    organization_id: call.organization_id,
    campaign_id: null,
    source: 'inbound',
    first_name: parts[0] ?? null,
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
    name,
    company,
    email,
    phone: call.from_number,
    status: intent === 'meeting' ? 'engaged' : 'engaged',
    raw_data: { inbound_call_id: call.id, intent },
  }).select('id').single();
  if (error || !lead) throw new AppError(500, 'Failed to create inbound lead', error);
  await supabase.from('calls').update({
    lead_id: lead.id,
    identity_status: 'created_inbound',
    identity_confirmed: true,
  }).eq('id', call.id);
  return { created: true, leadId: lead.id, instruction: 'The lead is now attached to this call. You may proceed with follow-up or meeting booking.' };
}

export async function settleInboundOutboundPause(call: InboundCallContext & { disposition?: string | null; substantive_conversation?: boolean | null; identity_confirmed?: boolean }) {
  if (!call.lead_id) return;
  const permanent = Boolean(call.identity_confirmed && call.substantive_conversation);
  if (permanent) {
    await supabase.from('leads').update({
      outbound_pause_reason: 'inbound_substantive_conversation',
      outbound_resume_at: null,
      status: call.disposition === 'meeting_booked'
        ? 'meeting_booked'
        : call.disposition === 'not_interested'
          ? 'not_interested'
          : 'engaged',
      updated_at: new Date().toISOString(),
    }).eq('organization_id', call.organization_id).eq('id', call.lead_id);
    return;
  }
  const resumable = ['no_connect', 'wrong_person', 'technical_failure', null, undefined].includes(call.disposition);
  await supabase.from('leads').update({
    outbound_pause_reason: resumable ? 'inbound_no_substantive_connect' : 'inbound_call_review',
    outbound_resume_at: resumable ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq('organization_id', call.organization_id).eq('id', call.lead_id);
}
