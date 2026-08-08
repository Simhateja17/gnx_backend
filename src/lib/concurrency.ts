/**
 * Sliding-window concurrency.
 *
 * Keeps exactly `limit` tasks in flight and starts the next queued task the
 * moment any one finishes - not in waves. Waves are the intuitive
 * implementation and the wrong one: a single slow task holds the whole batch
 * while the other slots sit idle, so a wave of three runs as slowly as its
 * worst member every time.
 *
 * Results are returned in input order regardless of completion order, so
 * callers can zip them back against their inputs by index.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  // Each runner pulls the next unclaimed index rather than owning a fixed
  // slice, which is what makes the window slide: a runner that finishes early
  // immediately takes more work instead of waiting for its peers.
  const runner = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, runner));
  return results;
}

/** Splits a list into fixed-size chunks, preserving order. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
