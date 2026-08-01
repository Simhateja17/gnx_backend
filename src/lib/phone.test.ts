import { describe, expect, it } from 'vitest';
import { isE164Phone, normalizePhoneForCalling } from './phone';

describe('normalizePhoneForCalling', () => {
  it.each([
    ['6301658275', '+916301658275'],
    ['06301658275', '+916301658275'],
    ['+91 63016 58275', '+916301658275'],
    ['00916301658275', '+916301658275'],
    ['916301658275', '+916301658275'],
  ])('normalizes Indian phone %s to E.164', (input, expected) => {
    expect(normalizePhoneForCalling(input, 'Asia/Kolkata')).toBe(expected);
  });

  it('preserves an E.164 number without a timezone assumption', () => {
    expect(normalizePhoneForCalling('+14155551234')).toBe('+14155551234');
  });

  it.each(['', '12345', '06301658275', 'not-a-phone'])('rejects ambiguous or invalid phone %s', input => {
    expect(normalizePhoneForCalling(input)).toBeNull();
  });
});

describe('isE164Phone', () => {
  it('accepts valid E.164 and rejects local formats', () => {
    expect(isE164Phone('+916301658275')).toBe(true);
    expect(isE164Phone('06301658275')).toBe(false);
  });
});
