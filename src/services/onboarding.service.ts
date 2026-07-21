import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import type { OnboardingInput } from '../schemas/onboarding.schema';

export async function submitOnboarding(orgId: string, data: Partial<OnboardingInput>) {
  const { data: existing } = await supabase
    .from('agent_configs')
    .select('id')
    .eq('organization_id', orgId)
    .maybeSingle();

  const record = {
    agent_name: data.agentName ?? 'Nexo',
    first_name: data.firstName ?? '',
    last_name: data.lastName ?? '',
    company: data.company ?? '',
    role: data.role ?? '',
    industry: data.industry ?? '',
    product_description: data.productDescription ?? '',
    value_proposition: data.valueProp ?? '',
    pain_points: data.painPoints ?? null,
    tone: data.tone ?? 'consultative',
    hook_style: data.hookStyle ?? '',
    follow_up_cadence: data.followUpCadence ?? '',
    icp_titles: data.icpTitles ?? [],
    icp_company_sizes: data.icpCompanySizes ?? [],
    icp_target_industries: data.icpTargetIndustries ?? [],
    icp_geos: data.icpGeos ?? [],
    meeting_target: data.meetingTarget ?? 15,
    deal_size: data.dealSize ?? '',
    sales_cycle: data.salesCycle ?? '',
    booking_link: data.bookingLink || null,
    tools: data.tools ?? [],
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from('agent_configs')
      .update(record)
      .eq('organization_id', orgId);
    if (error) throw new AppError(500, 'Failed to update agent config', error);
  } else {
    const { error } = await supabase
      .from('agent_configs')
      .insert({ ...record, organization_id: orgId });
    if (error) throw new AppError(500, 'Failed to create agent config', error);
  }

  if (data.company) {
    const { error } = await supabase
      .from('organizations')
      .update({ name: data.company })
      .eq('id', orgId);
    if (error) throw new AppError(500, 'Failed to update organisation name', error);
  }

  return { success: true };
}

export async function getOnboarding(orgId: string) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch onboarding data', error);
  return data;
}
