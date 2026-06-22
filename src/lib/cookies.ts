import { Response, CookieOptions } from 'express';
import { env } from '../config/env';

interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    signed: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
  };
}

export function setAuthCookies(res: Response, session: Session) {
  res.cookie('access_token', session.access_token, {
    ...baseCookieOptions(),
    maxAge: session.expires_in * 1000,
  });
  res.cookie('refresh_token', session.refresh_token, {
    ...baseCookieOptions(),
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });
}

export function clearAuthCookies(res: Response) {
  const options = baseCookieOptions();
  res.clearCookie('access_token', options);
  res.clearCookie('refresh_token', options);
}
