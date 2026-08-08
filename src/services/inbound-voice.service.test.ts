import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/retell', () => ({ retell: {} }));
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../config/env', () => ({ env: {
  BACKEND_PUBLIC_URL: 'https://api.example.com',
  RETELL_API_KEY: 'test-key',
  RETELL_TOOL_SECRET: 'test-secret',
} }));
vi.mock('../jobs/enrich-leads.job', () => ({ enqueueEnrichLeads: vi.fn() }));

import {
  effectiveInboundLimit,
  inboundPlanLimit,
  leadHasDnc,
  localDayStartUtc,
  phoneLast10,
  selectBestPhoneMatch,
} from './inbound-voice.service';

describe('inbound voice policy helpers', () => {
  it('enforces plan ceilings and allows an organization to lower its cap', () => {
    expect(inboundPlanLimit('starter')).toBe(0);
    expect(inboundPlanLimit('growth')).toBe(20);
    expect(inboundPlanLimit('scale')).toBe(60);
    expect(effectiveInboundLimit(20, 8)).toBe(8);
    expect(effectiveInboundLimit(20, 50)).toBe(20);
    expect(effectiveInboundLimit(0, 10)).toBe(0);
  });

  it('normalizes caller numbers without guessing a country code', () => {
    expect(phoneLast10('+1 (415) 555-0123')).toBe('4155550123');
    expect(phoneLast10('555')).toBe('555');
  });

  it('prefers one exact match over weaker last-ten and Apollo blob matches', () => {
    expect(selectBestPhoneMatch([
      { id: 'exact', campaign_id: null, match_rank: 1 },
      { id: 'last-ten', campaign_id: null, match_rank: 2 },
    ])?.id).toBe('exact');
    expect(selectBestPhoneMatch([
      { id: 'duplicate-a', campaign_id: null, match_rank: 1 },
      { id: 'duplicate-b', campaign_id: null, match_rank: 1 },
    ])).toBeNull();
  });

  it('only treats explicit Apollo DNC values as DNC', () => {
    expect(leadHasDnc({ dnc_status: 'do_not_call' })).toBe(true);
    expect(leadHasDnc({ do_not_call: true })).toBe(true);
    expect(leadHasDnc({ dnc_status: 'not_set' })).toBe(false);
  });

  it('computes the daily boundary in the organization timezone', () => {
    const now = new Date('2026-08-08T20:00:00.000Z');
    expect(localDayStartUtc('Asia/Kolkata', now).toISOString()).toBe('2026-08-08T18:30:00.000Z');
    expect(localDayStartUtc('America/New_York', now).toISOString()).toBe('2026-08-08T04:00:00.000Z');
  });
});
