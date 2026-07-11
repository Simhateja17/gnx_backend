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

export type TokenRefreshHandler = (tokens: { access_token: string; expiry_date: number | null }) => void;

export function getAuthedClient(accessToken: string, refreshToken: string, onTokenRefresh?: TokenRefreshHandler) {
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  // The googleapis client auto-refreshes an expired access token in memory
  // on the next call, but never persists the new token anywhere — every
  // subsequent send/poll silently re-does the refresh round trip instead of
  // reusing what's already valid. Callers can pass a handler to cache it.
  if (onTokenRefresh) {
    client.on('tokens', (tokens) => {
      if (tokens.access_token) {
        onTokenRefresh({ access_token: tokens.access_token, expiry_date: tokens.expiry_date ?? null });
      }
    });
  }
  return client;
}

export async function sendGmailMessage(
  accessToken: string,
  refreshToken: string,
  from: string,
  to: string,
  subject: string,
  body: string,
  options: { threadId?: string | null; onTokenRefresh?: TokenRefreshHandler } = {},
) {
  const client = getAuthedClient(accessToken, refreshToken, options.onTokenRefresh);
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
    requestBody: {
      raw,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    },
  });

  return {
    messageId: result.data.id ?? null,
    threadId: result.data.threadId ?? null,
  };
}
