import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/apollo', () => ({ enrichApolloOrganization: vi.fn(), getApolloOrganization: vi.fn() }));
vi.mock('../config/env', () => ({
  env: {
    APOLLO_REVEAL_PERSONAL_EMAILS: false,
    APOLLO_REVEAL_PHONE_NUMBER: false,
    APOLLO_RUN_WATERFALL_EMAIL: false,
    APOLLO_RUN_WATERFALL_PHONE: false,
    APOLLO_ENRICHMENT_WEBHOOK_URL: '',
    APOLLO_ENRICHMENT_WEBHOOK_SECRET: '',
  },
}));

import {
  buildApolloLeadPatch,
  buildApolloPersonMatchRequest,
  mapApolloOrganization,
  mapApolloPerson,
  normalizeApolloDomain,
} from './apollo-data.service';

describe('Apollo data mapping', () => {
  it('normalizes company domains for account deduplication', () => {
    expect(normalizeApolloDomain('https://www.Example.com/path')).toBe('example.com');
    expect(normalizeApolloDomain('example.com')).toBe('example.com');
  });

  it('maps rich person and organization fields without flattening away the payload', () => {
    const person = {
      id: 'person-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      title: 'VP Sales',
      departments: ['sales'],
      functions: ['business_development'],
      seniority: 'vp',
      contact: {
        email: 'ada@example.com',
        phone_numbers: [{ sanitized_number: '+12025550123', type_cd: 'mobile' }],
      },
      organization: {
        id: 'org-1',
        account_id: 'account-1',
        name: 'Example Co',
        website_url: 'https://www.example.com',
        industry: 'Software',
        estimated_num_employees: 120,
        technology_names: ['Salesforce'],
      },
    };

    const mappedPerson = mapApolloPerson(person);
    const mappedOrganization = mapApolloOrganization(person.organization);

    expect(mappedPerson).toMatchObject({
      apolloId: 'person-1',
      email: 'ada@example.com',
      phone: '+12025550123',
      department: 'sales',
      jobFunction: 'business_development',
    });
    expect(mappedOrganization).toMatchObject({
      apolloOrganizationId: 'org-1',
      apolloAccountId: 'account-1',
      normalizedDomain: 'example.com',
      estimatedNumEmployees: 120,
    });
  });

  it('preserves explicit manual lead overrides while updating Apollo fields', () => {
    const patch = buildApolloLeadPatch(
      {
        id: 'person-1',
        first_name: 'Ada',
        title: 'VP Sales',
        email: 'apollo@example.com',
        phone_numbers: [{ sanitized_number: '+12025550123' }],
      },
      {
        title: 'Manually chosen title',
        manual_field_overrides: { title: true },
      },
    );

    expect(patch.title).toBeUndefined();
    expect(patch.email).toBe('apollo@example.com');
    expect(patch.phone).toBe('+12025550123');
    expect(patch.last_apollo_enriched_at).toBeTypeOf('string');
  });

  it('sends only paid reveal options that are explicitly enabled', () => {
    expect(buildApolloPersonMatchRequest({ email: 'ada@example.com' })).toEqual({
      email: 'ada@example.com',
    });
  });
});

