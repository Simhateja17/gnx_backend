import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app';

// /auth/logout with no cookie is a no-op (auth.service.logout returns
// immediately when there's no accessToken) so it's the cheapest endpoint
// behind authRateLimiter to burst against — no real Supabase calls happen.
describe('authRateLimiter', () => {
  it('allows the first 20 requests in the window and 429s the 21st', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await request(app).post('/api/auth/logout');
      responses.push(res.status);
    }

    expect(responses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(responses[20]).toBe(429);
  });

  it('returns the configured error body and standard rate-limit headers on the 429', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too many auth attempts, please try again later.' });
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});
