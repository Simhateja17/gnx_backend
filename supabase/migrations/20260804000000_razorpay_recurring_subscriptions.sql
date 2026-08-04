-- Replace the legacy one-time/order billing shape with Razorpay recurring
-- subscriptions. Plan IDs remain account-owned configuration in Render; the
-- database stores the exact provider IDs used for each organization.

ALTER TABLE organizations
  ALTER COLUMN subscription_status SET DEFAULT 'payment_required';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS billing_manager_user_id UUID;

CREATE INDEX IF NOT EXISTS organizations_billing_manager_idx
  ON organizations (billing_manager_user_id);

-- Existing customer owners were never intended to be separate application
-- roles. Preserve admins; make every other customer a member.
UPDATE users
   SET role = 'member'
 WHERE role IS DISTINCT FROM 'admin';

UPDATE organizations
   SET subscription_status = 'payment_required'
 WHERE subscription_status = 'trialing';

-- The earliest customer row becomes the billing manager for existing orgs.
-- New signups set this explicitly after their member row is created.
WITH first_member AS (
  SELECT DISTINCT ON (organization_id) organization_id, id
    FROM users
   WHERE role = 'member'
   ORDER BY organization_id, created_at ASC, id ASC
)
UPDATE organizations o
   SET billing_manager_user_id = first_member.id
  FROM first_member
 WHERE o.id = first_member.organization_id
   AND o.billing_manager_user_id IS NULL;

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS trial_ends_at,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_billing_period TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_razorpay_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS cancel_at_cycle_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_razorpay_subscription_uidx
  ON subscriptions (razorpay_subscription_id)
 WHERE razorpay_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_provider_status_idx
  ON subscriptions (status, grace_ends_at);

ALTER TABLE billing_charges
  ALTER COLUMN razorpay_order_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT;

