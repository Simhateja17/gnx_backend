import { Worker } from 'bullmq';
import { redis } from '../lib/redis';

// TODO: implement actual worker processors
const sendEmailWorker = new Worker('send-email', async (job) => {
  console.log('send-email job', job.id, job.data);
}, { connection: redis });

const pollInboxWorker = new Worker('poll-inbox', async (job) => {
  console.log('poll-inbox job', job.id, job.data);
}, { connection: redis });

const scheduleCallWorker = new Worker('schedule-call', async (job) => {
  console.log('schedule-call job', job.id, job.data);
}, { connection: redis });

const enrichLeadsWorker = new Worker('enrich-leads', async (job) => {
  console.log('enrich-leads job', job.id, job.data);
}, { connection: redis });

console.log('Workers started');

export { sendEmailWorker, pollInboxWorker, scheduleCallWorker, enrichLeadsWorker };
