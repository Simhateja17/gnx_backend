import { describe, it, expect } from 'vitest';
import { generateEmailSchema, generateReplySchema, generateVoicePromptSchema } from './ai.schema';

describe('generateEmailSchema', () => {
  it('accepts valid input', () => {
    const result = generateEmailSchema.safeParse({
      campaignId: '44444444-4444-4444-4444-444444444444',
      leadId: '66666666-6666-6666-6666-666666666666',
      stepNumber: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID campaignId', () => {
    const result = generateEmailSchema.safeParse({
      campaignId: 'not-a-uuid',
      leadId: '66666666-6666-6666-6666-666666666666',
      stepNumber: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID leadId', () => {
    const result = generateEmailSchema.safeParse({
      campaignId: '44444444-4444-4444-4444-444444444444',
      leadId: 'bad',
      stepNumber: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects stepNumber below 1', () => {
    const result = generateEmailSchema.safeParse({
      campaignId: '44444444-4444-4444-4444-444444444444',
      leadId: '66666666-6666-6666-6666-666666666666',
      stepNumber: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects stepNumber above 3', () => {
    const result = generateEmailSchema.safeParse({
      campaignId: '44444444-4444-4444-4444-444444444444',
      leadId: '66666666-6666-6666-6666-666666666666',
      stepNumber: 4,
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid step numbers', () => {
    for (const stepNumber of [1, 2, 3]) {
      const result = generateEmailSchema.safeParse({
        campaignId: '44444444-4444-4444-4444-444444444444',
        leadId: '66666666-6666-6666-6666-666666666666',
        stepNumber,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing fields', () => {
    expect(generateEmailSchema.safeParse({}).success).toBe(false);
    expect(generateEmailSchema.safeParse({ campaignId: '44444444-4444-4444-4444-444444444444' }).success).toBe(false);
  });
});

describe('generateReplySchema', () => {
  it('accepts valid UUID', () => {
    const result = generateReplySchema.safeParse({
      emailReplyId: '88888888-8888-8888-8888-888888888888',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID', () => {
    const result = generateReplySchema.safeParse({ emailReplyId: 'bad' });
    expect(result.success).toBe(false);
  });

  it('rejects missing emailReplyId', () => {
    const result = generateReplySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('generateVoicePromptSchema', () => {
  it('accepts valid UUID', () => {
    const result = generateVoicePromptSchema.safeParse({
      campaignId: '55555555-5555-5555-5555-555555555555',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID', () => {
    const result = generateVoicePromptSchema.safeParse({ campaignId: 'invalid' });
    expect(result.success).toBe(false);
  });
});
