import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { AppError } from '../types';

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const APOLLO_TIMEOUT_MS = 20_000;

export type ApolloApiResponse = Record<string, any>;

export type ApolloRequestContext = {
  organizationId?: string;
  campaignId?: string | null;
  leadId?: string;
  enrichmentRunId?: string;
};

type ApolloOperation = 'people_search' | 'person_match' | 'organization_enrich' | 'organization_info';

function compactContext(context: ApolloRequestContext) {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => typeof value === 'string' && value.length > 0),
  );
}

function parseJsonBody(body: RequestInit['body']): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function hasValue(value: unknown) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function summarizeRequest(operation: ApolloOperation, path: string, init: RequestInit) {
  const body = parseJsonBody(init.body);

  if (operation === 'people_search') {
    return {
      method: init.method ?? 'GET',
      endpoint: path.split('?')[0],
      page: typeof body.page === 'number' ? body.page : undefined,
      perPage: typeof body.per_page === 'number' ? body.per_page : undefined,
      titleCount: arrayLength(body.person_titles),
      locationCount: arrayLength(body.person_locations),
      companySizeCount: arrayLength(body.organization_num_employees_ranges),
      hasKeywords: hasValue(body.q_keywords),
    };
  }

  if (operation === 'person_match') {
    const identifierFields = [
      'apollo_id',
      'email',
      'first_name',
      'last_name',
      'name',
      'organization_name',
      'domain',
      'linkedin_url',
    ].filter(field => hasValue(body[field]));

    return {
      method: init.method ?? 'GET',
      endpoint: path.split('?')[0],
      identifierFields,
      revealPersonalEmails: body.reveal_personal_emails === true,
      revealPhoneNumber: body.reveal_phone_number === true,
      waterfallEmail: body.run_waterfall_email === true,
      waterfallPhone: body.run_waterfall_phone === true,
      hasWebhook: hasValue(body.webhook_url),
    };
  }

  if (operation === 'organization_enrich') {
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    return {
      method: init.method ?? 'GET',
      endpoint: path.split('?')[0],
      lookupBy: query.has('domain') ? 'domain' : query.has('name') ? 'name' : 'unknown',
    };
  }

  return {
    method: init.method ?? 'GET',
    endpoint: '/organizations/:id',
    identifierProvided: path.split('/').pop() != null,
  };
}

function summarizeResponse(payload: ApolloApiResponse) {
  const waterfall = payload.waterfall && typeof payload.waterfall === 'object'
    ? payload.waterfall as Record<string, unknown>
    : null;
  const people = Array.isArray(payload.people)
    ? payload.people
    : Array.isArray(payload.contacts)
      ? payload.contacts
      : null;
  const providerRequestId = payload.request_id ?? payload.requestId;

  return {
    responseKeys: Object.keys(payload).slice(0, 20),
    peopleReturned: people?.length,
    hasPerson: Boolean(payload.person),
    hasOrganization: Boolean(payload.organization),
    hasPagination: Boolean(payload.pagination),
    waterfallStatus: typeof waterfall?.status === 'string' ? waterfall.status : undefined,
    providerRequestId: typeof providerRequestId === 'string' || typeof providerRequestId === 'number'
      ? String(providerRequestId).slice(0, 100)
      : undefined,
  };
}

async function requestApollo(
  operation: ApolloOperation,
  path: string,
  init: RequestInit = {},
  context: ApolloRequestContext = {},
): Promise<ApolloApiResponse> {
  const callId = randomUUID();
  const startedAt = Date.now();
  const requestSummary = summarizeRequest(operation, path, init);
  const logContext = compactContext(context);

  console.log(`[apollo] ${operation} start`, {
    callId,
    ...logContext,
    ...requestSummary,
  });

  if (!env.APOLLO_API_KEY) {
    console.error(`[apollo] ${operation} skipped`, {
      callId,
      ...logContext,
      durationMs: Date.now() - startedAt,
      reason: 'not_configured',
    });
    throw new AppError(503, 'Apollo API is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APOLLO_TIMEOUT_MS);
  let httpStatus: number | undefined;
  let providerRequestId: string | undefined;

  try {
    const response = await fetch(`${APOLLO_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': env.APOLLO_API_KEY,
        ...init.headers,
      },
    });

    const text = await response.text();
    let payload: ApolloApiResponse = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text.slice(0, 1000) };
    }

    const responseSummary = summarizeResponse(payload);
    providerRequestId = responseSummary.providerRequestId;
    httpStatus = response.status;

    if (!response.ok) {
      throw new AppError(
        response.status === 429 ? 429 : 502,
        `Apollo request failed (${response.status})`,
        payload,
      );
    }

    console.log(`[apollo] ${operation} success`, {
      callId,
      ...logContext,
      durationMs: Date.now() - startedAt,
      httpStatus,
      ...responseSummary,
    });

    return payload;
  } catch (error: unknown) {
    const normalizedError = error instanceof AppError
      ? error
      : error instanceof Error && error.name === 'AbortError'
        ? new AppError(504, 'Apollo request timed out')
        : new AppError(
          502,
          `Apollo request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          error,
        );

    console.error(`[apollo] ${operation} failed`, {
      callId,
      ...logContext,
      durationMs: Date.now() - startedAt,
      httpStatus,
      errorStatus: normalizedError.status,
      providerRequestId,
      message: normalizedError.message,
    });

    throw normalizedError;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchApolloPeople(
  body: Record<string, unknown>,
  context: ApolloRequestContext = {},
) {
  return requestApollo('people_search', '/mixed_people/api_search', {
    method: 'POST',
    body: JSON.stringify(body),
  }, context);
}

export async function matchApolloPerson(
  body: Record<string, unknown>,
  context: ApolloRequestContext = {},
) {
  return requestApollo('person_match', '/people/match', {
    method: 'POST',
    body: JSON.stringify(body),
  }, context);
}

export async function enrichApolloOrganization(
  params: Record<string, string>,
  context: ApolloRequestContext = {},
) {
  const query = new URLSearchParams(params).toString();
  return requestApollo('organization_enrich', `/organizations/enrich?${query}`, { method: 'GET' }, context);
}

export async function getApolloOrganization(
  organizationId: string,
  context: ApolloRequestContext = {},
) {
  return requestApollo(
    'organization_info',
    `/organizations/${encodeURIComponent(organizationId)}`,
    { method: 'GET' },
    context,
  );
}
