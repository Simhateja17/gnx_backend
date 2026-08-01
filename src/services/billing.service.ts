import { supabase } from '../lib/supabase';
import { getRazorpayClient, verifyRazorpayWebhookSignature, verifyRazorpayCheckoutSignature } from '../lib/razorpay';
import { sendBillingReminderEmail } from '../lib/resend';
import { posthog } from '../lib/posthog';
import { env } from '../config/env';
import { AppError } from '../types';
import { randomUUID } from 'node:crypto';

type PlanId = 'starter' | 'growth' | 'scale';
type BillingPeriod = 'monthly' | 'annual';

const PLAN_AMOUNTS: Record<PlanId, Record<BillingPeriod, number>> = {
  starter: { monthly: env.RAZORPAY_PLAN_STARTER_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_STARTER_ANNUAL_TOTAL_AMOUNT },
  growth: { monthly: env.RAZORPAY_PLAN_GROWTH_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_GROWTH_ANNUAL_TOTAL_AMOUNT },
  scale: { monthly: env.RAZORPAY_PLAN_SCALE_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_SCALE_ANNUAL_TOTAL_AMOUNT },
};

export function getPlanAmount(planId: string, billingPeriod: string): number {
  const amounts = PLAN_AMOUNTS[planId as PlanId];
  if (!amounts) throw new AppError(400, `Unknown plan: ${planId}`);
  const amount = amounts[billingPeriod as BillingPeriod];
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError(500, `Pricing is not configured for ${planId}/${billingPeriod}`);
  }
  return amount;
}

export function buildReceipt(): string {
  // Razorpay receipts are limited to 40 characters and must be unique. A UUID
  // with the org prefix is exactly 40 characters and remains unique per order.
  return `org_${randomUUID()}`;
}

export async function createOrder(organizationId: string, planId: PlanId, billingPeriod: BillingPeriod) {
  const amount = getPlanAmount(planId, billingPeriod);
  const currency = env.RAZORPAY_CURRENCY;

  if (currency !== 'INR' && !env.RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED) {
    throw new AppError(503, 'International payments are not enabled for this Razorpay account');
  }

  const order = await getRazorpayClient().orders.create({
    amount,
    currency,
    receipt: buildReceipt(),
    notes: { organizationId, planId, billingPeriod },
  });

  const { error } = await supabase.from('billing_charges').insert({
    organization_id: organizationId,
    razorpay_order_id: order.id,
    amount,
    currency,
    plan_id: planId,
    billing_period: billingPeriod,
    status: 'created',
  });
  if (error) throw new AppError(500, 'Failed to record billing charge', error);

  return { orderId: order.id, amount, currency, keyId: env.RAZORPAY_KEY_ID };
}

type BillingCharge = {
  id: string;
  organization_id: string;
  razorpay_order_id: string;
  razorpay_payment_id?: string | null;
  amount: number;
  currency: string;
  plan_id: string;
  billing_period: BillingPeriod;
  status: string;
};

async function fetchCapturedPayment(
  orderId: string,
  paymentId: string | undefined,
  expectedAmount: number,
  expectedCurrency: string,
) {
  const razorpay = getRazorpayClient();
  const payment = paymentId
    ? await razorpay.payments.fetch(paymentId)
    : (await razorpay.orders.fetchPayments(orderId)).items.find((candidate) => (
      candidate.status === 'captured'
      && candidate.order_id === orderId
      && Number(candidate.amount) === expectedAmount
      && candidate.currency === expectedCurrency
    ));

  if (!payment) {
    throw new AppError(409, 'No captured payment was found for this order');
  }
  if (payment.order_id !== orderId) {
    throw new AppError(400, 'Payment does not belong to this order');
  }
  if (Number(payment.amount) !== expectedAmount || payment.currency !== expectedCurrency) {
    throw new AppError(400, 'Payment amount or currency does not match the order');
  }
  if (payment.status !== 'captured' || payment.captured === false) {
    throw new AppError(409, 'Payment has not been captured yet');
  }
  return payment;
}

