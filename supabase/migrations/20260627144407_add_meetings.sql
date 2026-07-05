-- Upcoming and completed meetings created by booking/calendar integrations.
-- The application backend is the only Data API consumer for this table.
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Sales meeting',
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  join_url TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'booking_link' CHECK (source IN ('booking_link', 'calendar', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meetings_org_scheduled
  ON meetings (organization_id, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX idx_meetings_lead ON meetings (lead_id);

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY meeting_org_isolation ON meetings
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE meetings TO service_role;
