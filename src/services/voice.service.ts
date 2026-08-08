import { retell } from '../lib/retell';
import { supabase } from '../lib/supabase';
import { generateVoicePrompt } from './ai.service';
import { enqueueScheduleCall } from '../jobs/schedule-call.job';
import { posthog } from '../lib/posthog';
import { AppError } from '../types';
import { isE164Phone, normalizePhoneForCalling } from '../lib/phone';
import { contextSnapshotToDynamicVariables, createOrReuseLeadContextSnapshot } from './lead-context.service';
import { bindActiveRetellOutboundPhoneNumbers } from './retell-phone.service';
import { buildOutboundAgentTools } from './retell-agent-tools';
import { verifyRetellRequest } from './retell-auth.service';
import { settleInboundOutboundPause } from './inbound-voice.service';
import { enqueueEnrichLeads } from '../jobs/enrich-leads.job';

const DEFAULT_VOICE_ID = 'openai-Alloy';

const POST_CALL_ANALYSIS_DATA = [
  {
    type: 'enum' as const,
    name: 'disposition',
    description: 'Outcome of the sales call',
    choices: ['interested', 'not_interested', 'meeting_booked', 'voicemail', 'callback', 'no_answer'],
  },
];

export async function createOrUpdateRetellAgent(organizationId: string) {
  const { data: agentConfig, error } = await supabase
    .from('agent_configs')
    .select('retell_agent_id, retell_llm_id, retell_conversation_flow_id, retell_agent_version, agent_name')
    .eq('organization_id', organizationId)
    .single();

  if (error || !agentConfig) throw new AppError(404, 'Agent config not found for this organization');

  const prompt = agentConfig.retell_conversation_flow_id
    ? null
    : (await generateVoicePrompt(organizationId, {})).prompt;

  if (!agentConfig.retell_agent_id) {
    let responseEngine: any;
    let llmId: string | null = null;
    if (agentConfig.retell_conversation_flow_id) {
      responseEngine = {
        type: 'conversation-flow',
        conversation_flow_id: agentConfig.retell_conversation_flow_id,
        version: agentConfig.retell_agent_version ?? undefined,
      };
    } else {
      // Backward-compatible default while organizations migrate to Flow.
      const llm = await retell.llm.create({ general_prompt: prompt ?? '', general_tools: buildOutboundAgentTools() as any }).catch((err: any) => {
        throw new AppError(502, `Failed to create Retell LLM: ${err.message}`);
      });
      llmId = llm.llm_id;
      responseEngine = { type: 'retell-llm', llm_id: llm.llm_id };
    }

    const agent = await retell.agent.create({
      agent_name: agentConfig.agent_name ?? 'Nexo',
      response_engine: responseEngine,
      voice_id: DEFAULT_VOICE_ID,
      post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
    }).catch((err: any) => {
      throw new AppError(502, `Failed to create Retell agent: ${err.message}`);
    });

    await supabase
      .from('agent_configs')
      .update({ retell_agent_id: agent.agent_id, retell_llm_id: llmId })
      .eq('organization_id', organizationId);

    await bindActiveRetellOutboundPhoneNumbers(organizationId, agent.agent_id);

    return { agentId: agent.agent_id };
  }

  // Existing agent: keep the legacy LLM path working, or attach the selected
  // Conversation Flow when onboarding has configured one.
  let responseEngine: any;
  if (agentConfig.retell_conversation_flow_id) {
    responseEngine = {
      type: 'conversation-flow',
      conversation_flow_id: agentConfig.retell_conversation_flow_id,
      version: agentConfig.retell_agent_version ?? undefined,
    };
  } else {
    const llmId = agentConfig.retell_llm_id ?? await resolveLlmId(agentConfig.retell_agent_id, organizationId);
    await retell.llm.update(llmId, { general_prompt: prompt ?? '', general_tools: buildOutboundAgentTools() as any }).catch((err: any) => {
      throw new AppError(502, `Failed to update Retell LLM: ${err.message}`);
    });
    responseEngine = { type: 'retell-llm', llm_id: llmId };
  }

  await retell.agent.update(agentConfig.retell_agent_id, {
    post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
    response_engine: responseEngine,
  }).catch((err: any) => {
    console.warn(`[voice] Failed to update agent analysis config: ${err.message}`);
  });

  await bindActiveRetellOutboundPhoneNumbers(organizationId, agentConfig.retell_agent_id);

  return { agentId: agentConfig.retell_agent_id };
}

