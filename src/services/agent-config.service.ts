import { supabase } from '../lib/supabase';
import { AppError } from '../types';

function defaultAgentConfig(orgId: string, orgName: string) {
  return {
    organization_id: orgId,
    agent_name: 'Nexo',
    product_description: `Sales outreach for ${orgName}`,
    value_proposition: `Help prospects understand relevant ways ${orgName} can support their business.`,
    objections: null,
    tone: 'consultative',
    icp_titles: [],
    icp_company_sizes: [],
    icp_geos: [],
    booking_link: null,
    updated_at: new Date().toISOString(),
  };
}

export async function ensureAgentConfig(orgId: string) {
  const { data: existing, error: existingError } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (existingError) throw new AppError(500, 'Failed to read agent configuration', existingError);
  if (existing) return existing;

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();

  if (orgError) throw new AppError(500, 'Failed to read organization for agent configuration', orgError);

  const { data: created, error: createError } = await supabase
    .from('agent_configs')
    .insert(defaultAgentConfig(orgId, org?.name ?? 'your company'))
    .select('*')
    .single();

  if (createError || !created) throw new AppError(500, 'Failed to create default agent configuration', createError);
  return created;
}
