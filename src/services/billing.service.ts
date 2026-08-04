import { createHash, randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase';
import {
  getRazorpayClient,
  verifyRazorpaySubscriptionSignature,
  verifyRazorpayWebhookSignature,
} from '../lib/razorpay';
import { sendBillingReminderEmail } from '../lib/resend';
import { posthog } from '../lib/posthog';
import { env } from '../config/env';
import { AppError } from '../types';

export type PlanId = 'starter' | 'growth' | 'scale';
export type BillingPeriod = 'monthly' | 'annual';

const PLAN_AMOUNTS: Record<PlanId, Record<BillingPeriod, number>> = {
  starter: { monthly: env.RAZORPAY_PLAN_STARTER_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_STARTER_ANNUAL_TOTAL_AMOUNT },
  growth: { monthly: env.RAZORPAY_PLAN_GROWTH_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_GROWTH_ANNUAL_TOTAL_AMOUNT },
  scale: { monthly: env.RAZORPAY_PLAN_SCALE_MONTHLY_AMOUNT, annual: env.RAZORPAY_PLAN_SCALE_ANNUAL_TOTAL_AMOUNT },
};

const PLAN_PROVIDER_IDS: Record<PlanId, Record<BillingPeriod, string>> = {
  starter: {
    monthly: env.RAZORPAY_SUBSCRIPTION_PLAN_STARTER_MONTHLY_ID,
    annual: env.RAZORPAY_SUBSCRIPTION_PLAN_STARTER_ANNUAL_ID,
  },
  growth: {
    monthly: env.RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_MONTHLY_ID,
    annual: env.RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_ANNUAL_ID,
  },
  scale: {
    monthly: env.RAZORPAY_SUBSCRIPTION_PLAN_SCALE_MONTHLY_ID,
    annual: env.RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID,
  },
};

const TOTAL_CYCLES: Record<BillingPeriod, number> = { monthly: 120, annual: 10 };
const PLAN_RANK: Record<PlanId, number> = { starter: 1, growth: 2, scale: 3 };

type ProviderSubscriptionStatus = 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired';

export function getPlanAmount(planId: string, billingPeriod: string): number {
  const amounts = PLAN_AMOUNTS[planId as PlanId];
  if (!amounts) throw new AppError(400, `Unknown plan: ${planId}`);
  const amount = amounts[billingPeriod as BillingPeriod];
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError(500, `Pricing is not configured for ${planId}/${billingPeriod}`);
  }
  return amount;
}

export function getRazorpayPlanId(planId: string, billingPeriod: string): string {
  if (!PLAN_AMOUNTS[planId as PlanId]) throw new AppError(400, `Unknown plan: ${planId}`);
  const providerId = PLAN_PROVIDER_IDS[planId as PlanId]?.[billingPeriod as BillingPeriod];
  if (!providerId) {
    throw new AppError(503, `Razorpay recurring plan is not configured for ${planId}/${billingPeriod}`);
  }
  return providerId;
}

function resolvePlan(providerPlanId: string | undefined, fallbackPlanId?: string, fallbackPeriod?: string) {
  for (const planId of Object.keys(PLAN_PROVIDER_IDS) as PlanId[]) {
    for (const billingPeriod of ['monthly', 'annual'] as BillingPeriod[]) {
      if (providerPlanId && PLAN_PROVIDER_IDS[planId][billingPeriod] === providerPlanId) {
        return { planId, billingPeriod };
      }
    }
  }

  if (fallbackPlanId && fallbackPeriod && PLAN_AMOUNTS[fallbackPlanId as PlanId]?.[fallbackPeriod as BillingPeriod]) {
    return { planId: fallbackPlanId as PlanId, billingPeriod: fallbackPeriod as BillingPeriod };
  }
  return { planId: 'starter' as PlanId, billingPeriod: 'monthly' as BillingPeriod };
}

function providerStatusToOrganizationStatus(status: string): string {
  if (status === 'active' || status === 'authenticated') return 'active';
  if (status === 'pending') return 'past_due';
  if (['halted', 'cancelled', 'completed', 'expired'].includes(status)) return 'restricted';
  return 'payment_required';
}

function unixToIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function getWebhookEventKey(payload: any, rawBody: string): string {
  if (payload?.id) return String(payload.id);
  return `body_${createHash('sha256').update(rawBody).digest('hex')}`;
}

