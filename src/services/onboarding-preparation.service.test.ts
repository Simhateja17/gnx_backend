import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    leads: [] as Array<{
      id: string;
      status: string;
      source: string;
      campaign_id: string;
      last_apollo_enriched_at: string | null;
    }>,
  };

  const makeLeadBuilder = () => {
    let selected = '';
    let ids: string[] | null = null;

    const builder: any = {
      select(fields: string) {
        selected = fields;
        return builder;
      },
      eq() {
        return builder;
      },
      is() {
        return builder;
      },
      neq() {
        return builder;
      },
      in(_column: string, values: string[]) {
        ids = values;
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (value: unknown) => unknown) {
        const rows = ids ? state.leads.filter(row => ids?.includes(row.id)) : state.leads;
        const data = selected === 'id'
          ? rows
            .filter(row => row.last_apollo_enriched_at === null && row.status !== 'enrichment_failed')
            .map(row => ({ id: row.id }))
          : rows.map(row => ({
            id: row.id,
            status: row.status,
            last_apollo_enriched_at: row.last_apollo_enriched_at,
          }));
        return Promise.resolve(resolve({ data, error: null }));
      },
    };

    return builder;
  };

  return {
    state,
    makeLeadBuilder,
    searchApolloMock: vi.fn(),
    enrichLeadsMock: vi.fn(),
    redisMock: {
      set: vi.fn(async () => 'OK'),
      get: vi.fn(async () => null),
    },
  };
});

vi.mock('../lib/supabase', () => ({
  supabase: { from: () => mocks.makeLeadBuilder() },
}));
vi.mock('../lib/redis', () => ({ redis: mocks.redisMock }));
vi.mock('./leads.service', () => ({
  searchApollo: mocks.searchApolloMock,
  enrichLeads: mocks.enrichLeadsMock,
}));

import { prepareApolloLeadsForCampaign } from './onboarding-preparation.service';

const ORGANIZATION_ID = 'org-1';
const CAMPAIGN_ID = 'campaign-1';

beforeEach(() => {
  mocks.state.leads = [{
    id: 'already-enriched',
    status: 'new',
    source: 'apollo',
    campaign_id: CAMPAIGN_ID,
    last_apollo_enriched_at: '2026-08-05T00:00:00.000Z',
  }];
  mocks.searchApolloMock.mockReset();
  mocks.enrichLeadsMock.mockReset();
  mocks.redisMock.set.mockClear();
  mocks.redisMock.get.mockClear();
  mocks.enrichLeadsMock.mockImplementation(async (_organizationId: string, leadIds: string[]) => {
    for (const leadId of leadIds) {
      const lead = mocks.state.leads.find(row => row.id === leadId);
      if (lead) lead.last_apollo_enriched_at = '2026-08-05T00:00:01.000Z';
    }
    return { enriched: leadIds.length, failed: 0 };
  });
});

describe('onboarding Apollo preparation', () => {
  it('continues across pages and enriches only pending candidates', async () => {
    mocks.searchApolloMock
      .mockImplementationOnce(async () => {
        mocks.state.leads.push({
          id: 'new-lead-1',
          status: 'new',
          source: 'apollo',
          campaign_id: CAMPAIGN_ID,
          last_apollo_enriched_at: null,
        });
        return {
          inserted: 1,
          reused: 1,
          skipped: 0,
          candidateIds: ['already-enriched', 'new-lead-1'],
          matchesReturned: 2,
        };
      })
      .mockImplementationOnce(async () => {
        mocks.state.leads.push({
          id: 'new-lead-2',
          status: 'new',
          source: 'apollo',
          campaign_id: CAMPAIGN_ID,
          last_apollo_enriched_at: null,
        });
        return {
          inserted: 1,
          reused: 1,
          skipped: 0,
          candidateIds: ['new-lead-1', 'new-lead-2'],
          matchesReturned: 2,
        };
      });

    const progress = await prepareApolloLeadsForCampaign({
      organizationId: ORGANIZATION_ID,
      campaignId: CAMPAIGN_ID,
      targetEnriched: 3,
      titles: ['VP Sales'],
      locations: ['United States'],
      companySizes: ['51-200'],
      keywords: 'SaaS',
    });

    expect(mocks.searchApolloMock).toHaveBeenCalledTimes(2);
    expect(mocks.enrichLeadsMock).toHaveBeenNthCalledWith(1, ORGANIZATION_ID, ['new-lead-1'], CAMPAIGN_ID);
    expect(mocks.enrichLeadsMock).toHaveBeenNthCalledWith(2, ORGANIZATION_ID, ['new-lead-2'], CAMPAIGN_ID);
    expect(progress).toMatchObject({
      status: 'ready',
      enriched: 3,
      candidatesAttempted: 2,
      searchPages: 2,
    });
  });
});
