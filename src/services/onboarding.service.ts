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
    product_description: data.productDescription ?? '',
    value_proposition: data.valueProp ?? '',
    objections: data.objections ?? null,
    tone: data.tone ?? 'consultative',
    icp_titles: data.icpTitles ?? [],
    icp_company_sizes: data.icpCompanySizes ?? [],
    icp_geos: data.icpGeos ?? [],
    booking_link: data.bookingLink || null,
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
