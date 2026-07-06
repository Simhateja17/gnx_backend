import { Response, CookieOptions } from 'express';
import { env } from '../config/env';

interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function baseCookieOptions(): CookieOptions {
  // The frontend (Vercel) and backend (GCP VM) live on completely different
  // domains in production, making every API call cross-site. Browsers refuse
  // to send SameSite=Lax cookies on cross-site requests, so the auth cookie
  // was being set correctly but never sent back on the very next request -
  // every login (Google or plain email/password) would silently bounce back
  // to /login. SameSite=None requires Secure, which is already tied to
  // production here, so the pairing is safe. Locally, frontend/backend both
  // run on localhost (different ports only), which browsers treat as
  // same-site, so 'lax' still works fine there.
  const isProduction = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    signed: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
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
