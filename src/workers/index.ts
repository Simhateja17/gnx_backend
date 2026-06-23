import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../lib/redis';
import { supabase } from '../lib/supabase';
import { enqueueRecurringPollInbox } from '../jobs/poll-inbox.job';
import { sendEmail, checkSendCap } from '../services/email.service';
import { pollInbox } from '../services/gmail.service';
import { scheduleCall } from '../services/voice.service';
import { enrichLeads } from '../services/inbox.service';
import { processCsvImportJob } from '../services/leads.service';
import type { SendEmailJobData } from '../jobs/send-email.job';
import type { PollInboxJobData } from '../jobs/poll-inbox.job';
import type { ScheduleCallJobData } from '../jobs/schedule-call.job';
import type { EnrichLeadsJobData } from '../jobs/enrich-leads.job';
import type { CsvImportJobData } from '../jobs/csv-import.job';

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

const csvImportWorker = new Worker<CsvImportJobData>('csv-import', async (job) => {
  console.log(`[csv-import] Processing job ${job.id}: ${job.data.fileName} (${job.data.totalRows} rows)`);
  const result = await processCsvImportJob(job.id!, job.data);
  console.log(`[csv-import] Job ${job.id} completed: ${result.inserted} inserted, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}, {
  connection: redisConnection,
  concurrency: 2,
});

sendEmailWorker.on('failed', (job, err) => console.error(`[send-email] Job ${job?.id} failed:`, err.message));
pollInboxWorker.on('failed', (job, err) => console.error(`[poll-inbox] Job ${job?.id} failed:`, err.message));
scheduleCallWorker.on('failed', (job, err) => console.error(`[schedule-call] Job ${job?.id} failed:`, err.message));
enrichLeadsWorker.on('failed', (job, err) => console.error(`[enrich-leads] Job ${job?.id} failed:`, err.message));
csvImportWorker.on('failed', (job, err) => console.error(`[csv-import] Job ${job?.id} failed:`, err.message));

console.log('Workers started: send-email, poll-inbox, schedule-call, enrich-leads, csv-import');

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

export { sendEmailWorker, pollInboxWorker, scheduleCallWorker, enrichLeadsWorker, csvImportWorker };
