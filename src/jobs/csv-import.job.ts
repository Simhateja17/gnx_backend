import { Queue } from 'bullmq';
import { queueConnection } from '../lib/redis';

export interface CsvImportJobData {
  organizationId: string;
  campaignId?: string;
  fileName: string;
  columnMapping: Record<string, string>;
  rows: Record<string, string>[];
  totalRows: number;
}

export interface CsvImportProgress {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  total: number;
  processed: number;
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  fileName: string;
}

const csvImportQueue = new Queue<CsvImportJobData, any, string>('csv-import', { connection: queueConnection });

export async function enqueueCsvImport(data: CsvImportJobData) {
  return csvImportQueue.add('csv-import', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}
