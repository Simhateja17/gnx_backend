import { z } from 'zod';

const host = z.string().trim().min(1, 'Host is required').max(255, 'Host is too long');
const port = z.coerce.number().int().min(1, 'Port must be between 1 and 65535').max(65535, 'Port must be between 1 and 65535');
const username = z.string().trim().min(1, 'Username is required').max(254, 'Username is too long');
const password = z.string().min(1, 'Password is required').max(2048, 'Password is too long');

export const smtpConnectionSchema = z.object({
  email: z.string().trim().email('Enter a valid sending email address'),
  displayName: z.string().trim().max(160, 'Display name is too long').optional().default(''),
  smtpHost: host,
  smtpPort: port,
  smtpSecure: z.boolean().default(true),
  smtpUsername: username,
  smtpPassword: password,
  imapHost: host,
  imapPort: port,
  imapSecure: z.boolean().default(true),
  imapUsername: username,
  imapPassword: password,
});

export type SmtpConnectionInput = z.infer<typeof smtpConnectionSchema>;