function assertInternationalPaymentsEnabled() {
  if (env.RAZORPAY_CURRENCY !== 'INR' && !env.RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED) {
    throw new AppError(503, 'International payments are not enabled for this Razorpay account');
  }
}

export function buildReceipt(): string {
  // Kept for legacy charge records; new subscription checkout does not use an
  // Order or receipt.
  return `org_${randomUUID()}`;
}

export async function getSubscriptionForOrganization(organizationId: string) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load subscription');
  return data;
}

async function saveCreatedSubscription(
  organizationId: string,
  planId: PlanId,
  billingPeriod: BillingPeriod,
  subscription: any,
) {
  const { error } = await supabase.from('subscriptions').upsert({
    organization_id: organizationId,
    razorpay_subscription_id: subscription.id,
    razorpay_plan_id: getRazorpayPlanId(planId, billingPeriod),
    plan_id: planId,
    billing_period: billingPeriod,
    status: subscription.status ?? 'created',
    current_period_start: unixToIso(subscription.current_start),
    current_period_end: unixToIso(subscription.current_end),
    grace_ends_at: null,
    cancel_at_cycle_end: false,
    scheduled_plan_id: null,
    scheduled_billing_period: null,
    scheduled_razorpay_plan_id: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'organization_id' });
  if (error) throw new AppError(500, 'Failed to record the Razorpay subscription');

  const { error: orgError } = await supabase
    .from('organizations')
    .update({
      plan_id: planId,
      subscription_status: providerStatusToOrganizationStatus(subscription.status ?? 'created'),
      updated_at: new Date().toISOString(),
    })
    .eq('id', organizationId);
  if (orgError) throw new AppError(500, 'Failed to update billing status');
}

export async function createSubscription(organizationId: string, planId: PlanId, billingPeriod: BillingPeriod) {
  assertInternationalPaymentsEnabled();
  const providerPlanId = getRazorpayPlanId(planId, billingPeriod);
  const existing = await getSubscriptionForOrganization(organizationId);

  if (existing?.razorpay_subscription_id && existing.razorpay_plan_id === providerPlanId && ['created', 'authenticated'].includes(existing.status)) {
    return {
      subscriptionId: existing.razorpay_subscription_id,
      planId,
      billingPeriod,
      currency: env.RAZORPAY_CURRENCY,
      keyId: env.RAZORPAY_KEY_ID,
      totalCount: TOTAL_CYCLES[billingPeriod],
    };
  }

  if (existing?.razorpay_subscription_id && ['active', 'authenticated', 'pending'].includes(existing.status)) {
    throw new AppError(409, 'This organization already has a subscription. Use Billing to change the plan.');
  }

  const razorpay = getRazorpayClient() as any;
  let subscription: any;
  try {
    subscription = await razorpay.subscriptions.create({
      plan_id: providerPlanId,
      total_count: TOTAL_CYCLES[billingPeriod],
      quantity: 1,
      customer_notify: true,
      notes: { organizationId, planId, billingPeriod },
    });
  } catch (error) {
    throw new AppError(502, 'Razorpay could not create the subscription', error);
  }

  await saveCreatedSubscription(organizationId, planId, billingPeriod, subscription);

  return {
    subscriptionId: subscription.id,
    planId,
    billingPeriod,
    currency: env.RAZORPAY_CURRENCY,
    keyId: env.RAZORPAY_KEY_ID,
    totalCount: TOTAL_CYCLES[billingPeriod],
  };
}

type SubscriptionEventInput = {
  eventKey: string;
  eventType: string;
  organizationId: string;
  subscriptionId: string;
  providerPlanId?: string;
  planId?: string;
  billingPeriod?: BillingPeriod;
  providerStatus: ProviderSubscriptionStatus;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  graceEndsAt?: string | null;
  cancelAtCycleEnd?: boolean;
  paymentId?: string | null;
  invoiceId?: string | null;
  amount?: number | null;
  currency?: string | null;
  payload: any;
};

