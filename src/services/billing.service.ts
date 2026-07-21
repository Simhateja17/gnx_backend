import { supabase } from '../lib/supabase';
import { getRazorpayClient, verifyRazorpayWebhookSignature, verifyRazorpayCheckoutSignature } from '../lib/razorpay';
import { sendBillingReminderEmail } from '../lib/resend';
import { posthog } from '../lib/posthog';
import { env } from '../config/env';
import { AppError } from '../types';

type PlanId = 'starter' | 'growth' | 'scale';
type BillingPeriod = 'monthly' | 'annual';

const PLAN_AMOUNTS: Record<PlanId, Record<BillingPeriod, number>> = {
  starter: { monthly: env.RAZORPAY_PLAN_STARTER_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_STARTER_ANNUAL_AMOUNT },
  growth: { monthly: env.RAZORPAY_PLAN_GROWTH_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_GROWTH_ANNUAL_AMOUNT },
  scale: { monthly: env.RAZORPAY_PLAN_SCALE_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_SCALE_ANNUAL_AMOUNT },
};

export function getPlanAmount(planId: string, billingPeriod: string): number {
  const amounts = PLAN_AMOUNTS[planId as PlanId];
  if (!amounts) throw new AppError(400, `Unknown plan: ${planId}`);
  return amounts[billingPeriod as BillingPeriod];
}

export async function createOrder(organizationId: string, planId: PlanId, billingPeriod: BillingPeriod) {
  const amount = getPlanAmount(planId, billingPeriod);

  const order = await getRazorpayClient().orders.create({
    amount,
    currency: 'USD',
    receipt: `org_${organizationId}_${Date.now()}`.slice(0, 40),
    notes: { organizationId, planId, billingPeriod },
  });

  const { error } = await supabase.from('billing_charges').insert({
    organization_id: organizationId,
    razorpay_order_id: order.id,
    amount,
    currency: 'USD',
    plan_id: planId,
    billing_period: billingPeriod,
    status: 'created',
  });
  if (error) throw new AppError(500, 'Failed to record billing charge', error);

  return { orderId: order.id, amount, currency: 'USD', keyId: env.RAZORPAY_KEY_ID };
}

function periodEndFrom(billingPeriod: BillingPeriod, from: Date): string {
  const end = new Date(from);
  if (billingPeriod === 'annual') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end.toISOString();
}

async function activateSubscription(organizationId: string, planId: string, billingPeriod: BillingPeriod) {
  const now = new Date();
  const periodEnd = periodEndFrom(billingPeriod, now);

  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('organization_id', organizationId)
    .maybeSingle();

  const record = {
    organization_id: organizationId,
    plan_id: planId,
    status: 'active',
    billing_period: billingPeriod,
    current_period_start: now.toISOString(),
    current_period_end: periodEnd,
    grace_ends_at: null,
  };

  if (existing) {
    await supabase.from('subscriptions').update(record).eq('id', existing.id);
  } else {
    await supabase.from('subscriptions').insert(record);
  }

  await supabase.from('organizations').update({ plan_id: planId, subscription_status: 'active' }).eq('id', organizationId);
}

export async function verifyCheckoutSignature(
  organizationId: string,
  payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
) {
  const valid = verifyRazorpayCheckoutSignature(payload.razorpay_order_id, payload.razorpay_payment_id, payload.razorpay_signature);
  if (!valid) throw new AppError(401, 'Invalid payment signature');

  const { data: charge, error } = await supabase
    .from('billing_charges')
    .select('id, organization_id, plan_id, billing_period')
    .eq('razorpay_order_id', payload.razorpay_order_id)
    .single();
  if (error || !charge) throw new AppError(404, 'Charge not found');
  if (charge.organization_id !== organizationId) throw new AppError(403, 'Charge does not belong to this organization');

  await supabase
    .from('billing_charges')
    .update({ status: 'paid', razorpay_payment_id: payload.razorpay_payment_id, razorpay_signature: payload.razorpay_signature })
    .eq('id', charge.id);

  await activateSubscription(organizationId, charge.plan_id, charge.billing_period as BillingPeriod);

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

  const payload = JSON.parse(bodyStr) as { event: string; payload: Record<string, any> };
  const { event } = payload;

  const paymentEntity = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity;
  const razorpayOrderId: string | undefined = paymentEntity?.order_id ?? orderEntity?.id;
  if (!razorpayOrderId) return; // Nothing we can key off of — ignore

  const { data: charge } = await supabase
    .from('billing_charges')
    .select('id, organization_id, plan_id, billing_period, status')
    .eq('razorpay_order_id', razorpayOrderId)
    .single();

  if (!charge) return; // Order we didn't create — ignore

  if (event === 'payment.captured' || event === 'order.paid') {
    if (charge.status !== 'paid') {
      await supabase
        .from('billing_charges')
        .update({ status: 'paid', razorpay_payment_id: paymentEntity?.id ?? null })
        .eq('id', charge.id);
      await activateSubscription(charge.organization_id, charge.plan_id, charge.billing_period as BillingPeriod);
    }
  }

  if (event === 'payment.failed') {
    await supabase
      .from('billing_charges')
      .update({ status: 'failed', razorpay_payment_id: paymentEntity?.id ?? null })
      .eq('id', charge.id);
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

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('id, organization_id, plan_id, status, current_period_end, grace_ends_at, organizations(name)')
    .in('status', ['active', 'past_due']);

  for (const sub of subs ?? []) {
    const org = sub.organizations as any;
    const { data: orgUsers } = await supabase.from('users').select('email').eq('organization_id', sub.organization_id).eq('role', 'admin');
    const recipients = (orgUsers ?? []).map((u) => u.email).filter(Boolean);
    if (recipients.length === 0) continue;

    if (sub.status === 'active') {
      const periodEnd = new Date(sub.current_period_end);

      if (periodEnd < now) {
        const graceEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();
        await supabase.from('subscriptions').update({ status: 'past_due', grace_ends_at: graceEndsAt }).eq('id', sub.id);
        await supabase.from('organizations').update({ subscription_status: 'past_due' }).eq('id', sub.organization_id);
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
      await supabase.from('subscriptions').update({ status: 'restricted' }).eq('id', sub.id);
      await supabase.from('organizations').update({ subscription_status: 'restricted' }).eq('id', sub.organization_id);
      for (const email of recipients) {
        await sendBillingReminderEmail({ to: email, orgName: org?.name ?? 'your organization', kind: 'restricted' });
      }
    }
  }
}
