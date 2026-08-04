import 'dotenv/config';
import Razorpay from 'razorpay';

const amount = (name) => Number(process.env[name]);
const currency = process.env.RAZORPAY_CURRENCY || 'USD';

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const definitions = [
  ['starter_monthly', 'Starter', 'monthly', amount('RAZORPAY_PLAN_STARTER_MONTHLY_AMOUNT')],
  ['starter_annual', 'Starter', 'yearly', amount('RAZORPAY_PLAN_STARTER_ANNUAL_TOTAL_AMOUNT')],
  ['growth_monthly', 'Growth', 'monthly', amount('RAZORPAY_PLAN_GROWTH_MONTHLY_AMOUNT')],
  ['growth_annual', 'Growth', 'yearly', amount('RAZORPAY_PLAN_GROWTH_ANNUAL_TOTAL_AMOUNT')],
  ['scale_monthly', 'Scale', 'monthly', amount('RAZORPAY_PLAN_SCALE_MONTHLY_AMOUNT')],
  ['scale_annual', 'Scale', 'yearly', amount('RAZORPAY_PLAN_SCALE_ANNUAL_TOTAL_AMOUNT')],
];

const existing = await razorpay.plans.all();
const output = [];

for (const [key, planName, period, planAmount] of definitions) {
  if (!Number.isSafeInteger(planAmount) || planAmount <= 0) {
    throw new Error(`Invalid amount for ${key}`);
  }

  const found = existing.items.find((plan) => (
    plan.notes?.gnx_plan_key === key
    && plan.period === period
    && plan.interval === 1
    && Number(plan.item?.amount) === planAmount
    && plan.item?.currency === currency
  ));

  const plan = found ?? await razorpay.plans.create({
    period,
    interval: 1,
    item: {
      name: `Globonexo ${planName} (${key.includes('annual') ? 'Annual' : 'Monthly'})`,
      amount: planAmount,
      currency,
      description: `${planName} recurring subscription`,
    },
    notes: { gnx_plan_key: key },
  });

  output.push(`RAZORPAY_SUBSCRIPTION_PLAN_${key.toUpperCase()}_ID=${plan.id}`);
}

console.log('\nCopy these six values into the backend test environment and Render:');
console.log(output.join('\n'));
