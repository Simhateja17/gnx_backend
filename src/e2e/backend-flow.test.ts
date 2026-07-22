import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Queue } from 'bullmq';
import { app } from '../app';
import { getTestUserCookies } from '../test/auth-helpers';
import { queueConnection } from '../lib/redis';

// End-to-end backend walk of the core PRD flows (5.1-5.3), run against the
// real dev Supabase project using the dedicated test account. Deliberately
// does NOT start workers/index.ts, so no real Gmail send or Retell call
// ever fires — this only proves requests succeed and the right jobs land
// in BullMQ with the right payloads, not that external delivery works.
// Uses example.invalid addresses (RFC 2606 reserved, unroutable) as
// defense in depth even though the test org has no Gmail connected.

let cookies: string[];
let emailCampaignId: string;
let voiceCampaignId: string;
const createdLeadIds: string[] = [];

beforeAll(async () => {
  cookies = await getTestUserCookies();
});

afterAll(async () => {
  const sendEmailQueue = new Queue('send-email', { connection: queueConnection });
  try {
    const jobs = await sendEmailQueue.getJobs(['waiting', 'delayed']);
    await Promise.all(
      jobs.filter(j => j.data?.campaignId === emailCampaignId).map(j => j.remove())
    );
  } finally {
    await sendEmailQueue.close();
  }

  if (emailCampaignId) await request(app).delete(`/api/campaigns/${emailCampaignId}`).set('Cookie', cookies);
  if (voiceCampaignId) await request(app).delete(`/api/campaigns/${voiceCampaignId}`).set('Cookie', cookies);
  for (const leadId of createdLeadIds) {
    await request(app).delete(`/api/leads/${leadId}`).set('Cookie', cookies);
  }
});

describe('E2E: onboarding', () => {
  it('submits onboarding and creates an agent config', async () => {
    const res = await request(app).post('/api/onboarding').set('Cookie', cookies).send({
      firstName: 'E2E',
      lastName: 'Test',
      company: 'Globonexo Test Org',
      role: 'Founder',
      industry: 'B2B SaaS',
      productDescription: 'AI sales agent that automates outbound prospecting end to end.',
      valueProp: 'Books qualified meetings without manual prospecting work.',
      tone: 'consultative',
      icpTitles: ['VP Sales'],
      icpCompanySizes: ['11-50'],
      icpGeos: ['United States'],
      agentName: 'Nexo',
    });
    expect(res.status).toBe(201);
  });

  it('reflects the submitted onboarding data on GET', async () => {
    const res = await request(app).get('/api/onboarding').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.product_description).toContain('AI sales agent');
  });
});

describe('E2E: email campaign — create, add leads, launch', () => {
  it('creates a draft email campaign', async () => {
    const res = await request(app).post('/api/campaigns').set('Cookie', cookies).send({
      name: 'E2E Test Campaign',
      channel: 'email',
      maxLeads: 10,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    emailCampaignId = res.body.id;
  });

  it('uploads CSV leads tied to the campaign', async () => {
    const res = await request(app).post('/api/leads/csv-upload').set('Cookie', cookies).send({
      campaignId: emailCampaignId,
      rows: [
        { firstName: 'Ada', lastName: 'Lovelace', email: 'ada.e2e-test@example.invalid', company: 'Analytical Engines Inc' },
        { firstName: 'Grace', lastName: 'Hopper', email: 'grace.e2e-test@example.invalid', company: 'Compiler Co' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    createdLeadIds.push(...res.body.items.map((l: any) => l.id));
  });

  it('lists the uploaded leads for the org', async () => {
    const res = await request(app).get('/api/leads').set('Cookie', cookies);
    expect(res.status).toBe(200);
    const emails = JSON.stringify(res.body);
    expect(emails).toContain('ada.e2e-test@example.invalid');
  });

  it('launches the campaign and enqueues a send-email job with the correct payload', async () => {
    const res = await request(app).post(`/api/campaigns/${emailCampaignId}/launch`).set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.queued).toBeGreaterThan(0);

    const sendEmailQueue = new Queue('send-email', { connection: queueConnection });
    try {
      const jobs = await sendEmailQueue.getJobs(['waiting', 'delayed']);
      const ourJobs = jobs.filter(j => j.data?.campaignId === emailCampaignId);
      expect(ourJobs.length).toBeGreaterThan(0);
      expect(ourJobs[0].data.leadId).toBeDefined();
      expect(ourJobs[0].data.stepNumber).toBe(1);
    } finally {
      await sendEmailQueue.close();
    }
  });
});

describe('E2E: voice campaign — launch without Retell setup rolls back cleanly', () => {
  it('creates a draft voice campaign', async () => {
    const res = await request(app).post('/api/campaigns').set('Cookie', cookies).send({
      name: 'E2E Voice Campaign',
      channel: 'voice',
      maxLeads: 10,
    });
    expect(res.status).toBe(201);
    voiceCampaignId = res.body.id;
  });

  it('rejects launch with a clean 400 (no Retell phone configured), not a stuck-active campaign', async () => {
    const launchRes = await request(app).post(`/api/campaigns/${voiceCampaignId}/launch`).set('Cookie', cookies);
    expect(launchRes.status).toBe(400);

    // Regression check for today's earlier audit fix: launching a voice
    // campaign used to leave it stuck 'active' with zero calls scheduled
    // when enqueueVoiceCalls threw. It should roll back to 'paused'.
    const getRes = await request(app).get(`/api/campaigns/${voiceCampaignId}`).set('Cookie', cookies);
    expect(getRes.body.status).toBe('paused');
  });
});

describe('E2E: dashboard, analytics, and settings reflect real org state', () => {
  it('dashboard loads without error for an org with real campaigns/leads', async () => {
    const res = await request(app).get('/api/dashboard').set('Cookie', cookies);
    expect(res.status).toBe(200);
  });

  it('campaign analytics includes the new campaign', async () => {
    const res = await request(app).get('/api/analytics/campaigns').set('Cookie', cookies);
    expect(res.status).toBe(200);
    const names = JSON.stringify(res.body);
    expect(names).toContain('E2E Test Campaign');
  });

  it('settings reflects the onboarding-submitted org name', async () => {
    const res = await request(app).get('/api/settings').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe('Globonexo Test Org');
  });
});

describe('E2E: support ticket flow', () => {
  let ticketId: string;

  it('creates a support ticket', async () => {
    const res = await request(app).post('/api/support/tickets').set('Cookie', cookies).send({
      subject: 'E2E test ticket',
      body: 'This is an end-to-end test message, safe to ignore/close.',
    });
    expect(res.status).toBe(201);
    ticketId = res.body.id;
  });

  it('posts a follow-up message on the ticket', async () => {
    const res = await request(app).post(`/api/support/tickets/${ticketId}/messages`).set('Cookie', cookies).send({
      body: 'Follow-up message from the E2E test.',
    });
    expect(res.status).toBe(201);
  });
});

describe('E2E: AI email generation (real Azure OpenAI call)', () => {
  it('generates a real subject + body for a lead', async () => {
    const leadId = createdLeadIds[0];
    const res = await request(app).post('/api/ai/generate-email').set('Cookie', cookies).send({
      campaignId: emailCampaignId,
      leadId,
      stepNumber: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBeTruthy();
    expect(res.body.body).toBeTruthy();
  }, 30_000);
});
