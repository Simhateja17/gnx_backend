-- Enable Supabase Realtime database change events for support chat.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE support_tickets;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
