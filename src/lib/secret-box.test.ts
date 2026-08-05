import { describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
}));

vi.mock('../config/env', () => ({ env: envMock }));

import { decryptSecret, encryptSecret } from './secret-box';

describe('secret box', () => {
  it('round-trips customer credentials without storing plaintext', () => {
    const value = 'provider-app-password-with:punctuation';
    const encrypted = encryptSecret(value);

    expect(encrypted).not.toContain(value);
    expect(decryptSecret(encrypted)).toBe(value);
  });

  it('rejects tampered credentials', () => {
    const encrypted = encryptSecret('secret');
    const parts = encrypted.split(':');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;

    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});
