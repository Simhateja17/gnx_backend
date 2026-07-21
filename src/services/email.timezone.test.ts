import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { startOfDayUtcForTimezone } from './email.service';

describe('startOfDayUtcForTimezone', () => {
  it('computes EST midnight (UTC-5) correctly', () => {
    // 2024-01-15T12:00:00Z is 07:00 local in America/New_York (EST, UTC-5).
    const reference = new Date('2024-01-15T12:00:00Z');
    const result = startOfDayUtcForTimezone('America/New_York', reference);
    // Local midnight Jan 15 EST = 05:00 UTC Jan 15.
    expect(result.toISOString()).toBe('2024-01-15T05:00:00.000Z');
  });

  it('computes EDT midnight (UTC-4) correctly across the DST boundary', () => {
    // 2024-07-15T12:00:00Z is 08:00 local in America/New_York (EDT, UTC-4).
    const reference = new Date('2024-07-15T12:00:00Z');
    const result = startOfDayUtcForTimezone('America/New_York', reference);
    // Local midnight Jul 15 EDT = 04:00 UTC Jul 15.
    expect(result.toISOString()).toBe('2024-07-15T04:00:00.000Z');
  });

  it('computes UTC midnight correctly for a UTC timezone', () => {
    const reference = new Date('2024-03-10T18:30:00Z');
    const result = startOfDayUtcForTimezone('UTC', reference);
    expect(result.toISOString()).toBe('2024-03-10T00:00:00.000Z');
  });

  it('rolls over to the previous UTC day for a timezone ahead of UTC', () => {
    // Asia/Kolkata is UTC+5:30. 2024-01-15T18:00:00Z is 2024-01-15T23:30 local,
    // still Jan 15 local — but 2024-01-15T20:00:00Z is 2024-01-16T01:30 local,
    // so local midnight for that reference is Jan 16 00:00 local = Jan 15
    // 18:30 UTC.
    const reference = new Date('2024-01-15T20:00:00Z');
    const result = startOfDayUtcForTimezone('Asia/Kolkata', reference);
    expect(result.toISOString()).toBe('2024-01-15T18:30:00.000Z');
  });
});
