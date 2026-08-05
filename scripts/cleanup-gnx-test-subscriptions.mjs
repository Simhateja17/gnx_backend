#!/usr/bin/env node

/*
 * Cancels subscriptions created by GNX on a Razorpay TEST account.
 *
 * Razorpay plans cannot be deleted — the API has no delete endpoint and the
 * Dashboard does not offer one. Subscriptions CAN be cancelled, which is the
 * only cleanup actually available.
 *
 * Safety: only touches subscriptions whose plan carries notes.gnx_plan_key,
 * i.e. plans created by scripts/setup-razorpay-test-plans.mjs. Subscriptions
 * belonging to anything else on the account are listed but never cancelled.
 *
 *   node scripts/cleanup-gnx-test-subscriptions.mjs                  # dry run
 *   node scripts/cleanup-gnx-test-subscriptions.mjs --cancel         # act
 *
 * Prompts for credentials; nothing is read from .env and nothing is saved.
 */

import Razorpay from 'razorpay';
import readline from 'node:readline';
import process from 'node:process';

const CANCELLABLE = new Set(['created', 'authenticated', 'active', 'pending', 'halted']);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function askSecret(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return ask(question);
  return new Promise((resolve, reject) => {
    let answer = '';
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '') { cleanup(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(answer.trim()); return; }
        if (char === '' || char === '\b') {
          if (answer.length > 0) { answer = answer.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        answer += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

function errorShape(error) {
  const provider = error?.error ?? {};
  return { statusCode: error?.statusCode ?? null, description: provider.description ?? null };
}

async function main() {
  const shouldCancel = process.argv.includes('--cancel');

  const keyId = await ask('Razorpay Test Mode Key ID (rzp_test_...): ');
  const keySecret = await askSecret('Razorpay Test Mode Key Secret: ');
  if (!keyId.startsWith('rzp_test_')) throw new Error('Refusing to run: the Key ID must start with rzp_test_.');
  if (!keySecret) throw new Error('A Key Secret is required.');

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  const plans = await razorpay.plans.all({ count: 100 });
  const gnxPlanIds = new Set(
    (plans.items ?? []).filter((plan) => plan.notes?.gnx_plan_key).map((plan) => plan.id),
  );

  console.log(`\nGNX-created plans on this account: ${gnxPlanIds.size}`);
  for (const plan of plans.items ?? []) {
    if (gnxPlanIds.has(plan.id)) {
      console.log(`  ${plan.id}  ${plan.period}  ${plan.item?.currency} ${plan.item?.amount}  (${plan.notes.gnx_plan_key})`);
    }
  }
  console.log('  NOTE: plans cannot be deleted — these will remain on the account permanently.\n');

  if (gnxPlanIds.size === 0) {
    console.log('No GNX plans found, so no GNX subscriptions to clean up.');
    return;
  }

  const subscriptions = await razorpay.subscriptions.all({ count: 100 });
  const mine = (subscriptions.items ?? []).filter((subscription) => gnxPlanIds.has(subscription.plan_id));

  console.log(`Subscriptions on GNX plans: ${mine.length}`);
  if (mine.length === 0) return;

  for (const subscription of mine) {
    const cancellable = CANCELLABLE.has(subscription.status);
    console.log(`  ${subscription.id}  status=${subscription.status}  plan=${subscription.plan_id}${cancellable ? '' : '  (nothing to do)'}`);
  }

  if (!shouldCancel) {
    console.log('\nDry run. Re-run with --cancel to cancel the cancellable ones.');
    return;
  }

  console.log('');
  for (const subscription of mine) {
    if (!CANCELLABLE.has(subscription.status)) continue;
    try {
      // false = cancel immediately rather than at cycle end.
      await razorpay.subscriptions.cancel(subscription.id, false);
      console.log(`  cancelled ${subscription.id}`);
    } catch (error) {
      console.log(`  FAILED ${subscription.id} ${JSON.stringify(errorShape(error))}`);
    }
  }
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
});