async function finalizeBillingCharge(charge: BillingCharge, paymentId: string, signature?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('finalize_billing_charge', {
    p_charge_id: charge.id,
    p_organization_id: charge.organization_id,
    p_razorpay_payment_id: paymentId,
    p_razorpay_signature: signature ?? null,
  });
  if (error) {
    throw new AppError(500, 'Failed to activate the paid plan');
  }

  const result = Array.isArray(data) ? data[0] : data;
  return result?.already_paid === true;
}

export async function verifyCheckoutSignature(
  organizationId: string,
  payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
) {
  const { data: charge, error } = await supabase
    .from('billing_charges')
    .select('id, organization_id, razorpay_order_id, razorpay_payment_id, amount, currency, plan_id, billing_period, status')
    .eq('razorpay_order_id', payload.razorpay_order_id)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load the billing charge');
  if (!charge) throw new AppError(404, 'Charge not found');
  if (charge.organization_id !== organizationId) throw new AppError(403, 'Charge does not belong to this organization');

  const valid = verifyRazorpayCheckoutSignature(charge.razorpay_order_id, payload.razorpay_payment_id, payload.razorpay_signature);
  if (!valid) throw new AppError(401, 'Invalid payment signature');

  if (charge.status === 'paid') {
    if (charge.razorpay_payment_id && charge.razorpay_payment_id !== payload.razorpay_payment_id) {
      throw new AppError(409, 'This order has already been paid with a different payment');
    }
    return { success: true, planId: charge.plan_id };
  }

  await fetchCapturedPayment(
    charge.razorpay_order_id,
    payload.razorpay_payment_id,
    Number(charge.amount),
    charge.currency,
  );
  await finalizeBillingCharge(charge as BillingCharge, payload.razorpay_payment_id, payload.razorpay_signature);

  posthog?.capture({
    distinctId: organizationId,
    event: 'billing_payment_verified',
    properties: { planId: charge.plan_id, billingPeriod: charge.billing_period },
  });

  return { success: true, planId: charge.plan_id };
}

export async function handleRazorpayWebhook(rawBody: Buffer, signature: string) {
  const bodyStr = rawBody.toString('utf-8');

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw new AppError(500, 'RAZORPAY_WEBHOOK_SECRET is not configured — refusing to process unverified webhook');
  }
  if (!verifyRazorpayWebhookSignature(bodyStr, signature)) {
    throw new AppError(401, 'Invalid webhook signature');
  }

  let payload: { event?: string; payload?: Record<string, any> };
  try {
    payload = JSON.parse(bodyStr) as { event?: string; payload?: Record<string, any> };
  } catch {
    throw new AppError(400, 'Invalid webhook payload');
  }
  const { event } = payload;
  if (!event) throw new AppError(400, 'Webhook event is missing');

  const paymentEntity = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity;
  const razorpayOrderId: string | undefined = paymentEntity?.order_id ?? orderEntity?.id;
  if (!razorpayOrderId) return; // Nothing we can key off of — ignore

  const { data: charge, error: chargeError } = await supabase
    .from('billing_charges')
    .select('id, organization_id, razorpay_order_id, razorpay_payment_id, amount, currency, plan_id, billing_period, status')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();

  if (chargeError) throw new AppError(500, 'Failed to load the billing charge');
  if (!charge) return; // Order we didn't create — ignore
  if (charge.status === 'paid') return; // Duplicate/out-of-order webhook after finalization

  if (event === 'payment.authorized') {
    const { error } = await supabase
      .from('billing_charges')
      .update({ status: 'attempted', updated_at: new Date().toISOString() })
      .eq('id', charge.id)
      .neq('status', 'paid');
    if (error) throw new AppError(500, 'Failed to record payment authorization');
    return;
  }

  if (event === 'payment.captured' || event === 'order.paid') {
    const payment = await fetchCapturedPayment(
      razorpayOrderId,
      paymentEntity?.id,
      Number(charge.amount),
      charge.currency,
    );
    await finalizeBillingCharge(charge as BillingCharge, payment.id);
    return;
  }

  if (event === 'payment.failed') {
    const { error } = await supabase
      .from('billing_charges')
      .update({ status: 'failed', razorpay_payment_id: paymentEntity?.id ?? null, updated_at: new Date().toISOString() })
      .eq('id', charge.id)
      .neq('status', 'paid');
    if (error) throw new AppError(500, 'Failed to record payment failure');
  }
}

