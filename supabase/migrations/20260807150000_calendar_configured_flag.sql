-- The setup checklist and product tour need to know whether a customer has
-- explicitly saved their availability, not just that a row exists — every
-- organization gets a calendar_settings row with sane-but-generic defaults
-- (America/New_York, 9-5, Mon-Fri) the first time it's read, whether or not
-- anyone ever opens the Calendar page. Row existence alone can't distinguish
-- "the agent is booking on a guessed timezone" from "the customer confirmed
-- this is right."
ALTER TABLE public.calendar_settings
  ADD COLUMN IF NOT EXISTS is_configured BOOLEAN NOT NULL DEFAULT false;

-- Best-effort backfill: an org whose settings were already updated after
-- creation clearly made a deliberate change before this column existed.
UPDATE public.calendar_settings
SET is_configured = true
WHERE updated_at > created_at;