async function applySubscriptionEvent(input: SubscriptionEventInput) {
  const { data, error } = await supabase.rpc('apply_razorpay_subscription_event', {
    p_event_key: input.eventKey,
    p_event_type: input.eventType,
    p_organization_id: input.organizationId,
    p_razorpay_subscription_id: input.subscriptionId,
    p_razorpay_plan_id: input.providerPlanId ?? null,
    p_plan_id: input.planId ?? null,
    p_billing_period: input.billingPeriod ?? null,
    p_provider_status: input.providerStatus,
    p_current_period_start: input.currentPeriodStart ?? null,
    p_current_period_end: input.currentPeriodEnd ?? null,
    p_grace_ends_at: input.graceEndsAt ?? null,
    p_cancel_at_cycle_end: input.cancelAtCycleEnd ?? false,
    p_payment_id: input.paymentId ?? null,
    p_invoice_id: input.invoiceId ?? null,
    p_amount: input.amount ?? null,
    p_currency: input.currency ?? null,
    p_payload: input.payload,
  });
  if (error) throw new AppError(500, 'Failed to apply the subscription event');
  return { alreadyProcessed: data === false || (Array.isArray(data) && data[0] === false) };
}

export async function verifyCheckoutSignature(
  organizationId: string,
  payload: { razorpay_subscription_id: string; razorpay_payment_id: string; razorpay_signature: string },
) {
  const { data: subscription, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('razorpay_subscription_id', payload.razorpay_subscription_id)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load the subscription');
  if (!subscription) throw new AppError(404, 'Subscription not found');

  const valid = verifyRazorpaySubscriptionSignature(
    payload.razorpay_subscription_id,
    payload.razorpay_payment_id,
    payload.razorpay_signature,
  );
  if (!valid) throw new AppError(401, 'Invalid payment signature');

  const razorpay = getRazorpayClient() as any;
  let providerSubscription: any;
  let payment: any;
  try {
    [providerSubscription, payment] = await Promise.all([
      razorpay.subscriptions.fetch(payload.razorpay_subscription_id),
      razorpay.payments.fetch(payload.razorpay_payment_id),
    ]);
  } catch (providerError) {
    throw new AppError(502, 'Razorpay could not confirm the subscription payment', providerError);
  }

  if (providerSubscription.id !== payload.razorpay_subscription_id) {
    throw new AppError(400, 'Subscription does not match the payment response');
  }
  if (payment?.subscription_id && payment.subscription_id !== payload.razorpay_subscription_id) {
    throw new AppError(400, 'Payment does not belong to this subscription');
  }
  if (subscription.razorpay_plan_id && providerSubscription.plan_id !== subscription.razorpay_plan_id) {
    throw new AppError(400, 'Subscription plan does not match the selected plan');
  }

  const resolvedPlan = resolvePlan(providerSubscription.plan_id, subscription.plan_id, subscription.billing_period);
  if (payment?.amount && Number(payment.amount) !== getPlanAmount(resolvedPlan.planId, resolvedPlan.billingPeriod)) {
    throw new AppError(400, 'Payment amount does not match the configured plan price');
  }
  if (payment?.currency && payment.currency !== env.RAZORPAY_CURRENCY) {
    throw new AppError(400, 'Payment currency does not match the configured currency');
  }
  const status = (providerSubscription.status ?? 'authenticated') as ProviderSubscriptionStatus;
  const graceEndsAt = status === 'pending'
    ? new Date(Date.now() + env.BILLING_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await applySubscriptionEvent({
    eventKey: `checkout:${payload.razorpay_subscription_id}:${payload.razorpay_payment_id}`,
    eventType: 'subscription.authenticated',
    organizationId,
    subscriptionId: payload.razorpay_subscription_id,
    providerPlanId: providerSubscription.plan_id,
    planId: resolvedPlan.planId,
    billingPeriod: resolvedPlan.billingPeriod,
    providerStatus: status,
    currentPeriodStart: unixToIso(providerSubscription.current_start),
    currentPeriodEnd: unixToIso(providerSubscription.current_end),
    graceEndsAt,
    cancelAtCycleEnd: Boolean(providerSubscription.has_scheduled_changes),
    paymentId: payment?.id ?? payload.razorpay_payment_id,
    amount: payment?.amount ? Number(payment.amount) : null,
    currency: payment?.currency ?? env.RAZORPAY_CURRENCY,
    payload: { subscription: providerSubscription, payment },
  });

  posthog?.capture({
    distinctId: organizationId,
    event: 'billing_subscription_verified',
    properties: { planId: resolvedPlan.planId, billingPeriod: resolvedPlan.billingPeriod },
  });

  return {
    success: true,
    pending: !['active', 'authenticated'].includes(status),
    planId: resolvedPlan.planId,
    billingPeriod: resolvedPlan.billingPeriod,
    subscriptionStatus: providerStatusToOrganizationStatus(status),
  };
}

export async function changeSubscription(organizationId: string, planId: PlanId, billingPeriod: BillingPeriod) {
  assertInternationalPaymentsEnabled();
  const current = await getSubscriptionForOrganization(organizationId);
  if (!current?.razorpay_subscription_id) throw new AppError(409, 'Complete billing before changing the plan.');

  const newProviderPlanId = getRazorpayPlanId(planId, billingPeriod);
  if (current.razorpay_plan_id === newProviderPlanId) {
    return { success: true, change: 'none', planId: current.plan_id, billingPeriod: current.billing_period };
  }

  if (!['active', 'authenticated', 'pending', 'halted'].includes(current.status)) {
    throw new AppError(409, 'This subscription is not available for a plan change.');
  }

  const isUpgrade = PLAN_RANK[planId] > PLAN_RANK[current.plan_id as PlanId]
    || (planId === current.plan_id && billingPeriod === 'annual' && current.billing_period === 'monthly');
  const scheduleChangeAt = isUpgrade ? 'now' : 'cycle_end';
  const razorpay = getRazorpayClient() as any;
  let providerSubscription: any;
  let currentProviderSubscription: any;
  try {
    currentProviderSubscription = await razorpay.subscriptions.fetch(current.razorpay_subscription_id);
    providerSubscription = await razorpay.subscriptions.update(current.razorpay_subscription_id, {
      plan_id: newProviderPlanId,
      remaining_count: Number(currentProviderSubscription.remaining_count ?? 0) || undefined,
      schedule_change_at: scheduleChangeAt,
      customer_notify: true,
    });
  } catch (providerError) {
    throw new AppError(502, 'Razorpay could not update the subscription', providerError);
  }

  if (scheduleChangeAt === 'now') {
    const { error } = await supabase.from('subscriptions').update({
      plan_id: planId,
      billing_period: billingPeriod,
      razorpay_plan_id: newProviderPlanId,
      scheduled_plan_id: null,
      scheduled_billing_period: null,
      scheduled_razorpay_plan_id: null,
      status: providerSubscription.status ?? current.status,
      updated_at: new Date().toISOString(),
    }).eq('organization_id', organizationId);
    if (error) throw new AppError(500, 'Failed to save the plan change');
    await supabase.from('organizations').update({ plan_id: planId, updated_at: new Date().toISOString() }).eq('id', organizationId);
  } else {
    const { error } = await supabase.from('subscriptions').update({
      scheduled_plan_id: planId,
      scheduled_billing_period: billingPeriod,
      scheduled_razorpay_plan_id: newProviderPlanId,
      updated_at: new Date().toISOString(),
    }).eq('organization_id', organizationId);
    if (error) throw new AppError(500, 'Failed to save the scheduled plan change');
  }

  return {
    success: true,
    change: scheduleChangeAt === 'now' ? 'immediate' : 'cycle_end',
    planId: scheduleChangeAt === 'now' ? planId : current.plan_id,
    billingPeriod: scheduleChangeAt === 'now' ? billingPeriod : current.billing_period,
    scheduledPlanId: scheduleChangeAt === 'cycle_end' ? planId : null,
  };
}

export async function cancelSubscription(organizationId: string) {
  const current = await getSubscriptionForOrganization(organizationId);
  if (!current?.razorpay_subscription_id) throw new AppError(409, 'No active Razorpay subscription was found.');
  if (current.cancel_at_cycle_end) return { success: true, cancelAtCycleEnd: true };

  try {
    await (getRazorpayClient() as any).subscriptions.cancel(current.razorpay_subscription_id, true);
  } catch (providerError) {
    throw new AppError(502, 'Razorpay could not schedule the cancellation', providerError);
  }

  const { error } = await supabase.from('subscriptions').update({
    cancel_at_cycle_end: true,
    updated_at: new Date().toISOString(),
  }).eq('organization_id', organizationId);
  if (error) throw new AppError(500, 'Failed to save the cancellation');

  return { success: true, cancelAtCycleEnd: true };
}

async function fetchCapturedPayment(orderId: string, paymentId: string | undefined, expectedAmount: number, expectedCurrency: string) {
  const razorpay = getRazorpayClient() as any;
  const payment = paymentId
    ? await razorpay.payments.fetch(paymentId)
    : (await razorpay.orders.fetchPayments(orderId)).items.find((candidate: any) => (
      candidate.status === 'captured'
      && candidate.order_id === orderId
      && Number(candidate.amount) === expectedAmount
      && candidate.currency === expectedCurrency
    ));

  if (!payment) throw new AppError(409, 'No captured payment was found for this order');
  if (payment.order_id !== orderId) throw new AppError(400, 'Payment does not belong to this order');
  if (Number(payment.amount) !== expectedAmount || payment.currency !== expectedCurrency) {
    throw new AppError(400, 'Payment amount or currency does not match the order');
  }
  if (payment.status !== 'captured' || payment.captured === false) throw new AppError(409, 'Payment has not been captured yet');
  return payment;
}

async function finalizeLegacyBillingCharge(charge: any, paymentId: string, signature?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('finalize_billing_charge', {
    p_charge_id: charge.id,
    p_organization_id: charge.organization_id,
    p_razorpay_payment_id: paymentId,
    p_razorpay_signature: signature ?? null,
  });
  if (error) throw new AppError(500, 'Failed to activate the paid plan');
  const result = Array.isArray(data) ? data[0] : data;
  return result?.already_paid === true;
}

async function handleLegacyPaymentWebhook(event: string, paymentEntity: any, orderEntity: any) {
  const razorpayOrderId: string | undefined = paymentEntity?.order_id ?? orderEntity?.id;
  if (!razorpayOrderId) return;

  const { data: charge, error } = await supabase
    .from('billing_charges')
    .select('id, organization_id, razorpay_order_id, razorpay_payment_id, amount, currency, plan_id, billing_period, status')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load the legacy billing charge');
  if (!charge || charge.status === 'paid') return;

  if (event === 'payment.authorized') {
    const { error: updateError } = await supabase.from('billing_charges').update({
      status: 'attempted',
      updated_at: new Date().toISOString(),
    }).eq('id', charge.id).neq('status', 'paid');
    if (updateError) throw new AppError(500, 'Failed to record payment authorization');
    return;
  }

  if (event === 'payment.captured' || event === 'order.paid') {
    const payment = await fetchCapturedPayment(razorpayOrderId, paymentEntity?.id, Number(charge.amount), charge.currency);
    await finalizeLegacyBillingCharge(charge, payment.id);
    return;
  }

  if (event === 'payment.failed') {
    const { error: updateError } = await supabase.from('billing_charges').update({
      status: 'failed',
      razorpay_payment_id: paymentEntity?.id ?? null,
      updated_at: new Date().toISOString(),
    }).eq('id', charge.id).neq('status', 'paid');
    if (updateError) throw new AppError(500, 'Failed to record payment failure');
  }
}

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.updated',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.completed',
  'subscription.expired',
]);

