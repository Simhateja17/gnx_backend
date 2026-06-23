import { google } from 'googleapis';
import { env } from '../config/env';

export function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthUrl() {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

export async function exchangeCode(code: string) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export function getAuthedClient(accessToken: string, refreshToken: string) {
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return client;
}

export async function sendGmailMessage(
  accessToken: string,
  refreshToken: string,
  from: string,
  to: string,
  subject: string,
  body: string,
) {
  const client = getAuthedClient(accessToken, refreshToken);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  const raw = Buffer.from(messageParts.join('\r\n')).toString('base64url');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    messageId: result.data.id ?? null,
    threadId: result.data.threadId ?? null,
  };
}