CREATE INDEX IF NOT EXISTS billing_charges_subscription_idx
  ON billing_charges (razorpay_subscription_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS billing_charges_provider_event_uidx
  ON billing_charges (provider_event_id)
 WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  razorpay_subscription_id TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_subscription_idx
  ON billing_webhook_events (razorpay_subscription_id, received_at DESC);

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_webhook_events_service_role ON billing_webhook_events;
CREATE POLICY billing_webhook_events_service_role
  ON billing_webhook_events FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- Applies one verified, idempotent provider event. The service verifies the
-- Razorpay signature and resolves the local organization before calling this
-- function; this function then performs the event ledger write, subscription
-- snapshot, entitlement state, and charge insert in one short transaction.
CREATE OR REPLACE FUNCTION public.apply_razorpay_subscription_event(
  p_event_key TEXT,
  p_event_type TEXT,
  p_organization_id UUID,
  p_razorpay_subscription_id TEXT,
  p_razorpay_plan_id TEXT,
  p_plan_id TEXT,
  p_billing_period TEXT,
  p_provider_status TEXT,
  p_current_period_start TIMESTAMPTZ,
  p_current_period_end TIMESTAMPTZ,
  p_grace_ends_at TIMESTAMPTZ,
  p_cancel_at_cycle_end BOOLEAN,
  p_payment_id TEXT,
  p_invoice_id TEXT,
  p_amount INTEGER,
  p_currency TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_event_count INTEGER;
  app_status TEXT;
BEGIN
  INSERT INTO billing_webhook_events (
    event_key,
    event_type,
    organization_id,
    razorpay_subscription_id,
    payload
  ) VALUES (
    p_event_key,
    p_event_type,
    p_organization_id,
    p_razorpay_subscription_id,
    COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT (event_key) DO NOTHING;

  GET DIAGNOSTICS inserted_event_count = ROW_COUNT;
  IF inserted_event_count = 0 THEN
    RETURN FALSE;
  END IF;

  app_status := CASE p_provider_status
    WHEN 'active' THEN 'active'
    WHEN 'authenticated' THEN 'active'
    WHEN 'pending' THEN 'past_due'
    WHEN 'halted' THEN 'restricted'
    WHEN 'cancelled' THEN 'restricted'
    WHEN 'completed' THEN 'restricted'
    WHEN 'expired' THEN 'restricted'
    ELSE 'payment_required'
  END;

  INSERT INTO subscriptions (
    organization_id,
    razorpay_subscription_id,
    razorpay_plan_id,
    plan_id,
    billing_period,
    status,
    current_period_start,
    current_period_end,
    grace_ends_at,
    cancel_at_cycle_end,
    last_webhook_at,
    updated_at
  ) VALUES (
    p_organization_id,
    p_razorpay_subscription_id,
    p_razorpay_plan_id,
    COALESCE(p_plan_id, 'starter'),
    COALESCE(p_billing_period, 'monthly'),
    p_provider_status,
    p_current_period_start,
    p_current_period_end,
    CASE WHEN p_provider_status = 'pending' THEN p_grace_ends_at ELSE NULL END,
    COALESCE(p_cancel_at_cycle_end, FALSE),
    NOW(),
    NOW()
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    razorpay_subscription_id = EXCLUDED.razorpay_subscription_id,
    razorpay_plan_id = EXCLUDED.razorpay_plan_id,
    plan_id = COALESCE(EXCLUDED.plan_id, subscriptions.plan_id),
    billing_period = COALESCE(EXCLUDED.billing_period, subscriptions.billing_period),
    status = EXCLUDED.status,
    current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
    current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
    grace_ends_at = CASE
      WHEN EXCLUDED.status = 'pending' THEN EXCLUDED.grace_ends_at
      WHEN EXCLUDED.status IN ('active', 'authenticated', 'halted', 'cancelled', 'completed', 'expired') THEN NULL
      ELSE subscriptions.grace_ends_at
    END,
    scheduled_plan_id = CASE
      WHEN EXCLUDED.razorpay_plan_id = subscriptions.scheduled_razorpay_plan_id THEN NULL
      ELSE subscriptions.scheduled_plan_id
    END,
    scheduled_billing_period = CASE
      WHEN EXCLUDED.razorpay_plan_id = subscriptions.scheduled_razorpay_plan_id THEN NULL
      ELSE subscriptions.scheduled_billing_period
    END,
    scheduled_razorpay_plan_id = CASE
      WHEN EXCLUDED.razorpay_plan_id = subscriptions.scheduled_razorpay_plan_id THEN NULL
      ELSE subscriptions.scheduled_razorpay_plan_id
    END,
    cancel_at_cycle_end = EXCLUDED.cancel_at_cycle_end,
    last_webhook_at = NOW(),
    updated_at = NOW();

  UPDATE organizations
     SET plan_id = COALESCE(p_plan_id, plan_id),
         subscription_status = app_status,
         updated_at = NOW()
   WHERE id = p_organization_id;

  IF p_payment_id IS NOT NULL AND p_amount IS NOT NULL THEN
    INSERT INTO billing_charges (
      organization_id,
      razorpay_order_id,
      razorpay_payment_id,
      amount,
      currency,
      plan_id,
      billing_period,
      status,
      razorpay_subscription_id,
      razorpay_invoice_id,
      provider_event_id
    ) VALUES (
      p_organization_id,
      NULL,
      p_payment_id,
      p_amount,
      COALESCE(p_currency, 'USD'),
      COALESCE(p_plan_id, 'starter'),
      COALESCE(p_billing_period, 'monthly'),
      'paid',
      p_razorpay_subscription_id,
      p_invoice_id,
      p_event_key
    )
    ON CONFLICT DO NOTHING;
  END IF;

  UPDATE billing_webhook_events
     SET processed_at = NOW()
   WHERE event_key = p_event_key;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_razorpay_subscription_event(
  TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ,
  TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_razorpay_subscription_event(
  TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ,
  TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, JSONB
) TO service_role;