export async function getBillingHistory(organizationId: string) {
  const { data, error } = await supabase
    .from('billing_charges')
    .select('id, plan_id, billing_period, amount, currency, status, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw new AppError(500, 'Failed to fetch billing history', error);
  return data ?? [];
}

// Daily job body — see jobs/billing-renewal-check.job.ts / workers/index.ts.
export async function runRenewalCheck() {
  const now = new Date();
  const graceDays = env.BILLING_GRACE_PERIOD_DAYS;
  const reminderWindowStart = now.toISOString();
  const reminderWindowEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const { data: subs, error: subsError } = await supabase
    .from('subscriptions')
    .select('id, organization_id, plan_id, status, current_period_end, grace_ends_at, organizations(name)')
    .in('status', ['active', 'past_due']);
  if (subsError) throw new AppError(500, 'Failed to load subscriptions for renewal check');

  for (const sub of subs ?? []) {
    const org = sub.organizations as any;
    const { data: orgUsers, error: usersError } = await supabase
      .from('users')
      .select('email')
      .eq('organization_id', sub.organization_id)
      .in('role', ['owner', 'admin']);
    if (usersError) throw new AppError(500, 'Failed to load billing contacts');
    const recipients = (orgUsers ?? []).map((u) => u.email).filter(Boolean);

    if (sub.status === 'active') {
      const periodEnd = new Date(sub.current_period_end);

      if (periodEnd < now) {
        const graceEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();
        const { error: subscriptionError } = await supabase
          .from('subscriptions')
          .update({ status: 'past_due', grace_ends_at: graceEndsAt, updated_at: now.toISOString() })
          .eq('id', sub.id);
        if (subscriptionError) throw new AppError(500, 'Failed to mark subscription past due');
        const { error: organizationError } = await supabase
          .from('organizations')
          .update({ subscription_status: 'past_due', updated_at: now.toISOString() })
          .eq('id', sub.organization_id);
        if (organizationError) throw new AppError(500, 'Failed to mark organization past due');
        for (const email of recipients) {
          await sendBillingReminderEmail({ to: email, orgName: org?.name ?? 'your organization', kind: 'grace_period', graceDays });
        }
      } else if (periodEnd.toISOString() >= reminderWindowStart && periodEnd.toISOString() <= reminderWindowEnd) {
        for (const email of recipients) {
          await sendBillingReminderEmail({ to: email, orgName: org?.name ?? 'your organization', kind: 'reminder' });
        }
      }
      continue;
    }

    if (sub.status === 'past_due' && sub.grace_ends_at && new Date(sub.grace_ends_at) < now) {
      const { error: subscriptionError } = await supabase
        .from('subscriptions')
        .update({ status: 'restricted', updated_at: now.toISOString() })
        .eq('id', sub.id);
      if (subscriptionError) throw new AppError(500, 'Failed to restrict subscription');
      const { error: organizationError } = await supabase
        .from('organizations')
        .update({ subscription_status: 'restricted', updated_at: now.toISOString() })
        .eq('id', sub.organization_id);
      if (organizationError) throw new AppError(500, 'Failed to restrict organization');
      for (const email of recipients) {
        await sendBillingReminderEmail({ to: email, orgName: org?.name ?? 'your organization', kind: 'restricted' });
      }
    }
  }
}
