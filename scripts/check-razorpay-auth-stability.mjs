#!/usr/bin/env node

/*
 * Quantifies whether Razorpay auth failures are intermittent, and whether they
 * affect reads as well as subscription creates.
 *
 * The create attempts use a NON-EXISTENT plan ID, so they can never succeed and
 * can never leave state behind. That is deliberate: we only care about which
 * *class* of error comes back (401 auth vs 400 validation/lookup), not whether
 * a subscription is creatable.
 *
 *   node scripts/check-razorpay-auth-stability.mjs
 *
 * Optional: --delay=500  milliseconds between calls (default 250), to test
 * whether the failures are rate-limit related.
 *
 * No credential is ever printed — only its length and shape.
 */

import 'dotenv/config';
import Razorpay from 'razorpay';
import process from 'node:process';

const ROUNDS = 10;
const NONEXISTENT_PLAN_ID = 'plan_00000000000000';

const delayArg = process.argv.find((a) => a.startsWith('--delay='));
const DELAY_MS = delayArg ? Number(delayArg.split('=')[1]) : 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function classify(error) {
  const status = error?.statusCode ?? null;
  const description = error?.error?.description ?? null;
  if (status === null) return 'OK (no error)';
  return `${status} ${description ?? ''}`.trim();
}

// Reports shape only. Length and whitespace presence are not secrets, and a
// stray newline or truncated secret is the most common cause of flaky auth.
function reportCredentialShape(keyId, keySecret) {
  const rawSecret = process.env.RAZORPAY_KEY_SECRET ?? '';
  console.log('Credential shape (no values shown):');
  console.log(`  key_id     prefix=${keyId.slice(0, 9)}… length=${keyId.length}`);
  console.log(`  key_secret length=${keySecret.length}`);
  console.log(`  key_secret has leading/trailing whitespace: ${rawSecret !== rawSecret.trim()}`);
  console.log(`  key_secret contains quote characters: ${/["']/.test(rawSecret)}`);
  console.log('');
}

async function tally(label, fn) {
  const counts = new Map();
  for (let i = 0; i < ROUNDS; i += 1) {
    let outcome;
    try {
      await fn();
      outcome = 'OK (no error)';
    } catch (error) {
      outcome = classify(error);
    }
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  console.log(`${label} (${ROUNDS} calls, ${DELAY_MS}ms apart):`);
  for (const [outcome, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(2)}x  ${outcome}`);
  }
  console.log('');
  return counts;
}

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.');

  reportCredentialShape(keyId, keySecret);

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  const planId = process.env.RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID;
  if (!planId) throw new Error('RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID is not set.');

  // GET — does the flakiness affect reads too?
  const reads = await tally('GET  /plans/:id', () => razorpay.plans.fetch(planId));

  // POST — guaranteed to fail on plan lookup, so no state is ever created.
  const writes = await tally('POST /subscriptions (bogus plan, cannot succeed)', () => (
    razorpay.subscriptions.create({
      plan_id: NONEXISTENT_PLAN_ID,
      total_count: 10,
      quantity: 1,
      customer_notify: true,
      notes: { probe: 'gnx-auth-stability' },
    })
  ));

  const readAuthFailures = [...reads.entries()].filter(([k]) => k.startsWith('401')).reduce((n, [, v]) => n + v, 0);
  const writeAuthFailures = [...writes.entries()].filter(([k]) => k.startsWith('401')).reduce((n, [, v]) => n + v, 0);

  console.log('Interpretation:');
  if (readAuthFailures === 0 && writeAuthFailures === 0) {
    console.log('  No 401s at all. The earlier auth failures were transient — likely rate');
    console.log('  limiting from firing 7 creates back-to-back with no delay.');
  } else if (readAuthFailures > 0 && writeAuthFailures > 0) {
    console.log('  401s on BOTH reads and writes => the credentials themselves are the');
    console.log('  problem, not anything about subscriptions. Check that the key ID and');
    console.log('  secret in .env are from the SAME key pair and were not partially rotated.');
  } else if (writeAuthFailures > 0) {
    console.log('  401s on writes only, reads clean => the key pair is valid but lacks');
    console.log('  write scope for Subscriptions, or subscription creates are throttled.');
  } else {
    console.log('  401s on reads only — unexpected. Send this output over.');
  }
  console.log('\n  Re-run with --delay=1000 to rule out rate limiting before concluding.');
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
});
