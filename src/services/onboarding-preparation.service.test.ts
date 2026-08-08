import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runApolloImportMock: vi.fn(),
  redisMock: { set: vi.fn(), get: vi.fn() },
}));

vi.mock('../lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) },
}));
vi.mock('../lib/redis', () => ({ redis: mocks.redisMock }));
vi.mock('./apollo-import.service', () => ({ runApolloImport: mocks.runApolloImportMock }));

import { prepareApolloLeadsForCampaign } from './onboarding-preparation.service';

const ORGANIZATION_ID = 'org-1';
const CAMPAIGN_ID = 'campaign-1';

const criteria = {
  organizationId: ORGANIZATION_ID,
  campaignId: CAMPAIGN_ID,
  targetEnriched: 10,
  titles: ['VP Sales'],
  locations: ['United States'],
  companySizes: ['51-200'],
  keywords: 'SaaS',
};

function importRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    qualified_count: 10,
    candidates_found: 40,
    candidates_attempted: 24,
    duplicate_count: 3,
    rejected_count: 11,
    failed_count: 0,
    pages_searched: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.runApolloImportMock.mockReset();
  mocks.redisMock.set.mockClear();
  mocks.redisMock.get.mockClear();
});

describe('onboarding Apollo preparation', () => {
  it('delegates to the shared import pipeline rather than running its own loop', async () => {
    // One definition of "a lead worth contacting" - onboarding must not have
    // its own search-and-enrich path with different qualification rules.
    mocks.runApolloImportMock.mockResolvedValue(importRun());

    await prepareApolloLeadsForCampaign(criteria);

    expect(mocks.runApolloImportMock).toHaveBeenCalledTimes(1);
    expect(mocks.runApolloImportMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORGANIZATION_ID,
      campaignId: CAMPAIGN_ID,
      titles: ['VP Sales'],
      limit: 10,
    }));
  });

  it('maps the run counters into the progress the dashboard card reads', async () => {
    mocks.runApolloImportMock.mockResolvedValue(importRun());

    const progress = await prepareApolloLeadsForCampaign(criteria);

    expect(progress).toMatchObject({
      status: 'ready',
      enriched: 10,
      candidatesFound: 40,
      candidatesAttempted: 24,
      skippedDuplicates: 3,
      rejected: 11,
      searchPages: 1,
      importRunId: 'run-1',
      error: null,
    });
  });

  it('reports a shortfall as partial rather than raising an alarm', async () => {
    // Apollo may simply not hold ten verified people for a given profile.
    // That is a fact to report, not a failure to escalate.
    mocks.runApolloImportMock.mockResolvedValue(
      importRun({ status: 'partial', qualified_count: 6, rejected_count: 14 }),
    );

    const progress = await prepareApolloLeadsForCampaign(criteria);

    expect(progress.status).toBe('partial');
    expect(progress.enriched).toBe(6);
    expect(progress.error).toBeNull();
  });

  it('flags a run that qualified nobody, and says which fix applies', async () => {
    mocks.runApolloImportMock.mockResolvedValue(
      importRun({ status: 'partial', qualified_count: 0, candidates_found: 30, rejected_count: 30 }),
    );

    const progress = await prepareApolloLeadsForCampaign(criteria);

    expect(progress.status).toBe('attention');
    // Found people but none contactable - a different fix from "found nobody".
    expect(progress.error).toContain('verified work email');
  });

  it('distinguishes an empty search from an unreachable audience', async () => {
    mocks.runApolloImportMock.mockResolvedValue(
      importRun({ status: 'partial', qualified_count: 0, candidates_found: 0, rejected_count: 0 }),
    );

    const progress = await prepareApolloLeadsForCampaign(criteria);

    expect(progress.status).toBe('attention');
    expect(progress.error).toContain('no people matching');
  });

  it('records the failure in progress before rethrowing, so the card never hangs', async () => {
    mocks.runApolloImportMock.mockRejectedValue(new Error('Apollo rate limit'));

    await expect(prepareApolloLeadsForCampaign(criteria)).rejects.toThrow('Apollo rate limit');

    const lastWrite = mocks.redisMock.set.mock.calls.at(-1);
    expect(JSON.parse(lastWrite![1] as string)).toMatchObject({
      status: 'attention',
      error: 'Apollo rate limit',
    });
  });

  it('never targets more than the onboarding ceiling', async () => {
    mocks.runApolloImportMock.mockResolvedValue(importRun());

    await prepareApolloLeadsForCampaign({ ...criteria, targetEnriched: 500 });

    expect(mocks.runApolloImportMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });
});
