#!/usr/bin/env node

/*
 * Isolates which field in our Create Subscription payload Razorpay rejects.
 *
 * !! THIS CAN CREATE REAL TEST-MODE SUBSCRIPTIONS !!
 *
 * Variants that FAIL cost nothing. The first variant that SUCCEEDS identifies
 * the culprit — the script cancels it immediately and stops. Worst case one
 * subscription exists briefly in `created` status. No money moves; a
 * subscription only charges after a customer authorises it.
 *
 * Requires an explicit flag so it can never run by accident:
 *   node scripts/isolate-razorpay-subscription-field.mjs --confirm-creates-subscriptions
 *
 * No credential is ever printed.
 */

import 'dotenv/config';
import Razorpay from 'razorpay';
import process from 'node:process';

const CONFIRM_FLAG = '--confirm-creates-subscriptions';

// Annual plan — the period our failing request used.
const PLAN_ENV = 'RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID';

function errorShape(error) {
  const provider = error?.error ?? {};
  return {
    statusCode: error?.statusCode ?? null,
    description: provider.description ?? null,
    field: provider.field ?? null,
    reason: provider.reason ?? null,
  };
}

function buildVariants(planId) {
  const notes = { organizationId: '00000000-0000-0000-0000-000000000000', planId: 'scale', billingPeriod: 'annual' };

  return [
    // Reproduces production exactly. Expected to fail — confirms the harness.
    { label: 'A. exact production payload',
      payload: { plan_id: planId, total_count: 10, quantity: 1, customer_notify: true, notes } },

    // One field changed per variant, everything else identical to A.
    { label: 'B. total_count 10 -> 1',
      payload: { plan_id: planId, total_count: 1, quantity: 1, customer_notify: true, notes } },

    { label: 'C. customer_notify true -> 1',
      payload: { plan_id: planId, total_count: 10, quantity: 1, customer_notify: 1, notes } },

    { label: 'D. notes removed',
      payload: { plan_id: planId, total_count: 10, quantity: 1, customer_notify: true } },

    { label: 'E. quantity removed',
      payload: { plan_id: planId, total_count: 10, customer_notify: true, notes } },

    // Bare minimum the API documents as required.
    { label: 'F. plan_id + total_count only',
      payload: { plan_id: planId, total_count: 10 } },

    { label: 'G. plan_id + total_count 1 only',
      payload: { plan_id: planId, total_count: 1 } },
  ];
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.log('This script can create real Test Mode subscriptions.');
    console.log(`Re-run with ${CONFIRM_FLAG} if you accept that.`);
    process.exitCode = 1;
    return;
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.');
  if (!keyId.startsWith('rzp_test_')) throw new Error('Refusing to run: this is not a Test Mode key.');

  const planId = process.env[PLAN_ENV];
  if (!planId) throw new Error(`${PLAN_ENV} is not set.`);

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  console.log(`Mode: TEST   Plan: ${planId}\n`);

  for (const { label, payload } of buildVariants(planId)) {
    let created;
    try {
      created = await razorpay.subscriptions.create(payload);
    } catch (error) {
      console.log(`  FAIL  ${label}  ${JSON.stringify(errorShape(error))}`);
      continue;
    }

    console.log(`\n  SUCCESS  ${label}  -> ${created.id}`);
    console.log('  This is the field that was breaking it.');

    try {
      await razorpay.subscriptions.cancel(created.id, false);
      console.log(`  Cancelled ${created.id}. No state left behind.`);
    } catch (cancelError) {
      console.log(`  !! Could not auto-cancel ${created.id} — cancel it in the Dashboard.`);
      console.log(`     ${JSON.stringify(errorShape(cancelError))}`);
    }
    return;
  }

  console.log('\nEvery variant failed, including the documented minimum (plan_id + total_count).');
  console.log('That points back at the account/plan rather than our payload — send this output to Razorpay support.');
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
});
