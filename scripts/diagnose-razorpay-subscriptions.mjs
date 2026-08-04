#!/usr/bin/env node

/*
 * Read-only Razorpay subscription diagnostic.
 *
 * This script NEVER creates a subscription. Probe 2 deliberately uses a
 * non-existent plan ID so the call is guaranteed to fail — a failed create
 * leaves no state behind at Razorpay.
 *
 * It answers one question: does the account-level gate fire BEFORE plan
 * resolution (a capability problem) or AFTER it (a plan/currency problem)?
 *
 * Run from the backend directory so .env is picked up:
 *   node scripts/diagnose-razorpay-subscriptions.mjs
 *
 * No credential is ever printed.
 */

import 'dotenv/config';
import Razorpay from 'razorpay';
import process from 'node:process';

const PLAN_ENV_NAMES = [
  'RAZORPAY_SUBSCRIPTION_PLAN_STARTER_MONTHLY_ID',
  'RAZORPAY_SUBSCRIPTION_PLAN_STARTER_ANNUAL_ID',
  'RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_MONTHLY_ID',
  'RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_ANNUAL_ID',
  'RAZORPAY_SUBSCRIPTION_PLAN_SCALE_MONTHLY_ID',
  'RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID',
];

// Correct format (plan_ + 14 chars) but will not exist on any account.
const NONEXISTENT_PLAN_ID = 'plan_00000000000000';

function errorShape(error) {
  const provider = error?.error ?? {};
  return {
    statusCode: error?.statusCode ?? null,
    code: provider.code ?? null,
    description: provider.description ?? null,
    reason: provider.reason ?? null,
    field: provider.field ?? null,
    source: provider.source ?? null,
    step: provider.step ?? null,
  };
}

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set in this environment.');
  }

  console.log(`Mode: ${keyId.startsWith('rzp_test_') ? 'TEST' : 'LIVE'}`);
  console.log(`Configured plan env vars present: ${PLAN_ENV_NAMES.filter((n) => process.env[n]).length}/6\n`);

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  // ---- Probe 1: read back each configured plan (read-only) ----
  console.log('Probe 1 — plan currency/period as Razorpay sees them:');
  for (const envName of PLAN_ENV_NAMES) {
    const planId = process.env[envName];
    if (!planId) {
      console.log(`  ${envName}: NOT SET`);
      continue;
    }
    try {
      const plan = await razorpay.plans.fetch(planId);
      console.log(
        `  ${plan.id}  period=${plan.period} interval=${plan.interval} `
        + `currency=${plan.item?.currency} amount=${plan.item?.amount}`,
      );
    } catch (error) {
      console.log(`  ${envName}: FETCH FAILED ${JSON.stringify(errorShape(error))}`);
    }
  }

  // ---- Probe 2: guaranteed-to-fail create, to locate the gate ----
  console.log('\nProbe 2 — create against a non-existent plan (creates nothing):');
  try {
    await razorpay.subscriptions.create({
      plan_id: NONEXISTENT_PLAN_ID,
      total_count: 10,
      quantity: 1,
      customer_notify: true,
      notes: { probe: 'gnx-diagnostic' },
    });
    console.log('  UNEXPECTED: the call succeeded. Cancel this subscription in the Dashboard.');
  } catch (error) {
    const shape = errorShape(error);
    console.log(`  ${JSON.stringify(shape)}`);

    console.log('\nInterpretation:');
    if (shape.field || /plan/i.test(shape.description ?? '')) {
      console.log('  Razorpay reached PLAN RESOLUTION for a bogus plan, which means the');
      console.log('  account-level subscription gate is NOT blocking requests. The bare');
      console.log('  "Validation failed" seen for your real USD plans is therefore specific');
      console.log('  to those plans — most likely their USD currency.');
    } else {
      console.log('  Razorpay returned the SAME bare error for a plan that does not exist.');
      console.log('  Validation is failing BEFORE plan lookup, so the rejection is an');
      console.log('  account-level capability gate on Subscriptions for this account/mode —');
      console.log('  not anything about your plans or your payload.');
    }
  }
}

main().catch((error) => {
  console.error(`\nDiagnostic failed: ${error.message}`);
  process.exitCode = 1;
});
