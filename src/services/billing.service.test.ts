import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: 'webhook_secret',
    RAZORPAY_CURRENCY: 'USD',
    RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED: true,
    RAZORPAY_PLAN_STARTER_MONTHLY_AMOUNT: 5900,
    RAZORPAY_PLAN_STARTER_ANNUAL_TOTAL_AMOUNT: 58800,
    RAZORPAY_PLAN_GROWTH_MONTHLY_AMOUNT: 17900,
    RAZORPAY_PLAN_GROWTH_ANNUAL_TOTAL_AMOUNT: 178800,
    RAZORPAY_PLAN_SCALE_MONTHLY_AMOUNT: 47900,
    RAZORPAY_PLAN_SCALE_ANNUAL_TOTAL_AMOUNT: 478800,
    RAZORPAY_SUBSCRIPTION_PLAN_STARTER_MONTHLY_ID: 'plan_starter_monthly',
    RAZORPAY_SUBSCRIPTION_PLAN_STARTER_ANNUAL_ID: 'plan_starter_annual',
    RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_MONTHLY_ID: 'plan_growth_monthly',
    RAZORPAY_SUBSCRIPTION_PLAN_GROWTH_ANNUAL_ID: 'plan_growth_annual',
    RAZORPAY_SUBSCRIPTION_PLAN_SCALE_MONTHLY_ID: 'plan_scale_monthly',
    RAZORPAY_SUBSCRIPTION_PLAN_SCALE_ANNUAL_ID: 'plan_scale_annual',
    BILLING_GRACE_PERIOD_DAYS: 7,
  },
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
  razorpayClient: {
    subscriptions: { create: vi.fn(), fetch: vi.fn(), update: vi.fn(), cancel: vi.fn() },
    payments: { fetch: vi.fn() },
  },
  verifySubscription: vi.fn(),
  verifyWebhook: vi.fn(),
}));

vi.mock('../config/env', () => ({ env: mocks.env }));
vi.mock('../lib/supabase', () => ({ supabase: mocks.supabase }));
vi.mock('../lib/razorpay', () => ({
  getRazorpayClient: () => mocks.razorpayClient,
  verifyRazorpaySubscriptionSignature: mocks.verifySubscription,
  verifyRazorpayWebhookSignature: mocks.verifyWebhook,
}));
vi.mock('../lib/resend', () => ({ sendBillingReminderEmail: vi.fn() }));
vi.mock('../lib/posthog', () => ({ posthog: { capture: vi.fn() } }));
vi.mock('./retell-phone.service', () => ({
  provisionIncludedRetellPhoneNumber: vi.fn().mockResolvedValue({ status: 'active', phoneNumber: '+14155550100', country: 'US', numberType: 'local' }),
}));

import {
  changeSubscription,
  createSubscription,
  getPlanAmount,
  getRazorpayPlanId,
  handleRazorpayWebhook,
  verifyCheckoutSignature,
} from './billing.service';

function builder(result: { data?: unknown; error?: unknown } = {}) {
  const chain: any = {
    data: result.data ?? null,
    error: result.error ?? null,
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: chain.data, error: chain.error })),
    single: vi.fn(async () => ({ data: chain.data, error: chain.error })),
  };
  return chain;
}

const providerSubscription = {
  id: 'sub_1',
  plan_id: 'plan_starter_annual',
  status: 'active',
  current_start: 1_754_000_000,
  current_end: 1_756_600_000,
  has_scheduled_changes: false,
};