// Each voice/both-channel campaign gets its own Retell agent + LLM, so
// campaigns with different pitches/objections don't share one conversation
// flow. Deliberately does not bind the org's shared number: outbound calls
// select the campaign agent per-call via override_agent_id, while inbound is
// configured independently through the signed inbound webhook.
export async function createOrUpdateRetellAgentForCampaign(organizationId: string, campaignId: string) {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id, name, retell_agent_id, retell_llm_id')
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .single();
  if (error || !campaign) throw new AppError(404, 'Campaign not found');

  const { prompt } = await generateVoicePrompt(organizationId, { campaignId });
  const tools = buildOutboundAgentTools();

  if (!campaign.retell_agent_id) {
    const llm = await retell.llm.create({ general_prompt: prompt ?? '', general_tools: tools as any }).catch((err: any) => {
      throw new AppError(502, `Failed to create Retell LLM: ${err.message}`);
    });
    const agent = await retell.agent.create({
      agent_name: campaign.name,
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      voice_id: DEFAULT_VOICE_ID,
      post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
    }).catch((err: any) => {
      throw new AppError(502, `Failed to create Retell agent: ${err.message}`);
    });

    await supabase
      .from('campaigns')
      .update({ retell_agent_id: agent.agent_id, retell_llm_id: llm.llm_id })
      .eq('id', campaignId);

    return { agentId: agent.agent_id };
  }

  await retell.llm.update(campaign.retell_llm_id!, { general_prompt: prompt ?? '', general_tools: tools as any }).catch((err: any) => {
    throw new AppError(502, `Failed to update Retell LLM: ${err.message}`);
  });
  await retell.agent.update(campaign.retell_agent_id, {
    post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
  }).catch((err: any) => {
    throw new AppError(502, `Failed to update Retell agent: ${err.message}`);
  });

  return { agentId: campaign.retell_agent_id };
}

// Retrieve llm_id from Retell when it's missing from our DB (edge case for old records)
async function resolveLlmId(agentId: string, organizationId: string): Promise<string> {
  const agent = await retell.agent.retrieve(agentId).catch((err: any) => {
    throw new AppError(502, `Failed to retrieve Retell agent: ${err.message}`);
  });

  const engine = agent.response_engine as { type: string; llm_id?: string };
  if (engine.type !== 'retell-llm' || !engine.llm_id) {
    throw new AppError(500, 'Agent is not a Retell LLM agent or llm_id is missing');
  }

  // Save it so we don't need to retrieve next time
  await supabase
    .from('agent_configs')
    .update({ retell_llm_id: engine.llm_id })
    .eq('organization_id', organizationId);

  return engine.llm_id;
}

