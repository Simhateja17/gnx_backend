import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { getTestUserCookies } from '../test/auth-helpers';

let cookies: string[];

beforeAll(async () => {
  cookies = await getTestUserCookies();
});

// One representative endpoint per route file. For most files this is a
// cheap, side-effect-free GET; for ai.routes.ts (real Azure OpenAI calls)
// and voice.routes.ts (real Retell calls, no GET at all) we don't want the
// "authenticated" half of the check to actually execute the operation, so
// those get special handling below instead of appearing in this table.
const routeChecks: Array<{ file: string; method: 'get' | 'post'; path: string; expectAuthedStatus?: number }> = [
  { file: 'auth.routes.ts',       method: 'get', path: '/api/auth/me',              expectAuthedStatus: 200 },
  { file: 'onboarding.routes.ts', method: 'get', path: '/api/onboarding',           expectAuthedStatus: 200 },
  { file: 'gmail.routes.ts',      method: 'get', path: '/api/gmail/status',         expectAuthedStatus: 200 },
  { file: 'campaigns.routes.ts',  method: 'get', path: '/api/campaigns' },
  { file: 'leads.routes.ts',      method: 'get', path: '/api/leads' },
  { file: 'emails.routes.ts',     method: 'get', path: '/api/emails/send-cap' },
  { file: 'inbox.routes.ts',      method: 'get', path: '/api/inbox' },
  { file: 'calls.routes.ts',      method: 'get', path: '/api/calls' },
  { file: 'billing.routes.ts',    method: 'get', path: '/api/billing/usage',        expectAuthedStatus: 200 },
  { file: 'dashboard.routes.ts',  method: 'get', path: '/api/dashboard' },
  { file: 'analytics.routes.ts',  method: 'get', path: '/api/analytics/campaigns' },
  { file: 'settings.routes.ts',   method: 'get', path: '/api/settings',             expectAuthedStatus: 200 },
  { file: 'support.routes.ts',    method: 'get', path: '/api/support/tickets' },
  { file: 'system.routes.ts',     method: 'get', path: '/api/system/status',        expectAuthedStatus: 200 },
];

describe('every protected route file rejects unauthenticated requests', () => {
  for (const { file, method, path } of routeChecks) {
    it(`${file}: ${method.toUpperCase()} ${path} -> 401 with no session`, async () => {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
    });
  }

  it('voice.routes.ts: POST /api/voice/agents -> 401 with no session', async () => {
    const res = await request(app).post('/api/voice/agents');
    expect(res.status).toBe(401);
  });

  it('ai.routes.ts: POST /api/ai/generate-email -> 401 with no session', async () => {
    const res = await request(app).post('/api/ai/generate-email').send({});
    expect(res.status).toBe(401);
  });
});

describe('every protected route file admits a valid authenticated session', () => {
  for (const { file, method, path, expectAuthedStatus } of routeChecks) {
    it(`${file}: ${method.toUpperCase()} ${path} -> not blocked by auth with a valid session`, async () => {
      const res = await (request(app) as any)[method](path).set('Cookie', cookies);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      if (expectAuthedStatus) expect(res.status).toBe(expectAuthedStatus);
    });
  }

  // ai.routes.ts: don't actually trigger a real Azure OpenAI call. An
  // authenticated request with an invalid body should fail Zod validation
  // (400), which only happens if authenticate() already let it through.
  it('ai.routes.ts: POST /api/ai/generate-email with a valid session reaches validation, not auth, on empty body', async () => {
    const res = await request(app).post('/api/ai/generate-email').set('Cookie', cookies).send({});
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // voice.routes.ts has no side-effect-free endpoint (its only route calls
  // the real Retell API), so it's covered by the 401-without-auth check
  // above only, not exercised authenticated here.
});

describe('admin routes require the admin role, not just a valid session', () => {
  it('GET /api/admin/overview -> 401 with no session', async () => {
    const res = await request(app).get('/api/admin/overview');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/overview -> 403 for an authenticated non-admin user', async () => {
    const res = await request(app).get('/api/admin/overview').set('Cookie', cookies);
    expect(res.status).toBe(403);
  });
});
