import request from 'supertest';
import { app } from '../app';

const TEST_USER = {
  email: process.env.TEST_USER_EMAIL ?? '',
  password: process.env.TEST_USER_PASSWORD ?? '',
};

// Signs up the dedicated test account on first run, then logs in on every
// subsequent run once it already exists (signup returns 409 for a duplicate
// email). Returns the raw Set-Cookie header array so callers can attach it
// to authenticated requests via .set('Cookie', cookies).
export async function getTestUserCookies(): Promise<string[]> {
  if (!TEST_USER.email || !TEST_USER.password) {
    throw new Error('TEST_USER_EMAIL / TEST_USER_PASSWORD must be set in .env to run auth-middleware tests');
  }

  const signupRes = await request(app).post('/api/auth/signup').send({
    firstName: 'Test',
    lastName: 'Auth',
    email: TEST_USER.email,
    company: 'Globonexo Test Org',
    password: TEST_USER.password,
  });

  if (signupRes.status === 200 || signupRes.status === 201) {
    return signupRes.headers['set-cookie'] as unknown as string[];
  }

  const loginRes = await request(app).post('/api/auth/login').send(TEST_USER);
  if (loginRes.status !== 200) {
    throw new Error(`Failed to sign up or log in test user: signup=${signupRes.status} login=${loginRes.status} ${loginRes.text}`);
  }
  return loginRes.headers['set-cookie'] as unknown as string[];
}
