-- The existing org_isolation policies on support_tickets/support_messages
-- check current_setting('app.current_org_id'), a Postgres session variable
-- that Express's service-role connection sets per request. The browser's
-- direct-to-Supabase Realtime websocket is a different session that variable
-- is never set on, so those rows never pass RLS for it and postgres_changes
-- events for support chat are silently never delivered to the frontend.
--
-- These policies let a browser session authenticated with a real Supabase
-- Auth JWT (auth.uid()) read only its own organization's tickets/messages,
-- which is what the Realtime websocket actually presents.
CREATE POLICY support_ticket_realtime_read ON support_tickets
FOR SELECT
USING (
  organization_id IN (SELECT organization_id FROM users WHERE supabase_uid = auth.uid())
);

CREATE POLICY support_message_realtime_read ON support_messages
FOR SELECT
USING (
  ticket_id IN (
    SELECT id FROM support_tickets
    WHERE organization_id IN (SELECT organization_id FROM users WHERE supabase_uid = auth.uid())
  )
);
