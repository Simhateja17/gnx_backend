import { google } from 'googleapis';
import { env } from '../config/env';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function createCalendarOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_CALENDAR_REDIRECT_URI,
  );
}

export function getCalendarAuthUrl(state?: string) {
  const client = createCalendarOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    ...(state ? { state } : {}),
    scope: GOOGLE_CALENDAR_SCOPES,
  });
}

export async function exchangeCalendarCode(code: string) {
  const client = createCalendarOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export type CalendarTokenRefreshHandler = (tokens: {
  access_token: string;
  expiry_date: number | null;
}) => void;

export function getCalendarClient(
  accessToken: string,
  refreshToken: string,
  onTokenRefresh?: CalendarTokenRefreshHandler,
) {
  const client = createCalendarOAuth2Client();
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  if (onTokenRefresh) {
    client.on('tokens', (tokens) => {
      if (tokens.access_token) {
        onTokenRefresh({
          access_token: tokens.access_token,
          expiry_date: tokens.expiry_date ?? null,
        });
      }
    });
  }
  return client;
}

export function getCalendarApi(
  accessToken: string,
  refreshToken: string,
  onTokenRefresh?: CalendarTokenRefreshHandler,
) {
  return google.calendar({
    version: 'v3',
    auth: getCalendarClient(accessToken, refreshToken, onTokenRefresh),
  });
}
