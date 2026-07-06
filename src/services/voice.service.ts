import Retell from 'retell-sdk';
import { retell } from '../lib/retell';
import { supabase } from '../lib/supabase';
import { generateVoicePrompt } from './ai.service';
import { enqueueScheduleCall } from '../jobs/schedule-call.job';
import { posthog } from '../lib/posthog';
import { AppError } from '../types';
import { env } from '../config/env';

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
    .select('retell_agent_id, retell_llm_id, agent_name')
    .eq('organization_id', organizationId)
    .single();

  if (error || !agentConfig) throw new AppError(404, 'Agent config not found for this organization');

  const { prompt } = await generateVoicePrompt(organizationId, {});

  if (!agentConfig.retell_agent_id) {
    // First time setup: create LLM then create agent pointing at it
    const llm = await retell.llm.create({ general_prompt: prompt }).catch((err: any) => {
      throw new AppError(502, `Failed to create Retell LLM: ${err.message}`);
    });

    const agent = await retell.agent.create({
      agent_name: agentConfig.agent_name ?? 'Nexo',
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      voice_id: DEFAULT_VOICE_ID,
      post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
    }).catch((err: any) => {
      throw new AppError(502, `Failed to create Retell agent: ${err.message}`);
    });

    await supabase
      .from('agent_configs')
      .update({ retell_agent_id: agent.agent_id, retell_llm_id: llm.llm_id })
      .eq('organization_id', organizationId);

    return { agentId: agent.agent_id };
  }

  // Existing agent: update the LLM prompt
  const llmId = agentConfig.retell_llm_id ?? await resolveLlmId(agentConfig.retell_agent_id, organizationId);

  await retell.llm.update(llmId, { general_prompt: prompt }).catch((err: any) => {
    throw new AppError(502, `Failed to update Retell LLM: ${err.message}`);
  });

  await retell.agent.update(agentConfig.retell_agent_id, {
    post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
  }).catch((err: any) => {
    console.warn(`[voice] Failed to update agent analysis config: ${err.message}`);
  });

  return { agentId: agentConfig.retell_agent_id };
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
  const { data: agentConfig } = await supabase
    .from('agent_configs')
    .select('retell_agent_id')
    .eq('organization_id', organizationId)
    .single();

  if (!agentConfig?.retell_agent_id) {
    throw new AppError(400, 'No Retell agent configured for this organization');
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, last_name, title, company, email')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single();

  if (!lead) throw new AppError(404, 'Lead not found');

  const callRecord = await supabase
    .from('calls')
    .insert({
      organization_id: organizationId,
      campaign_id: campaignId,
      lead_id: leadId,
      from_number: fromNumber,
      to_number: toNumber,
      status: 'queued',
    })
    .select('id')
    .single();

  if (callRecord.error) throw new AppError(500, 'Failed to create call record');

  try {
    const call = await retell.call.createPhoneCall({
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agentConfig.retell_agent_id,
      retell_llm_dynamic_variables: {
        lead_name: [lead.first_name, lead.last_name].filter(Boolean).join(' '),
        lead_title: lead.title ?? '',
        lead_company: lead.company ?? '',
        lead_email: lead.email ?? '',
      },
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

export async function handleRetellWebhook(rawBody: Buffer, signature: string) {
  const bodyStr = rawBody.toString('utf-8');

  if (env.RETELL_WEBHOOK_SECRET) {
    const valid = Retell.verify(bodyStr, env.RETELL_WEBHOOK_SECRET, signature);
    if (!valid) throw new AppError(401, 'Invalid webhook signature');
  }

  const payload = JSON.parse(bodyStr) as { event: string; call: Record<string, any> };
  const { event, call } = payload;

  const { data: callRecord } = await supabase
    .from('calls')
    .select('id, lead_id, organization_id, campaign_id')
    .eq('retell_call_id', call.call_id)
    .single();

  if (!callRecord) return; // Call we didn't initiate — ignore

  if (event === 'call_started') {
    await supabase.from('calls').update({
      status: 'in_progress',
      started_at: call.start_timestamp ? new Date(call.start_timestamp).toISOString() : new Date().toISOString(),
    }).eq('id', callRecord.id);
  }

  if (event === 'call_ended') {
    const isVoicemail = call.call_analysis?.in_voicemail === true;
    await supabase.from('calls').update({
      status: isVoicemail ? 'voicemail' : 'completed',
      ended_at: call.end_timestamp ? new Date(call.end_timestamp).toISOString() : new Date().toISOString(),
    }).eq('id', callRecord.id);

    posthog?.capture({
      distinctId: callRecord.organization_id,
      event: 'call_completed',
      properties: { callId: callRecord.id, campaignId: callRecord.campaign_id, leadId: callRecord.lead_id, voicemail: isVoicemail },
    });
  }

  if (event === 'call_analyzed') {
    const disposition = (call.call_analysis?.custom_analysis_data as Record<string, string> | undefined)?.disposition ?? null;

    await supabase.from('calls').update({
      transcript: call.transcript ?? null,
      recording_url: call.recording_url ?? null,
      disposition,
    }).eq('id', callRecord.id);

    if (disposition === 'meeting_booked') {
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

  await enqueueScheduleCall({
    leadId: call.lead_id,
    campaignId: call.campaign_id,
    organizationId: orgId,
    fromNumber: call.from_number,
    toNumber: call.to_number,
  });
}
