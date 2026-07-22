import 'dotenv/config';
import { Worker } from 'bullmq';
import * as Sentry from '@sentry/node';
import { env } from '../config/env';
import { redisConnection } from '../lib/redis';
import { supabase } from '../lib/supabase';
import { enqueueRecurringPollInbox } from '../jobs/poll-inbox.job';
import { enqueueScheduleCall } from '../jobs/schedule-call.job';
import { enqueueRecurringBillingRenewalCheck } from '../jobs/billing-renewal-check.job';
import { sendEmail, checkSendCap } from '../services/email.service';
import { pollInbox } from '../services/gmail.service';
import { scheduleCall } from '../services/voice.service';
import { enrichLeads } from '../services/leads.service';
import { processCsvImportJob } from '../services/leads.service';
import { runRenewalCheck } from '../services/billing.service';
import type { SendEmailJobData } from '../jobs/send-email.job';
import type { PollInboxJobData } from '../jobs/poll-inbox.job';
import type { ScheduleCallJobData } from '../jobs/schedule-call.job';
import type { EnrichLeadsJobData } from '../jobs/enrich-leads.job';
import type { CsvImportJobData } from '../jobs/csv-import.job';

Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
});

const sendEmailWorker = new Worker<SendEmailJobData>('send-email', async (job) => {
  console.log(`[send-email] Processing job ${job.id}`);
  const { emailMessageId, organizationId } = job.data;

  const cap = await checkSendCap(organizationId);
  if (cap.paused) {
    console.log(`[send-email] Daily cap reached (${cap.sentToday}/${cap.cap}), re-queuing job ${job.id} with delay`);
    throw new Error(`DAILY_CAP_REACHED: ${cap.sentToday}/${cap.cap} emails sent today`);
  }

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

function msUntilNextWindow(start: string, end: string, timezone: string): number {
  const now = new Date();
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const dayOfWeek = tzNow.getDay(); // 0=Sun, 6=Sat
  const currentMinutes = tzNow.getHours() * 60 + tzNow.getMinutes();

  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isInHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;

  if (isWeekday && isInHours) return 0;

  let minutesUntilStart: number;

  if (isWeekday && currentMinutes < startMinutes) {
    minutesUntilStart = startMinutes - currentMinutes;
  } else {
    let daysAhead: number;
    if (dayOfWeek === 6) daysAhead = 2;       // Sat → Mon
    else if (dayOfWeek === 0) daysAhead = 1;  // Sun → Mon
    else if (dayOfWeek === 5) daysAhead = 3;  // Fri after hours → Mon
    else daysAhead = 1;                        // Weekday after hours → next day

    const minutesToMidnight = 24 * 60 - currentMinutes;
    minutesUntilStart = minutesToMidnight + (daysAhead - 1) * 24 * 60 + startMinutes;
  }

  return minutesUntilStart * 60 * 1000;
}

const scheduleCallWorker = new Worker<ScheduleCallJobData>('schedule-call', async (job) => {
  console.log(`[schedule-call] Processing job ${job.id}`);
  const { organizationId, campaignId, leadId, fromNumber, toNumber } = job.data;

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('business_hours_start, business_hours_end, timezone')
    .eq('id', campaignId)
    .single();

  if (campaign) {
    const delay = msUntilNextWindow(
      campaign.business_hours_start,
      campaign.business_hours_end,
      campaign.timezone,
    );
    if (delay > 0) {
      console.log(`[schedule-call] Outside business hours, re-queuing job ${job.id} in ${Math.round(delay / 60_000)} min`);
      await enqueueScheduleCall({ organizationId, campaignId, leadId, fromNumber, toNumber }, delay);
      return { requeued: true, delayMs: delay };
    }
  }

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

const csvImportWorker = new Worker<CsvImportJobData>('csv-import', async (job) => {
  console.log(`[csv-import] Processing job ${job.id}: ${job.data.fileName} (${job.data.totalRows} rows)`);
  const result = await processCsvImportJob(job.id!, job.data);
  console.log(`[csv-import] Job ${job.id} completed: ${result.inserted} inserted, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}, {
  connection: redisConnection,
  concurrency: 2,
});

const billingRenewalCheckWorker = new Worker('billing-renewal-check', async (job) => {
  console.log(`[billing-renewal-check] Processing job ${job.id}`);
  await runRenewalCheck();
  console.log(`[billing-renewal-check] Job ${job.id} completed`);
}, {
  connection: redisConnection,
  concurrency: 1,
});

function reportJobFailure(queue: string, job: { id?: string; attemptsMade?: number } | undefined, err: Error) {
  console.error(`[${queue}] Job ${job?.id} failed:`, err.message);
  Sentry.captureException(err, {
    extra: { queue, jobId: job?.id, attemptsMade: job?.attemptsMade },
  });
}

sendEmailWorker.on('failed', (job, err) => reportJobFailure('send-email', job, err));
pollInboxWorker.on('failed', (job, err) => reportJobFailure('poll-inbox', job, err));
scheduleCallWorker.on('failed', (job, err) => reportJobFailure('schedule-call', job, err));
enrichLeadsWorker.on('failed', (job, err) => reportJobFailure('enrich-leads', job, err));
csvImportWorker.on('failed', (job, err) => reportJobFailure('csv-import', job, err));
billingRenewalCheckWorker.on('failed', (job, err) => reportJobFailure('billing-renewal-check', job, err));

// Workers are EventEmitters too — an unhandled 'error' (e.g. Redis dropping
// the connection) would otherwise crash the whole workers process.
function reportConnectionError(queue: string, err: Error) {
  console.warn(`[${queue}] connection error:`, err.message);
}

sendEmailWorker.on('error', (err) => reportConnectionError('send-email', err));
pollInboxWorker.on('error', (err) => reportConnectionError('poll-inbox', err));
scheduleCallWorker.on('error', (err) => reportConnectionError('schedule-call', err));
enrichLeadsWorker.on('error', (err) => reportConnectionError('enrich-leads', err));
csvImportWorker.on('error', (err) => reportConnectionError('csv-import', err));
billingRenewalCheckWorker.on('error', (err) => reportConnectionError('billing-renewal-check', err));

console.log('Workers started: send-email, poll-inbox, schedule-call, enrich-leads, csv-import, billing-renewal-check');

void enqueueRecurringBillingRenewalCheck();

async function scheduleRecurringInboxPolls() {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id,organization_id')
    .eq('provider', 'gmail');

  if (error) {
    console.error('[poll-inbox] Failed to schedule recurring poll jobs:', error.message);
    return;
  }

  for (const account of data ?? []) {
    await enqueueRecurringPollInbox({
      organizationId: account.organization_id,
      connectedAccountId: account.id,
    });
  }

  console.log(`[poll-inbox] Scheduled recurring poll jobs for ${data?.length ?? 0} Gmail accounts`);
}

void scheduleRecurringInboxPolls();

export { sendEmailWorker, pollInboxWorker, scheduleCallWorker, enrichLeadsWorker, csvImportWorker, billingRenewalCheckWorker };