export async function scheduleCall(
  organizationId: string,
  campaignId: string,
  leadId: string,
  fromNumber: string,
  toNumber: string,
) {
  if (!isE164Phone(fromNumber) || !isE164Phone(toNumber)) {
    throw new AppError(400, 'Call numbers must use E.164 format, for example +916301658275');
  }

  const { data: agentConfig } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('organization_id', organizationId)
    .single();

  const { data: campaignRow } = await supabase
    .from('campaigns')
    .select('retell_agent_id')
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  // Campaigns launched before per-campaign agents shipped fall back to the
  // org's shared agent.
  const agentId = campaignRow?.retell_agent_id ?? agentConfig?.retell_agent_id;
  if (!agentId) {
    throw new AppError(400, 'No Retell agent configured for this campaign');
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('id, first_name, last_name, name, title, company, email, account_id, headline, department, job_function, seniority, city, state, country, status, outbound_paused_at, outbound_pause_reason, outbound_resume_at, last_apollo_enriched_at, updated_at, created_at')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single();

  if (!lead) throw new AppError(404, 'Lead not found');
  if (['engaged', 'meeting_booked', 'not_interested', 'unsubscribed'].includes(lead.status)) {
    return { success: false, reason: 'sequence_stopped', leadStatus: lead.status };
  }
  if (lead.outbound_paused_at) {
    const resumeAt = lead.outbound_resume_at ? new Date(lead.outbound_resume_at).getTime() : null;
    if (!resumeAt || resumeAt > Date.now()) {
      const delayMs = resumeAt ? Math.max(1_000, resumeAt - Date.now()) : 5 * 60 * 1000;
      await enqueueScheduleCall({ organizationId, campaignId, leadId, fromNumber, toNumber }, delayMs);
      return { success: false, reason: 'outbound_paused_for_inbound', requeued: true, delayMs };
    }
    await supabase.from('leads').update({
      outbound_paused_at: null,
      outbound_pause_reason: null,
      outbound_resume_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', leadId).eq('organization_id', organizationId);
  }

  const contextSnapshot = await createOrReuseLeadContextSnapshot(
    organizationId,
    leadId,
    campaignId,
    'voice',
    agentConfig,
  );

  const callRecord = await supabase
    .from('calls')
    .insert({
      organization_id: organizationId,
      campaign_id: campaignId,
      lead_id: leadId,
      context_snapshot_id: contextSnapshot.id,
      from_number: fromNumber,
      to_number: toNumber,
      status: 'queued',
      direction: 'outbound',
    })
    .select('id')
    .single();

  if (callRecord.error) throw new AppError(500, 'Failed to create call record');

  try {
    const call = await retell.call.createPhoneCall({
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agentId,
      retell_llm_dynamic_variables: contextSnapshotToDynamicVariables(contextSnapshot, lead),
    });

    await supabase
      .from('calls')
      .update({
        retell_call_id: call.call_id,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      })
      .eq('id', callRecord.data.id);

    return { success: true, callId: callRecord.data.id, retellCallId: call.call_id };
  } catch (err: any) {
    await supabase
      .from('calls')
      .update({ status: 'failed' })
      .eq('id', callRecord.data.id);

    throw new AppError(502, `Retell call failed: ${err.message}`);
  }
}

export async function callLeadNow(organizationId: string, leadId: string) {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('id,campaign_id,phone,status,outbound_paused_at,outbound_resume_at,campaigns(id,channel,voice_mode,timezone)')
    .eq('organization_id', organizationId)
    .eq('id', leadId)
    .maybeSingle();

  if (leadError) throw new AppError(500, 'Failed to fetch lead for immediate call', leadError);
  if (!lead) throw new AppError(404, 'Lead not found');
  if (!lead.phone) throw new AppError(400, 'Lead has no phone number');
  if (!lead.campaign_id) throw new AppError(400, 'Lead is not attached to a campaign');
  if (['engaged', 'meeting_booked', 'not_interested', 'unsubscribed'].includes(lead.status)) {
    throw new AppError(400, `Lead status is ${lead.status}; calls are stopped for this lead`);
  }
  if (lead.outbound_paused_at && (!lead.outbound_resume_at || new Date(lead.outbound_resume_at).getTime() > Date.now())) {
    throw new AppError(409, 'Outbound contact is paused because this lead called in');
  }

  const campaign = lead.campaigns as unknown as { channel?: string; voice_mode?: string; timezone?: string } | null;
  if (campaign?.channel !== 'voice' && campaign?.channel !== 'both') {
    throw new AppError(400, 'Immediate calling is only available for voice campaigns');
  }
  if (campaign.voice_mode !== 'ai') {
    throw new AppError(400, 'Immediate AI calling is only available for AI voice campaigns');
  }

  const toNumber = normalizePhoneForCalling(lead.phone, campaign.timezone);
  if (!toNumber) {
    throw new AppError(400, 'Lead phone number is invalid. Use E.164 format, for example +916301658275');
  }

  const { data: activeCall, error: activeCallError } = await supabase
    .from('calls')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('campaign_id', lead.campaign_id)
    .eq('lead_id', leadId)
    .in('status', ['queued', 'in_progress'])
    .limit(1)
    .maybeSingle();

  if (activeCallError) throw new AppError(500, 'Failed to check active calls', activeCallError);
  if (activeCall) throw new AppError(409, 'A call to this lead is already queued or in progress');

  const { data: agentConfig, error: configError } = await supabase
    .from('agent_configs')
    .select('retell_phone_number')
    .eq('organization_id', organizationId)
    .single();

  const { data: provisionedPhone } = await supabase
    .from('retell_phone_numbers')
    .select('phone_number')
    .eq('organization_id', organizationId)
    .eq('entitlement_kind', 'included')
    .eq('status', 'active')
    .not('phone_number', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const fromNumber = provisionedPhone?.phone_number ?? agentConfig?.retell_phone_number;
  if (configError || !fromNumber) {
    throw new AppError(400, 'Add your Retell phone number in Settings before calling this lead');
  }

  return scheduleCall(
    organizationId,
    lead.campaign_id,
    leadId,
    fromNumber,
    toNumber,
  );
}

export async function handleRetellWebhook(rawBody: Buffer, signature: string) {
  const bodyStr = rawBody.toString('utf-8');
  verifyRetellRequest(rawBody, signature);

  const payload = JSON.parse(bodyStr) as { event: string; call: Record<string, any> };
  const { event, call } = payload;

  let { data: callRecord } = await supabase
    .from('calls')
    .select('id, lead_id, organization_id, campaign_id, direction, identity_status, identity_confirmed, substantive_conversation, requested_no_future_contact, disposition, from_number')
    .eq('retell_call_id', call.call_id)
    .maybeSingle();

  const internalCallId = call.metadata?.gnx_call_id;
  if (!callRecord && internalCallId) {
    const result = await supabase
      .from('calls')
      .select('id, lead_id, organization_id, campaign_id, direction, identity_status, identity_confirmed, substantive_conversation, requested_no_future_contact, disposition, from_number')
      .eq('id', internalCallId)
      .maybeSingle();
    callRecord = result.data;
    if (callRecord && call.call_id) {
      await supabase.from('calls').update({ retell_call_id: call.call_id }).eq('id', callRecord.id);
    }
  }

  if (!callRecord) return; // Call we didn't initiate — ignore

  if (event === 'call_started') {
    await supabase.from('calls').update({
      status: 'in_progress',
      started_at: call.start_timestamp ? new Date(call.start_timestamp).toISOString() : new Date().toISOString(),
    }).eq('id', callRecord.id);
  }

  if (event === 'call_ended') {
    const isVoicemail = call.call_analysis?.in_voicemail === true;
    const startedAt = call.start_timestamp ? new Date(call.start_timestamp).getTime() : null;
    const endedAt = call.end_timestamp ? new Date(call.end_timestamp).getTime() : Date.now();
    const durationSeconds = typeof call.duration_ms === 'number'
      ? Math.max(0, Math.ceil(call.duration_ms / 1000))
      : startedAt ? Math.max(0, Math.ceil((endedAt - startedAt) / 1000)) : null;
    await supabase.from('calls').update({
      status: isVoicemail ? 'voicemail' : 'completed',
      ended_at: new Date(endedAt).toISOString(),
      duration_seconds: durationSeconds,
    }).eq('id', callRecord.id);

    if (callRecord.direction === 'inbound' && callRecord.identity_status === 'created_inbound' && callRecord.lead_id) {
      await enqueueEnrichLeads({
        organizationId: callRecord.organization_id,
        campaignId: null,
        leadIds: [callRecord.lead_id],
      }, { jobId: `inbound-enrich-${callRecord.id}` });
    }
    if (callRecord.direction === 'inbound' && !callRecord.substantive_conversation && !callRecord.requested_no_future_contact) {
      // Establish the safe fallback immediately. A later analyzed event can
      // replace this with a permanent stop when identity and substance are
      // confirmed; if analysis never arrives, automation resumes after 24h.
      await settleInboundOutboundPause({ ...callRecord, disposition: null, substantive_conversation: false });
    }

    posthog?.capture({
      distinctId: callRecord.organization_id,
      event: 'call_completed',
      properties: { callId: callRecord.id, campaignId: callRecord.campaign_id, leadId: callRecord.lead_id, voicemail: isVoicemail },
    });
  }

  if (event === 'call_analyzed') {
    const analysis = call.call_analysis?.custom_analysis_data as Record<string, any> | undefined;
    const disposition = analysis?.disposition ?? null;
    const identityConfirmed = analysis?.identity_confirmed === true || callRecord.identity_confirmed;
    const substantiveConversation = analysis?.substantive_conversation === true;
    const requestedNoFutureContact = analysis?.requested_no_future_contact === true;

    await supabase.from('calls').update({
      // Inbound agents use basic_attributes_only. Never copy transient Retell
      // artifacts into our database even if a provider payload includes them.
      transcript: callRecord.direction === 'inbound' ? null : call.transcript ?? null,
      recording_url: callRecord.direction === 'inbound' ? null : call.recording_url ?? null,
      disposition,
      identity_confirmed: identityConfirmed,
      substantive_conversation: substantiveConversation,
      requested_no_future_contact: requestedNoFutureContact,
    }).eq('id', callRecord.id);

    if (requestedNoFutureContact && callRecord.lead_id) {
      await supabase.from('leads').update({
        do_not_call: true,
        status: 'not_interested',
        outbound_pause_reason: 'caller_requested_no_future_contact',
        outbound_resume_at: null,
        updated_at: new Date().toISOString(),
      }).eq('organization_id', callRecord.organization_id).eq('id', callRecord.lead_id);
    }

    if (callRecord.direction === 'inbound' && !requestedNoFutureContact) {
      await settleInboundOutboundPause({
        ...callRecord,
        disposition,
        identity_confirmed: identityConfirmed,
        substantive_conversation: substantiveConversation || requestedNoFutureContact,
      });
    }

    // book_meeting already sets lead.status in real time when the agent
    // actually locks a slot mid-call - that's the authoritative signal. This
    // is only a backup for the case where the agent said something like a
    // meeting was booked but never called the tool (hallucination/bug).
    const { data: realTimeMeeting } = await supabase
      .from('meetings')
      .select('id')
      .eq('call_id', callRecord.id)
      .maybeSingle();

    if (disposition === 'meeting_booked' && !realTimeMeeting && callRecord.lead_id) {
      await supabase.from('leads').update({ status: 'meeting_booked' }).eq('id', callRecord.lead_id);

      posthog?.capture({
        distinctId: callRecord.organization_id,
        event: 'meeting_booked',
        properties: { callId: callRecord.id, campaignId: callRecord.campaign_id, leadId: callRecord.lead_id, source: 'voice' },
      });
    }
  }
}

export async function retryCall(callId: string, orgId: string) {
  const { data: call } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .eq('organization_id', orgId)
    .single();

  if (!call) throw new AppError(404, 'Call not found');
  if (call.status !== 'failed') throw new AppError(400, 'Only failed calls can be retried');
  if (call.direction === 'inbound') throw new AppError(400, 'Inbound calls cannot be retried as outbound calls');

  await enqueueScheduleCall({
    leadId: call.lead_id,
    campaignId: call.campaign_id,
    organizationId: orgId,
    fromNumber: call.from_number,
    toNumber: call.to_number,
  });
}
