import { describe, it, expect } from 'vitest';
import { updateSettingsSchema } from './settings.schema';

describe('updateSettingsSchema', () => {
  it('accepts all valid fields', () => {
    const result = updateSettingsSchema.safeParse({
      firstName: 'Manasa',
      lastName: 'Test',
      orgName: 'Acme',
      orgWebsite: 'https://acme.com',
      tone: 'friendly',
      autoApproveReplies: true,
      dailyEmailSendCap: 50,
      bookingLink: 'https://calendly.com/test/15min',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = updateSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts partial updates', () => {
    const result = updateSettingsSchema.safeParse({ tone: 'direct' });
    expect(result.success).toBe(true);
    expect(result.data?.tone).toBe('direct');
  });

  it('rejects invalid tone', () => {
    const result = updateSettingsSchema.safeParse({ tone: 'aggressive' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid tones', () => {
    for (const tone of ['consultative', 'direct', 'friendly', 'formal', 'challenger']) {
      const result = updateSettingsSchema.safeParse({ tone });
      expect(result.success).toBe(true);
    }
  });

  it('rejects dailyEmailSendCap below 1', () => {
    const result = updateSettingsSchema.safeParse({ dailyEmailSendCap: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects dailyEmailSendCap above 500', () => {
    const result = updateSettingsSchema.safeParse({ dailyEmailSendCap: 501 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer dailyEmailSendCap', () => {
    const result = updateSettingsSchema.safeParse({ dailyEmailSendCap: 10.5 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid orgWebsite URL', () => {
    const result = updateSettingsSchema.safeParse({ orgWebsite: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts empty string for orgWebsite', () => {
    const result = updateSettingsSchema.safeParse({ orgWebsite: '' });
    expect(result.success).toBe(true);
  });

  it('rejects empty firstName', () => {
    const result = updateSettingsSchema.safeParse({ firstName: '' });
    expect(result.success).toBe(false);
  });

  it('accepts valid bookingLink URL', () => {
    const result = updateSettingsSchema.safeParse({ bookingLink: 'https://calendly.com/test' });
    expect(result.success).toBe(true);
  });

  it('accepts empty string for bookingLink', () => {
    const result = updateSettingsSchema.safeParse({ bookingLink: '' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid bookingLink URL', () => {
    const result = updateSettingsSchema.safeParse({ bookingLink: 'not-a-url' });
    expect(result.success).toBe(false);
  });
});
