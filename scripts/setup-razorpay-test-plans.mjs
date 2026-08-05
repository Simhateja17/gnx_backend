#!/usr/bin/env node

import Razorpay from 'razorpay';
import readline from 'node:readline';
import process from 'node:process';

const CURRENCY = 'USD';

const DEFINITIONS = [
  {
    key: 'starter_monthly',
    envName: 'RAZORPAY_SUBSCRIPTION_PLAN_STARTER_MONTHLY_ID',
    name: 'Globonexo Starter (Monthly)',
    period: 'monthly',
    amount: 5900,
  },
  {
    key: 'starter_annual',
    envName: 'RAZORPAY_SUBSCRIPTION_PLAN_STARTER_ANNUAL_ID',
    name: 'Globonexo Starter (Annual)',
    period: 'yearly',
    amount: 58800,
  },
  {
    key: 'growth_monthly',
    envName: 'RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_MONTHLY_ID',
    name: 'Globonexo Growth (Monthly)',
    period: 'monthly',
    amount: 17900,
  },
  {
    key: 'growth_annual',
    envName: 'RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_ANNUAL_ID',
    name: 'Globonexo Growth (Annual)',
    period: 'yearly',
    amount: 178800,
  },
  {
    key: 'scale_monthly',
    envName: 'RAZORPAY_SUBSCRIPTION_PLAN_SCALE_MONTHLY_ID',
    name: 'Globonexo Scale (Monthly)',
    period: 'monthly',
    amount: 47900,
  },
  {
    key: 'scale_annual',
    envName: 'RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID',
    name: 'Globonexo Scale (Annual)',
    period: 'yearly',
    amount: 478800,
  },
];

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return ask(question);
  }

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
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(answer.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        answer += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

function describeProviderError(error) {
  const status = error?.statusCode ?? error?.status;
  const description = error?.error?.description ?? error?.message ?? 'Unknown Razorpay error';
  if (status === 401 || error?.error?.code === 'BAD_REQUEST_ERROR' && /authentication/i.test(description)) {
    return 'Razorpay rejected the key pair. Use a matching Key ID and Key Secret from Razorpay Test Mode, then run this script again.';
  }
  return `${description}${status ? ` (HTTP ${status})` : ''}`;
}

async function main() {
  console.log('Razorpay Test Mode recurring-plan setup');
  console.log('This uses the approved USD backend prices and does not save your credentials.\n');

  const keyId = await ask('Razorpay Test Mode Key ID (rzp_test_...): ');
  const keySecret = await askSecret('Razorpay Test Mode Key Secret: ');

  if (!keyId.startsWith('rzp_test_')) {
    throw new Error('The Key ID must start with rzp_test_. Do not use a Live Mode key.');
  }
  if (!keySecret) {
    throw new Error('A Razorpay Test Mode Key Secret is required.');
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  let existing;
  try {
    existing = await razorpay.plans.all({ count: 100 });
  } catch (error) {
    throw new Error(describeProviderError(error));
  }

  const resolved = [];
  for (const definition of DEFINITIONS) {
    const match = existing.items?.find((plan) => (
      plan.notes?.gnx_plan_key === definition.key
      && plan.period === definition.period
      && plan.interval === 1
      && Number(plan.item?.amount) === definition.amount
      && plan.item?.currency === CURRENCY
    ));

    let plan = match;
    if (plan) {
      console.log(`Reusing ${definition.key}: ${plan.id}`);
    } else {
      try {
        plan = await razorpay.plans.create({
          period: definition.period,
          interval: 1,
          item: {
            name: definition.name,
            amount: definition.amount,
            currency: CURRENCY,
            description: `${definition.name} recurring subscription`,
          },
          notes: { gnx_plan_key: definition.key },
        });
        console.log(`Created ${definition.key}: ${plan.id}`);
      } catch (error) {
        throw new Error(`Could not create ${definition.key}: ${describeProviderError(error)}`);
      }
    }
    resolved.push(`${definition.envName}=${plan.id}`);
  }

  console.log('\nCopy these values into both the Render API service and worker environment:');
  console.log(`RAZORPAY_CURRENCY=${CURRENCY}`);
  console.log('RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED=true');
  console.log(resolved.join('\n'));
  console.log('\nSubscriptions use 120 monthly cycles or 10 annual cycles.');
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  process.exitCode = 1;
});
