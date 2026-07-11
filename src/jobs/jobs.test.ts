import { describe, it, expect, vi } from 'vitest';

const { addCalls } = vi.hoisted(() => {
  return { addCalls: {} as Record<string, Array<{ name: string; data: unknown; options: any }>> };
});

vi.mock('bullmq', () => {
  class MockQueue {
    queueName: string;
    constructor(queueName: string) {
      this.queueName = queueName;
      addCalls[queueName] = [];
    }
    async add(name: string, data: unknown, options: any) {
      addCalls[this.queueName].push({ name, data, options });
      return { id: 'mock-job-id' };
    }
  }
  return { Queue: MockQueue };
});

vi.mock('../lib/redis', () => ({ redisConnection: {}, queueConnection: {} }));

import { enqueueSendEmail } from './send-email.job';
import { enqueuePollInbox } from './poll-inbox.job';
import { enqueueScheduleCall } from './schedule-call.job';
import { enqueueEnrichLeads } from './enrich-leads.job';
import { enqueueCsvImport } from './csv-import.job';

describe('BullMQ job retry/backoff configuration', () => {
  it('send-email queues with 3 attempts, exponential backoff 5000ms', async () => {
    await enqueueSendEmail({ emailMessageId: 'e1', organizationId: 'o1' });
    const call = addCalls['send-email'].at(-1)!;
    expect(call.options.attempts).toBe(3);
    expect(call.options.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('poll-inbox queues with 3 attempts, exponential backoff 10000ms', async () => {
    await enqueuePollInbox({ organizationId: 'o1', connectedAccountId: 'c1' });
    const call = addCalls['poll-inbox'].at(-1)!;
    expect(call.options.attempts).toBe(3);
    expect(call.options.backoff).toEqual({ type: 'exponential', delay: 10000 });
  });

  it('schedule-call queues with 2 attempts, fixed backoff 15000ms', async () => {
    await enqueueScheduleCall({ leadId: 'l1', campaignId: 'c1', organizationId: 'o1', toNumber: '+15551234567', fromNumber: '+15557654321' });
    const call = addCalls['schedule-call'].at(-1)!;
    expect(call.options.attempts).toBe(2);
    expect(call.options.backoff).toEqual({ type: 'fixed', delay: 15000 });
  });

  it('enrich-leads queues with 3 attempts, exponential backoff 8000ms', async () => {
    await enqueueEnrichLeads({ leadIds: ['l1'], campaignId: 'c1', organizationId: 'o1' });
    const call = addCalls['enrich-leads'].at(-1)!;
    expect(call.options.attempts).toBe(3);
    expect(call.options.backoff).toEqual({ type: 'exponential', delay: 8000 });
  });

  it('csv-import queues with 2 attempts, exponential backoff 5000ms', async () => {
    await enqueueCsvImport({ organizationId: 'o1', fileName: 'f.csv', columnMapping: {}, rows: [], totalRows: 0 });
    const call = addCalls['csv-import'].at(-1)!;
    expect(call.options.attempts).toBe(2);
    expect(call.options.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });
});
