import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import { AppError } from '../types';
import { checkApolloEnrichmentCap } from './leads.service';

export async function enrichLeads(
  organizationId: string,
  leadIds: string[],
  _campaignId: string,
) {
  await checkApolloEnrichmentCap(organizationId, _campaignId || null);

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email, first_name, last_name, company')
    .eq('organization_id', organizationId)
    .in('id', leadIds);

  if (error) throw new AppError(500, 'Failed to fetch leads for enrichment');
  if (!leads || leads.length === 0) return { enriched: 0 };

  let enriched = 0;

  for (const lead of leads) {
    if (!lead.email) continue;

    try {
      const response = await fetch('https://api.apollo.io/api/v1/people/match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.APOLLO_API_KEY,
        },
        body: JSON.stringify({
          email: lead.email,
          first_name: lead.first_name ?? undefined,
          last_name: lead.last_name ?? undefined,
          organization_name: lead.company ?? undefined,
        }),
      });

      if (!response.ok) {
        console.warn(`[enrich-leads] Apollo match failed for lead ${lead.id}: ${response.status}`);
        continue;
      }

      const data = await response.json() as { person?: any };
      const person = data.person;
      if (!person) continue;

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (person.title && !lead.first_name) patch.title = person.title;
      if (person.linkedin_url) patch.linkedin_url = person.linkedin_url;
      if (person.phone_numbers?.[0]?.sanitized_number) patch.phone = person.phone_numbers[0].sanitized_number;
      if (person.city || person.state || person.country) {
        patch.location = [person.city, person.state, person.country].filter(Boolean).join(', ');
      }
      if (person.organization?.name && !lead.company) patch.company = person.organization.name;
      patch.raw_data = person;

      await supabase.from('leads').update(patch).eq('id', lead.id);
      enriched++;
    } catch (err: any) {
      console.error(`[enrich-leads] Error enriching lead ${lead.id}:`, err.message);
      await supabase
        .from('leads')
        .update({ status: 'enrichment_failed', updated_at: new Date().toISOString() })
        .eq('id', lead.id);
    }
  }

  return { enriched };
}
