import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { buildLeadContextPayload } from './lead-context.service';

describe('lead context snapshots', () => {
  it('keeps verified facts separate from hypotheses and produces a stable hash', () => {
    const input = {
      lead: {
        id: 'lead-1',
        organization_id: 'org-1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        title: 'VP Sales',
        company: 'Analytical Engines',
        seniority: 'vp',
        updated_at: '2026-08-04T00:00:00.000Z',
      },
      account: {
        name: 'Analytical Engines',
        industry: 'Software',
        estimated_num_employees: 120,
        technology_names: ['Salesforce', 'HubSpot'],
        last_enriched_at: '2026-08-03T00:00:00.000Z',
      },
      campaign: { prompt_context: 'Focus on outbound efficiency.' },
      agentConfig: {
        product_description: 'AI sales outreach automation',
        value_proposition: 'Help teams book more qualified meetings',
      },
    };

    const first = buildLeadContextPayload(input);
    const second = buildLeadContextPayload(input);

    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.factualSummary).toContain('Industry: Software');
    expect(first.painHypotheses.every(item => item.confidence === 'hypothesis')).toBe(true);
    expect(first.doNotClaim.some(item => item.includes('estimated'))).toBe(true);
    expect(first.contextPayload).toMatchObject({ source: 'apollo_and_first_party_db' });
  });
});
