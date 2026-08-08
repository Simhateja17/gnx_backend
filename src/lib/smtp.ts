import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { SmtpConnectionInput } from '../schemas/smtp.schema';

export type SmtpTransportConfig = Pick<
  SmtpConnectionInput,
  'smtpHost' | 'smtpPort' | 'smtpSecure' | 'smtpUsername' | 'smtpPassword'
>;

export type ImapTransportConfig = Pick<
  SmtpConnectionInput,
  'imapHost' | 'imapPort' | 'imapSecure' | 'imapUsername' | 'imapPassword'
>;

export type SmtpMessageInput = {
  from: string;
  displayName?: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
};

export type SmtpMessageResult = {
  messageId: string;
};

function createSmtpTransport(config: SmtpTransportConfig) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUsername,
      pass: config.smtpPassword,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function createImapClient(config: ImapTransportConfig) {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.imapUsername,
      pass: config.imapPassword,
    },
    socketTimeout: 30_000,
    logger: false,
  });
}

export async function verifySmtp(config: SmtpTransportConfig): Promise<void> {
  const transport = createSmtpTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendSmtpMessage(
  config: SmtpTransportConfig,
  input: SmtpMessageInput,
): Promise<SmtpMessageResult> {
  const transport = createSmtpTransport(config);
  try {
    const result = await transport.sendMail({
      from: input.displayName ? { name: input.displayName, address: input.from } : input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.inReplyTo
        ? { inReplyTo: input.inReplyTo, references: [input.inReplyTo] }
        : {}),
    });

    return { messageId: result.messageId };
  } finally {
    transport.close();
  }
}

export type ImapMessage = {
  uid: number;
  internalDate: Date | null;
  source: Buffer;
};

export async function fetchImapMessages(
  config: ImapTransportConfig,
  search: { uid?: string; since?: Date },
): Promise<ImapMessage[]> {
  const client = createImapClient(config);
  await client.connect();

  let lock;
  try {
    lock = await client.getMailboxLock('INBOX');
    const uids = await client.search(search, { uid: true });
    if (!uids || uids.length === 0) return [];

    const messages = await client.fetchAll(uids, {
      uid: true,
      source: true,
      internalDate: true,
    }, { uid: true });

    return messages
      .filter(message => message.uid && message.source)
      .map(message => ({
        uid: message.uid!,
        internalDate: message.internalDate
          ? (message.internalDate instanceof Date
            ? message.internalDate
            : new Date(message.internalDate))
          : null,
        source: Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source as any),
      }));
  } finally {
    lock?.release();
    await client.logout().catch(() => undefined);
  }
}

export async function verifyImap(config: ImapTransportConfig): Promise<void> {
  const client = createImapClient(config);
  await client.connect();
  let lock;
  try {
    lock = await client.getMailboxLock('INBOX');
  } finally {
    lock?.release();
    await client.logout().catch(() => undefined);
  }
}

export async function parseIncomingMessage(source: Buffer) {
  return simpleParser(source);
}
