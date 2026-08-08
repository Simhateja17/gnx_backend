import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env';

const VERSION = 'v1';

function encryptionKey(): Buffer {
  const raw = env.CREDENTIAL_ENCRYPTION_KEY.trim();
  if (!raw) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is required for custom email connections');
  }

  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');

  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex or base64 value');
  }

  return key;
}

/** Encrypt a customer-owned secret before it is written to Supabase. */
export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Decrypt a stored customer-owned secret. Plaintext is never returned to API callers. */
export function decryptSecret(value: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split(':');
  if (version !== VERSION || !ivText || !tagText || !ciphertextText) {
    throw new Error('Unsupported encrypted credential format');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivText, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