describe('billing service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED = true;
    mocks.supabase.from.mockReturnValue(builder());
    mocks.supabase.rpc.mockResolvedValue({ data: true, error: null });
    mocks.razorpayClient.subscriptions.create.mockResolvedValue({ id: 'sub_1', status: 'created' });
    mocks.razorpayClient.subscriptions.fetch.mockResolvedValue(providerSubscription);
    mocks.razorpayClient.subscriptions.update.mockResolvedValue(providerSubscription);
    mocks.razorpayClient.subscriptions.cancel.mockResolvedValue({ ...providerSubscription, status: 'active' });
    mocks.razorpayClient.payments.fetch.mockResolvedValue({
      id: 'pay_1',
      subscription_id: 'sub_1',
      amount: 58800,
      currency: 'USD',
      status: 'captured',
    });
    mocks.verifySubscription.mockReturnValue(true);
    mocks.verifyWebhook.mockReturnValue(true);
  });

  it('uses the full annual total rather than the monthly display price', () => {
    expect(getPlanAmount('starter', 'annual')).toBe(58800);
    expect(getPlanAmount('growth', 'annual')).toBe(178800);
  });

  it('requires an account-owned Razorpay Plan ID', () => {
    expect(getRazorpayPlanId('starter', 'annual')).toBe('plan_starter_annual');
    expect(() => getRazorpayPlanId('starter', 'quarterly')).toThrowError(/not configured/);
  });

  it('creates a ten-year recurring subscription, not a one-time Order', async () => {
    await createSubscription('org_1', 'starter', 'annual');

    expect(mocks.razorpayClient.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_starter_annual',
      total_count: 10,
      customer_notify: true,
    }));
    expect(mocks.supabase.from).toHaveBeenCalledWith('subscriptions');
  });

  it('verifies the subscription callback and applies the provider snapshot', async () => {
    const localSubscription = {
      organization_id: 'org_1',
      razorpay_subscription_id: 'sub_1',
      razorpay_plan_id: 'plan_starter_annual',
      plan_id: 'starter',
      billing_period: 'annual',
      status: 'created',
    };
    mocks.supabase.from.mockReturnValue(builder({ data: localSubscription }));

    await verifyCheckoutSignature('org_1', {
      razorpay_subscription_id: 'sub_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'signature',
    });

    expect(mocks.verifySubscription).toHaveBeenCalledWith('sub_1', 'pay_1', 'signature');
    expect(mocks.razorpayClient.subscriptions.fetch).toHaveBeenCalledWith('sub_1');
    expect(mocks.supabase.rpc).toHaveBeenCalledWith('apply_razorpay_subscription_event', expect.objectContaining({
      p_organization_id: 'org_1',
      p_razorpay_subscription_id: 'sub_1',
      p_payment_id: 'pay_1',
    }));
  });

  it('accepts verified subscription webhooks idempotently through the event RPC', async () => {
    const localSubscription = {
      organization_id: 'org_1',
      razorpay_subscription_id: 'sub_1',
      razorpay_plan_id: 'plan_starter_annual',
      plan_id: 'starter',
      billing_period: 'annual',
      status: 'active',
      cancel_at_cycle_end: false,
    };
    mocks.supabase.from.mockReturnValue(builder({ data: localSubscription }));

    const body = JSON.stringify({
      id: 'evt_1',
      event: 'subscription.charged',
      payload: {
        subscription: { entity: providerSubscription },
        payment: { entity: { id: 'pay_1', amount: 58800, currency: 'USD' } },
      },
    });

    await handleRazorpayWebhook(Buffer.from(body), 'signature');

    expect(mocks.verifyWebhook).toHaveBeenCalled();
    expect(mocks.supabase.rpc).toHaveBeenCalledWith('apply_razorpay_subscription_event', expect.objectContaining({
      p_event_key: 'evt_1',
      p_event_type: 'subscription.charged',
      p_amount: 58800,
    }));
  });

  it('schedules a downgrade at cycle end', async () => {
    const localSubscription = {
      organization_id: 'org_1',
      razorpay_subscription_id: 'sub_1',
      razorpay_plan_id: 'plan_growth_annual',
      plan_id: 'growth',
      billing_period: 'annual',
      status: 'active',
    };
    mocks.supabase.from.mockReturnValue(builder({ data: localSubscription }));

    const result = await changeSubscription('org_1', 'starter', 'annual');

    expect(result.change).toBe('cycle_end');
    expect(mocks.razorpayClient.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({
      plan_id: 'plan_starter_annual',
      schedule_change_at: 'cycle_end',
    }));
  });
});
