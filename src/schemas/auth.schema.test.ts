import { describe, it, expect } from 'vitest';
import { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from './auth.schema';

describe('signupSchema', () => {
  const valid = {
    firstName: 'Manasa',
    lastName: 'Test',
    email: 'test@example.com',
    company: 'Acme Inc',
    password: 'Str0ng!Pass',
  };

  it('accepts valid input', () => {
    expect(signupSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects missing firstName', () => {
    const { success } = signupSchema.safeParse({ ...valid, firstName: undefined });
    expect(success).toBe(false);
  });

  it('rejects invalid email', () => {
    const { success } = signupSchema.safeParse({ ...valid, email: 'not-an-email' });
    expect(success).toBe(false);
  });

  it('rejects short password', () => {
    const { success } = signupSchema.safeParse({ ...valid, password: 'Ab1!' });
    expect(success).toBe(false);
  });

  it('rejects password without number', () => {
    const { success } = signupSchema.safeParse({ ...valid, password: 'Abcdefgh!' });
    expect(success).toBe(false);
  });

  it('rejects password without symbol', () => {
    const { success } = signupSchema.safeParse({ ...valid, password: 'Abcdefgh1' });
    expect(success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('accepts valid input', () => {
    const result = loginSchema.safeParse({ email: 'user@test.com', password: 'pass' });
    expect(result.success).toBe(true);
  });

  it('rejects missing email', () => {
    const result = loginSchema.safeParse({ password: 'pass' });
    expect(result.success).toBe(false);
  });

  it('rejects missing password', () => {
    const result = loginSchema.safeParse({ email: 'user@test.com' });
    expect(result.success).toBe(false);
  });
});

describe('forgotPasswordSchema', () => {
  it('accepts valid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'user@test.com' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'invalid' });
    expect(result.success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  it('accepts valid input', () => {
    const result = resetPasswordSchema.safeParse({
      accessToken: 'some-token',
      newPassword: 'NewP@ss1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects weak newPassword', () => {
    const result = resetPasswordSchema.safeParse({
      accessToken: 'some-token',
      newPassword: 'weak',
    });
    expect(result.success).toBe(false);
  });
});
