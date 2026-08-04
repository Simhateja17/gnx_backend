import { env } from '../config/env';
import { AppError } from '../types';

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const APOLLO_TIMEOUT_MS = 20_000;

export type ApolloApiResponse = Record<string, any>;

async function requestApollo(path: string, init: RequestInit = {}): Promise<ApolloApiResponse> {
  if (!env.APOLLO_API_KEY) throw new AppError(503, 'Apollo API is not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APOLLO_TIMEOUT_MS);
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

    if (!response.ok) {
      throw new AppError(
        response.status === 429 ? 429 : 502,
        `Apollo request failed (${response.status})`,
        payload,
      );
    }

    return payload;
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    if (error?.name === 'AbortError') throw new AppError(504, 'Apollo request timed out');
    throw new AppError(502, `Apollo request failed: ${error?.message ?? 'unknown error'}`, error);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchApolloPeople(body: Record<string, unknown>) {
  return requestApollo('/mixed_people/api_search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function matchApolloPerson(body: Record<string, unknown>) {
  return requestApollo('/people/match', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function enrichApolloOrganization(params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return requestApollo(`/organizations/enrich?${query}`, { method: 'GET' });
}

export async function getApolloOrganization(organizationId: string) {
  return requestApollo(`/organizations/${encodeURIComponent(organizationId)}`, { method: 'GET' });
}
