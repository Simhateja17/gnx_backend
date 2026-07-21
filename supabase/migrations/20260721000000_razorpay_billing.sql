-- Repurpose subscriptions for Razorpay one-time-charge billing (not true
-- auto-recurring subscriptions — see backend/API_CONTRACT.md discussion).
-- stripe_customer_id/stripe_subscription_id were never populated by any
-- code path, safe to drop.
ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS razorpay_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_period IN ('monthly', 'annual')),
  ADD COLUMN IF NOT EXISTS grace_ends_at TIMESTAMPTZ;

-- subscriptions.status / organizations.subscription_status vocabulary from
-- here on: 'trialing' | 'active' | 'past_due' | 'restricted' | 'canceled'.
-- ('past_due' = grace period, full access; 'restricted' = grace expired.)

-- One row per Razorpay Order/Payment attempt — one-time charges have no
-- single persistent subscription id to key off of like Stripe would.
CREATE TABLE billing_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  razorpay_order_id TEXT UNIQUE NOT NULL,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  plan_id TEXT NOT NULL,
  billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'attempted', 'paid', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_billing_charges_org ON billing_charges(organization_id);

ALTER TABLE billing_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_charge_org_isolation ON billing_charges USING (organization_id = current_setting('app.current_org_id', true)::UUID);
