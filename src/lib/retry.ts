import { AppError } from '../types';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryable(err: any): boolean {
  if (err?.status && RETRYABLE_STATUS_CODES.has(err.status)) return true;
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED') return true;
  if (err?.name === 'AbortError') return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, label = 'operation' } = {},
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      if (!isRetryable(err) || attempt === maxAttempts) break;

      const delayMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message ?? err}. Retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (lastError instanceof AppError) throw lastError;

  throw new AppError(
    502,
    `AI service unavailable after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown error'}`,
  );
}
