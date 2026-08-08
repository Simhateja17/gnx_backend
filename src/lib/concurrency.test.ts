import { describe, expect, it } from 'vitest';
import { chunk, mapWithConcurrency } from './concurrency';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('chunk', () => {
  it('splits into fixed-size batches preserving order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('produces exactly ten batches for a hundred leads at ten per batch', () => {
    expect(chunk(Array.from({ length: 100 }, (_, i) => i), 10)).toHaveLength(10);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async value => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      return value;
    });

    expect(peak).toBe(3);
  });

  it('returns results in input order regardless of completion order', async () => {
    // Batches finish out of order in practice; callers zip results back
    // against their inputs by index, so order must not follow completion.
    const results = await mapWithConcurrency([30, 1, 20, 2, 10], 3, async value => {
      await new Promise(resolve => setTimeout(resolve, value));
      return value;
    });

    expect(results).toEqual([30, 1, 20, 2, 10]);
  });

  it('starts the next task the moment any one finishes, rather than in waves', async () => {
    // The distinction the whole helper exists for: with wave scheduling a
    // single slow task holds two idle slots until it finishes. Here tasks 0
    // and 1 hang while task 2 completes - task 3 must start anyway.
    const gates = [deferred(), deferred()];
    const started: number[] = [];

    const work = mapWithConcurrency(Array.from({ length: 6 }, (_, i) => i), 3, async index => {
      started.push(index);
      if (index < 2) await gates[index].promise;
      return index;
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    // Slots 0 and 1 are blocked; the third runner should have worked through
    // the rest of the queue instead of waiting for them.
    expect(started).toContain(3);
    expect(started).toContain(4);
    expect(started).toContain(5);

    gates[0].resolve();
    gates[1].resolve();
    expect(await work).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles a list shorter than the concurrency limit', async () => {
    expect(await mapWithConcurrency([1, 2], 5, async value => value * 2)).toEqual([2, 4]);
  });

  it('returns nothing for an empty list without invoking the worker', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 3, async () => { calls++; return 1; });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
