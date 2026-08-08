import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: {
    APOLLO_API_KEY: 'test-apollo-key',
  },
}));

import { matchApolloPerson, searchApolloPeople } from './apollo';

describe('Apollo request logging', () => {
  const fetchMock = vi.fn();
  type ConsoleCall = [string, Record<string, unknown>];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('logs safe request and response summaries for a people search', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        people: [{ id: 'person-1' }],
        pagination: { page: 2 },
        request_id: 'apollo-request-1',
      })),
    });

    await searchApolloPeople(
      {
        page: 2,
        per_page: 50,
        person_titles: ['VP Sales'],
        q_keywords: 'confidential search phrase',
      },
      {
        organizationId: 'org-1',
        campaignId: 'campaign-1',
        enrichmentRunId: 'run-1',
      },
    );

    expect(logSpy).toHaveBeenCalledTimes(2);
    const logCalls = logSpy.mock.calls as unknown as ConsoleCall[];
    const startCall = logCalls.find(call => call[0] === '[apollo] people_search start');
    const successCall = logCalls.find(call => call[0] === '[apollo] people_search success');

    expect(startCall?.[1]).toMatchObject({
      callId: expect.any(String),
      organizationId: 'org-1',
      campaignId: 'campaign-1',
      enrichmentRunId: 'run-1',
      page: 2,
      perPage: 50,
      titleCount: 1,
      hasKeywords: true,
    });
    expect(successCall?.[1]).toMatchObject({
      callId: expect.any(String),
      httpStatus: 200,
      peopleReturned: 1,
      providerRequestId: 'apollo-request-1',
    });

    const serializedLogs = JSON.stringify(logSpy.mock.calls);
    expect(serializedLogs).not.toContain('test-apollo-key');
    expect(serializedLogs).not.toContain('confidential search phrase');
  });

  it('logs provider failures without logging the submitted identifier or raw response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        request_id: 'apollo-request-2',
        message: 'provider response with private details',
      })),
    });

    await expect(
      matchApolloPerson(
        { email: 'private-person@example.com' },
        { organizationId: 'org-2', leadId: 'lead-2', enrichmentRunId: 'run-2' },
      ),
    ).rejects.toMatchObject({ status: 429 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const failureCall = errorSpy.mock.calls[0];
    expect(failureCall?.[0]).toBe('[apollo] person_match failed');
    expect(failureCall?.[1]).toMatchObject({
      organizationId: 'org-2',
      leadId: 'lead-2',
      enrichmentRunId: 'run-2',
      httpStatus: 429,
      errorStatus: 429,
      providerRequestId: 'apollo-request-2',
    });

    const serializedLogs = JSON.stringify(errorSpy.mock.calls);
    expect(serializedLogs).not.toContain('private-person@example.com');
    expect(serializedLogs).not.toContain('provider response with private details');
  });
});