const EVENT_STATUS: Record<string, ProviderSubscriptionStatus> = {
  'subscription.authenticated': 'authenticated',
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.updated': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
  'subscription.expired': 'expired',
};

export async function handleRazorpayWebhook(rawBody: Buffer, signature: string) {
  const bodyStr = rawBody.toString('utf-8');
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw new AppError(500, 'RAZORPAY_WEBHOOK_SECRET is not configured — refusing to process unverified webhook');
  }
  if (!verifyRazorpayWebhookSignature(bodyStr, signature)) throw new AppError(401, 'Invalid webhook signature');

  let payload: any;
  try {
    payload = JSON.parse(bodyStr);
  } catch {
    throw new AppError(400, 'Invalid webhook payload');
  }
  if (!payload?.event) throw new AppError(400, 'Webhook event is missing');

  const event = String(payload.event);
  const eventKey = getWebhookEventKey(payload, bodyStr);
  const subscriptionEntity = payload.payload?.subscription?.entity;

  if (SUBSCRIPTION_EVENTS.has(event)) {
    const subscriptionId = subscriptionEntity?.id;
    if (!subscriptionId) return;

    const { data: localSubscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('razorpay_subscription_id', subscriptionId)
      .maybeSingle();
    if (error) throw new AppError(500, 'Failed to load the subscription for the webhook');
    if (!localSubscription) return; // A subscription created outside this app.

    const resolvedPlan = resolvePlan(
      subscriptionEntity.plan_id,
      localSubscription.scheduled_plan_id ?? localSubscription.plan_id,
      localSubscription.scheduled_billing_period ?? localSubscription.billing_period,
    );
    const providerStatus = (subscriptionEntity.status ?? EVENT_STATUS[event]) as ProviderSubscriptionStatus;
    const paymentEntity = payload.payload?.payment?.entity;
    const amount = paymentEntity?.amount ? Number(paymentEntity.amount) : null;
    const currency = paymentEntity?.currency ?? env.RAZORPAY_CURRENCY;

    if (amount !== null && amount !== getPlanAmount(resolvedPlan.planId, resolvedPlan.billingPeriod)) {
      throw new AppError(400, 'Subscription charge amount does not match the configured plan price');
    }
    if (amount !== null && currency !== env.RAZORPAY_CURRENCY) {
      throw new AppError(400, 'Subscription charge currency does not match the configured currency');
    }

    const graceEndsAt = providerStatus === 'pending'
      ? new Date(Date.now() + env.BILLING_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const result = await applySubscriptionEvent({
      eventKey,
      eventType: event,
      organizationId: localSubscription.organization_id,
      subscriptionId,
      providerPlanId: subscriptionEntity.plan_id ?? localSubscription.razorpay_plan_id,
      planId: resolvedPlan.planId,
      billingPeriod: resolvedPlan.billingPeriod,
      providerStatus,
      currentPeriodStart: unixToIso(subscriptionEntity.current_start),
      currentPeriodEnd: unixToIso(subscriptionEntity.current_end),
      graceEndsAt,
      cancelAtCycleEnd: Boolean(subscriptionEntity.has_scheduled_changes || localSubscription.cancel_at_cycle_end),
      paymentId: paymentEntity?.id ?? null,
      invoiceId: paymentEntity?.invoice_id ?? payload.payload?.invoice?.entity?.id ?? null,
      amount,
      currency,
      payload,
    });

    if (event === 'subscription.charged' && !result.alreadyProcessed) {
      posthog?.capture({
        distinctId: localSubscription.organization_id,
        event: 'billing_subscription_charged',
        properties: { planId: resolvedPlan.planId, billingPeriod: resolvedPlan.billingPeriod },
      });
    }
    return;
  }

  if (['payment.authorized', 'payment.captured', 'order.paid', 'payment.failed'].includes(event)) {
    await handleLegacyPaymentWebhook(event, payload.payload?.payment?.entity, payload.payload?.order?.entity);
  }
}

export async function getBillingHistory(organizationId: string) {
  const { data, error } = await supabase
    .from('billing_charges')
    .select('id, plan_id, billing_period, amount, currency, status, created_at, razorpay_subscription_id, razorpay_payment_id')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw new AppError(500, 'Failed to fetch billing history', error);
  return data ?? [];
}

// Razorpay owns renewal timing and emits pending/halted/charged webhooks. The
// worker only closes a missed pending grace period as a fallback; it never
// invents a renewal from current_period_end.
export async function runRenewalCheck() {
  const now = new Date();
  const graceDays = env.BILLING_GRACE_PERIOD_DAYS;
  const { data: subs, error } = await supabase
    .from('subscriptions')
    .select('id, organization_id, grace_ends_at, organizations(name)')
    .in('status', ['pending', 'past_due']);
  if (error) throw new AppError(500, 'Failed to load pending subscriptions');

  for (const sub of subs ?? []) {
    if (!sub.grace_ends_at || new Date(sub.grace_ends_at) >= now) continue;
    const { error: organizationError } = await supabase
      .from('organizations')
      .update({ subscription_status: 'restricted', updated_at: now.toISOString() })
      .eq('id', sub.organization_id);
    if (organizationError) throw new AppError(500, 'Failed to restrict organization after the billing grace period');

    await supabase.from('subscriptions').update({ grace_ends_at: null, updated_at: now.toISOString() }).eq('id', sub.id);

    const org = sub.organizations as any;
    const { data: orgUsers, error: usersError } = await supabase
      .from('users')
      .select('email')
      .eq('organization_id', sub.organization_id);
    if (usersError) throw new AppError(500, 'Failed to load billing contacts');
    for (const email of (orgUsers ?? []).map((user: any) => user.email).filter(Boolean)) {
      await sendBillingReminderEmail({ to: email, orgName: org?.name ?? 'your organization', kind: 'restricted', graceDays });
    }
  }
}
