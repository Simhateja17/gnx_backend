-- Global platform settings, key-value. Used as a runtime kill switch for
-- automatic Retell phone-number provisioning while pre-launch testing in
-- Razorpay test mode kept triggering real, billable number purchases.
CREATE TABLE IF NOT EXISTS public.settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
-- No policies: this table is platform-global, not org-scoped. Only the
-- backend service-role client reads/writes it (RLS-bypassing), so no
-- authenticated/anon policy is defined.

INSERT INTO public.settings (key, value)
VALUES ('auto_provision_phone_number', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
