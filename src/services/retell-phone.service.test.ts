import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/retell', () => ({ retell: {} }));
vi.mock('../config/env', () => ({ env: { RETELL_API_KEY: 'retell_test_key', RETELL_DEFAULT_COUNTRY: 'US' } }));

import { buildIncludedPhonePurchaseRequest } from './retell-phone.service';

describe('Retell included phone entitlement', () => {
  it('purchases a local number for either supported country and never auto-purchases toll-free', () => {
    expect(buildIncludedPhonePurchaseRequest({
      country: 'CA',
      organizationName: 'Northwind',
      agentId: 'agent-1',
    })).toEqual({
      country_code: 'CA',
      toll_free: false,
      inbound_agent_id: 'agent-1',
      outbound_agent_id: 'agent-1',
      nickname: 'Northwind included number',
    });
  });

  it('allows a number to be purchased before an agent is configured', () => {
    expect(buildIncludedPhonePurchaseRequest({
      country: 'US',
      organizationName: 'Northwind',
    })).toMatchObject({
      country_code: 'US',
      toll_free: false,
      inbound_agent_id: null,
      outbound_agent_id: null,
    });
  });
});
