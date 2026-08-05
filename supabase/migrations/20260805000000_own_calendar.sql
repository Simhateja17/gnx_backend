-- Replaces the unused Google Calendar OAuth integration with an
-- org-owned calendar: availability rules + real-time booking by the
-- voice agent, no external OAuth dependency.

CREATE TABLE public.calendar_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID UNIQUE NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  -- 0=Sunday .. 6=Saturday
  working_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  day_start_time TIME NOT NULL DEFAULT '09:00',
  day_end_time TIME NOT NULL DEFAULT '17:00',
  meeting_duration_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (meeting_duration_minutes BETWEEN 5 AND 240),
  buffer_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (buffer_minutes BETWEEN 0 AND 120),
  min_notice_minutes INTEGER NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  booking_window_days SMALLINT NOT NULL DEFAULT 14 CHECK (booking_window_days BETWEEN 1 AND 90),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (day_start_time < day_end_time)
);

ALTER TABLE public.calendar_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY calendar_settings_org_isolation ON public.calendar_settings
  FOR ALL
  USING (organization_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_settings TO service_role;

-- Google-specific columns are dead: the OAuth flow was never wired into the
-- frontend, so nothing in production depends on them.
DROP INDEX IF EXISTS meetings_provider_event_uidx;

ALTER TABLE public.meetings
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS provider_calendar_id,
  DROP COLUMN IF EXISTS provider_event_id,
  DROP COLUMN IF EXISTS external_etag,
  DROP COLUMN IF EXISTS conference_url,
  DROP COLUMN IF EXISTS last_synced_at,
  ADD COLUMN IF NOT EXISTS attendee_phone TEXT,
  ADD COLUMN IF NOT EXISTS call_id UUID REFERENCES public.calls(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS meetings_call_idx ON public.meetings (call_id);

-- Slots are always generated on a fixed (duration + buffer) grid from
-- calendar_settings, so two valid slots either share an exact start instant
-- or don't overlap at all - making exact-timestamp uniqueness sufficient to
-- prevent double-booking without a broader overlap check.
DROP INDEX IF EXISTS idx_meetings_org_scheduled;
CREATE UNIQUE INDEX meetings_org_scheduled_active_uidx
  ON public.meetings (organization_id, scheduled_at)
  WHERE status = 'scheduled';

DROP TABLE IF EXISTS public.calendar_connections;
