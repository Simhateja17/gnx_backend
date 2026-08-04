import { describe, it, expect } from 'vitest';
import { signupStartSchema, signupVerifySchema, loginStartSchema, loginVerifySchema } from './auth.schema';

describe('signupStartSchema', () => {
  const valid = {
    firstName: 'Manasa',
    lastName: 'Test',
    email: 'test@example.com',
    company: 'Acme Inc',
  };

  it('accepts valid input', () => {
    expect(signupStartSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects missing firstName', () => {
    const { success } = signupStartSchema.safeParse({ ...valid, firstName: undefined });
    expect(success).toBe(false);
  });

  it('rejects invalid email', () => {
    const { success } = signupStartSchema.safeParse({ ...valid, email: 'not-an-email' });
    expect(success).toBe(false);
  });

  it('rejects missing company', () => {
    const { success } = signupStartSchema.safeParse({ ...valid, company: undefined });
    expect(success).toBe(false);
  });
});

describe('signupVerifySchema', () => {
  it('accepts a 6-digit code', () => {
    const result = signupVerifySchema.safeParse({ email: 'user@test.com', otp: '123456' });
    expect(result.success).toBe(true);
  });

  it('rejects a non-numeric code', () => {
    const result = signupVerifySchema.safeParse({ email: 'user@test.com', otp: 'abcdef' });
    expect(result.success).toBe(false);
  });

  it('rejects a short code', () => {
    const result = signupVerifySchema.safeParse({ email: 'user@test.com', otp: '123' });
    expect(result.success).toBe(false);
  });
});

describe('loginStartSchema', () => {
  it('accepts valid email', () => {
    const result = loginStartSchema.safeParse({ email: 'user@test.com' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const result = loginStartSchema.safeParse({ email: 'invalid' });
    expect(result.success).toBe(false);
  });
});

describe('loginVerifySchema', () => {
  it('accepts valid input', () => {
    const result = loginVerifySchema.safeParse({ email: 'user@test.com', otp: '654321' });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed code', () => {
    const result = loginVerifySchema.safeParse({ email: 'user@test.com', otp: '12' });
    expect(result.success).toBe(false);
  });
});
