-- Make payment finalisation idempotent and atomic. The API verifies the
-- captured Razorpay payment first, then this function updates the charge,
-- subscription, and organization in one database transaction.
CREATE UNIQUE INDEX IF NOT EXISTS billing_charges_payment_id_uidx
  ON billing_charges (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.finalize_billing_charge(
  p_charge_id UUID,
  p_organization_id UUID,
  p_razorpay_payment_id TEXT,
  p_razorpay_signature TEXT
)
RETURNS TABLE (already_paid BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  charge_row billing_charges%ROWTYPE;
  period_start TIMESTAMPTZ := NOW();
  period_end TIMESTAMPTZ;
BEGIN
  IF p_razorpay_payment_id IS NULL OR length(trim(p_razorpay_payment_id)) = 0 THEN
    RAISE EXCEPTION 'A Razorpay payment id is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO charge_row
    FROM billing_charges
   WHERE id = p_charge_id
     AND organization_id = p_organization_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing charge not found' USING ERRCODE = 'P0002';
  END IF;

  IF charge_row.status = 'paid' THEN
    RETURN QUERY SELECT TRUE;
    RETURN;
  END IF;

  IF charge_row.status NOT IN ('created', 'attempted', 'failed') THEN
    RAISE EXCEPTION 'Billing charge cannot be finalized from its current state' USING ERRCODE = 'P0001';
  END IF;

  IF charge_row.billing_period = 'annual' THEN
    period_end := period_start + INTERVAL '1 year';
  ELSE
    period_end := period_start + INTERVAL '1 month';
  END IF;

  UPDATE billing_charges
     SET status = 'paid',
         razorpay_payment_id = p_razorpay_payment_id,
         razorpay_signature = p_razorpay_signature,
         updated_at = period_start
   WHERE id = charge_row.id;

  INSERT INTO subscriptions (
    organization_id,
    plan_id,
    status,
    billing_period,
    current_period_start,
    current_period_end,
    grace_ends_at,
    updated_at
  ) VALUES (
    charge_row.organization_id,
    charge_row.plan_id,
    'active',
    charge_row.billing_period,
    period_start,
    period_end,
    NULL,
    period_start
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    plan_id = EXCLUDED.plan_id,
    status = EXCLUDED.status,
    billing_period = EXCLUDED.billing_period,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    grace_ends_at = EXCLUDED.grace_ends_at,
    updated_at = EXCLUDED.updated_at;

  UPDATE organizations
     SET plan_id = charge_row.plan_id,
         subscription_status = 'active',
         updated_at = period_start
   WHERE id = charge_row.organization_id;

  RETURN QUERY SELECT FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_billing_charge(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_billing_charge(UUID, UUID, TEXT, TEXT) TO service_role;
