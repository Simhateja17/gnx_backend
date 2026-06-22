import Retell from 'retell-sdk';
import { env } from '../config/env';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

const retell = new Retell({ apiKey: env.RETELL_API_KEY });

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
