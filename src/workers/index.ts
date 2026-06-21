import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../lib/redis';
import { sendEmail } from '../services/email.service';
import { pollInbox } from '../services/gmail.service';
import { scheduleCall } from '../services/voice.service';
import { enrichLeads } from '../services/inbox.service';
import type { SendEmailJobData } from '../jobs/send-email.job';
import type { PollInboxJobData } from '../jobs/poll-inbox.job';
import type { ScheduleCallJobData } from '../jobs/schedule-call.job';
import type { EnrichLeadsJobData } from '../jobs/enrich-leads.job';

const sendEmailWorker = new Worker<SendEmailJobData>('send-email', async (job) => {
  console.log(`[send-email] Processing job ${job.id}`);
  const { emailMessageId, organizationId } = job.data;
  const result = await sendEmail(emailMessageId, organizationId);
  console.log(`[send-email] Job ${job.id} completed:`, result);
  return result;
}, {
  connection: redisConnection,
  concurrency: 5,
});

const pollInboxWorker = new Worker<PollInboxJobData>('poll-inbox', async (job) => {
  console.log(`[poll-inbox] Processing job ${job.id}`);
  const { organizationId, connectedAccountId } = job.data;
  const result = await pollInbox(organizationId, connectedAccountId);
  console.log(`[poll-inbox] Job ${job.id} completed: ${result.newReplies} new replies`);
  return result;
}, {
  connection: redisConnection,
  concurrency: 2,
});

const scheduleCallWorker = new Worker<ScheduleCallJobData>('schedule-call', async (job) => {
  console.log(`[schedule-call] Processing job ${job.id}`);
  const { organizationId, campaignId, leadId, fromNumber, toNumber } = job.data;
  const result = await scheduleCall(organizationId, campaignId, leadId, fromNumber, toNumber);
  console.log(`[schedule-call] Job ${job.id} completed:`, result);
  return result;
}, {
  connection: redisConnection,
  concurrency: 3,
});

const enrichLeadsWorker = new Worker<EnrichLeadsJobData>('enrich-leads', async (job) => {
  console.log(`[enrich-leads] Processing job ${job.id}`);
  const { organizationId, leadIds, campaignId } = job.data;
  const result = await enrichLeads(organizationId, leadIds, campaignId);
  console.log(`[enrich-leads] Job ${job.id} completed: ${result.enriched} leads enriched`);
  return result;
}, {
  connection: redisConnection,
  concurrency: 2,
});

sendEmailWorker.on('failed', (job, err) => console.error(`[send-email] Job ${job?.id} failed:`, err.message));
pollInboxWorker.on('failed', (job, err) => console.error(`[poll-inbox] Job ${job?.id} failed:`, err.message));
scheduleCallWorker.on('failed', (job, err) => console.error(`[schedule-call] Job ${job?.id} failed:`, err.message));
enrichLeadsWorker.on('failed', (job, err) => console.error(`[enrich-leads] Job ${job?.id} failed:`, err.message));

console.log('Workers started: send-email, poll-inbox, schedule-call, enrich-leads');

export { sendEmailWorker, pollInboxWorker, scheduleCallWorker, enrichLeadsWorker };
