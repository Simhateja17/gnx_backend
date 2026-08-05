#!/usr/bin/env node

/*
 * Control test: is the subscription failure caused by the plan's CURRENCY?
 *
 * Creates a throwaway INR plan, then attempts a subscription on it using the
 * exact payload that fails against our USD plans. Currency is the only variable
 * that differs between the two attempts.
 *
 * !! CREATES TEST-MODE STATE !!
 *   - one INR plan named "ZZ Diagnostic - delete me" (plans cannot be deleted
 *     via API; remove it in the Dashboard afterwards)
 *   - possibly one subscription, which is cancelled immediately
 *
 * No money moves — a subscription only charges after a customer authorises it.
 *
 *   node scripts/inr-control-test.mjs --confirm-creates-test-data
 *
 * No credential is ever printed.
 */

import 'dotenv/config';
import Razorpay from 'razorpay';
import process from 'node:process';

const CONFIRM_FLAG = '--confirm-creates-test-data';
const USD_PLAN_ENV = 'RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID';

function errorShape(error) {
  const provider = error?.error ?? {};
  return {
    statusCode: error?.statusCode ?? null,
    description: provider.description ?? null,
    field: provider.field ?? null,
    reason: provider.reason ?? null,
  };
}

// The identical payload for both currencies. Only plan_id changes.
function payloadFor(planId) {
  return { plan_id: planId, total_count: 10, quantity: 1, customer_notify: true };
}

async function attempt(razorpay, label, planId) {
  try {
    const subscription = await razorpay.subscriptions.create(payloadFor(planId));
    console.log(`  ${label}: SUCCESS -> ${subscription.id}`);
    try {
      await razorpay.subscriptions.cancel(subscription.id, false);
      console.log(`    cancelled ${subscription.id}`);
    } catch (cancelError) {
      console.log(`    !! could not cancel ${subscription.id}: ${JSON.stringify(errorShape(cancelError))}`);
    }
    return true;
  } catch (error) {
    console.log(`  ${label}: FAIL ${JSON.stringify(errorShape(error))}`);
    return false;
  }
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.log('This script creates a throwaway INR plan and possibly one subscription.');
    console.log(`Re-run with ${CONFIRM_FLAG} if you accept that.`);
    process.exitCode = 1;
    return;
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.');
  if (!keyId.startsWith('rzp_test_')) throw new Error('Refusing to run: this is not a Test Mode key.');

  const usdPlanId = process.env[USD_PLAN_ENV];
  if (!usdPlanId) throw new Error(`${USD_PLAN_ENV} is not set.`);

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  console.log('Mode: TEST\n');

  // Yearly + interval 1, matching the USD annual plan's structure exactly.
  console.log('Creating throwaway INR plan (yearly, interval 1, ₹100)...');
  let inrPlan;
  try {
    inrPlan = await razorpay.plans.create({
      period: 'yearly',
      interval: 1,
      item: { name: 'ZZ Diagnostic - delete me', amount: 10000, currency: 'INR' },
      notes: { purpose: 'gnx-currency-control-test' },
    });
    console.log(`  created ${inrPlan.id}\n`);
  } catch (error) {
    console.log(`  FAILED to create even an INR plan: ${JSON.stringify(errorShape(error))}`);
    console.log('  That is itself the answer — plan creation is broken, not currency.');
    return;
  }

  console.log('Subscription attempts (identical payload, only plan currency differs):');
  const usdOk = await attempt(razorpay, `USD ${usdPlanId}`, usdPlanId);
  const inrOk = await attempt(razorpay, `INR ${inrPlan.id}`, inrPlan.id);

  console.log('\nResult:');
  if (!usdOk && inrOk) {
    console.log('  INR succeeds, USD fails, same payload. CURRENCY IS THE CAUSE.');
    console.log('  USD recurring subscriptions are not enabled on this account/mode.');
    console.log('  Send this output to Razorpay support — it is unambiguous.');
  } else if (!usdOk && !inrOk) {
    console.log('  BOTH currencies fail. Subscription creation is broken for this account');
    console.log('  regardless of currency — not a USD issue. Escalate as "cannot create any');
    console.log('  subscription in test mode" and include this output.');
  } else if (usdOk) {
    console.log('  USD SUCCEEDED. The failure is intermittent rather than deterministic —');
    console.log('  rerun a few times before drawing any conclusion.');
  }

  console.log(`\nCleanup: delete plan ${inrPlan.id} in the Dashboard (plans have no delete API).`);
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
});
