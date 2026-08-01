import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_CURRENCY: 'USD',
    RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED: true,
    RAZORPAY_PLAN_STARTER_MONTHLY_AMOUNT: 5900,
    RAZORPAY_PLAN_STARTER_ANNUAL_TOTAL_AMOUNT: 58800,
    RAZORPAY_PLAN_GROWTH_MONTHLY_AMOUNT: 17900,
    RAZORPAY_PLAN_GROWTH_ANNUAL_TOTAL_AMOUNT: 178800,
    RAZORPAY_PLAN_SCALE_MONTHLY_AMOUNT: 47900,
    RAZORPAY_PLAN_SCALE_ANNUAL_TOTAL_AMOUNT: 478800,
    BILLING_GRACE_PERIOD_DAYS: 7,
  },
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
  razorpayClient: {
    orders: { create: vi.fn(), fetchPayments: vi.fn() },
    payments: { fetch: vi.fn() },
  },
  verifyCheckout: vi.fn(),
  verifyWebhook: vi.fn(),
}));

vi.mock('../config/env', () => ({ env: mocks.env }));
vi.mock('../lib/supabase', () => ({ supabase: mocks.supabase }));
vi.mock('../lib/razorpay', () => ({
  getRazorpayClient: () => mocks.razorpayClient,
  verifyRazorpayCheckoutSignature: mocks.verifyCheckout,
  verifyRazorpayWebhookSignature: mocks.verifyWebhook,
}));
vi.mock('../lib/resend', () => ({ sendBillingReminderEmail: vi.fn() }));
vi.mock('../lib/posthog', () => ({ posthog: { capture: vi.fn() } }));

import { buildReceipt, createOrder, getPlanAmount, verifyCheckoutSignature } from './billing.service';

function builder(result: { data?: unknown; error?: unknown } = {}) {
  const chain: any = {
    data: result.data ?? null,
    error: result.error ?? null,
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: chain.data, error: chain.error })),
  };
  return chain;
}

describe('billing service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED = true;
    mocks.supabase.from.mockReturnValue(builder());
    mocks.supabase.rpc.mockResolvedValue({ data: [{ already_paid: false }], error: null });
    mocks.razorpayClient.orders.create.mockResolvedValue({ id: 'order_1' });
    mocks.razorpayClient.payments.fetch.mockResolvedValue({
      id: 'pay_1',
      order_id: 'order_1',
      amount: 58800,
      currency: 'USD',
      status: 'captured',
      captured: true,
    });
    mocks.verifyCheckout.mockReturnValue(true);
  });

  it('uses the full annual total rather than the monthly display price', () => {
    expect(getPlanAmount('starter', 'annual')).toBe(58800);
    expect(getPlanAmount('growth', 'annual')).toBe(178800);
  });

  it('generates unique receipts within Razorpay’s length limit', () => {
    const first = buildReceipt();
    const second = buildReceipt();

    expect(first).not.toBe(second);
    expect(first).toHaveLength(40);
    expect(second).toHaveLength(40);
  });

  it('refuses USD checkout until international payments are explicitly enabled', async () => {
    mocks.env.RAZORPAY_INTERNATIONAL_PAYMENTS_ENABLED = false;

    await expect(createOrder('org_1', 'starter', 'monthly')).rejects.toMatchObject({ status: 503 });
    expect(mocks.razorpayClient.orders.create).not.toHaveBeenCalled();
  });

  it('requires a captured, matching payment before finalizing the charge', async () => {
    const charge = {
      id: 'charge_1',
      organization_id: 'org_1',
      razorpay_order_id: 'order_1',
      razorpay_payment_id: null,
      amount: 58800,
      currency: 'USD',
      plan_id: 'starter',
      billing_period: 'annual',
      status: 'created',
    };
    mocks.supabase.from.mockReturnValue(builder({ data: charge }));

    await verifyCheckoutSignature('org_1', {
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'signature',
    });

    expect(mocks.razorpayClient.payments.fetch).toHaveBeenCalledWith('pay_1');
    expect(mocks.supabase.rpc).toHaveBeenCalledWith('finalize_billing_charge', expect.objectContaining({
      p_charge_id: 'charge_1',
      p_razorpay_payment_id: 'pay_1',
    }));
  });

  it('does not replay a previously paid charge', async () => {
    const charge = {
      id: 'charge_1',
      organization_id: 'org_1',
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      amount: 58800,
      currency: 'USD',
      plan_id: 'starter',
      billing_period: 'annual',
      status: 'paid',
    };
    mocks.supabase.from.mockReturnValue(builder({ data: charge }));

    await expect(verifyCheckoutSignature('org_1', {
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'signature',
    })).resolves.toEqual({ success: true, planId: 'starter' });

    expect(mocks.razorpayClient.payments.fetch).not.toHaveBeenCalled();
    expect(mocks.supabase.rpc).not.toHaveBeenCalled();
  });
});
