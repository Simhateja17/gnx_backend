-- Cover foreign keys used by the new Apollo/context/billing paths and the
-- existing high-volume delivery tables. These are additive indexes only.

CREATE INDEX IF NOT EXISTS billing_webhook_events_organization_idx
  ON public.billing_webhook_events (organization_id);

CREATE INDEX IF NOT EXISTS calls_campaign_idx
  ON public.calls (campaign_id);
CREATE INDEX IF NOT EXISTS calls_lead_idx
  ON public.calls (lead_id);
CREATE INDEX IF NOT EXISTS campaigns_agent_config_idx
  ON public.campaigns (agent_config_id);
CREATE INDEX IF NOT EXISTS email_messages_sequence_step_idx
  ON public.email_messages (sequence_step_id);
CREATE INDEX IF NOT EXISTS email_replies_lead_idx
  ON public.email_replies (lead_id);
CREATE INDEX IF NOT EXISTS email_replies_organization_idx
  ON public.email_replies (organization_id);
CREATE INDEX IF NOT EXISTS email_sequence_steps_campaign_idx
  ON public.email_sequence_steps (campaign_id);
CREATE INDEX IF NOT EXISTS lead_context_snapshots_account_idx
  ON public.lead_context_snapshots (account_id);
CREATE INDEX IF NOT EXISTS meetings_campaign_idx
  ON public.meetings (campaign_id);
CREATE INDEX IF NOT EXISTS meetings_context_snapshot_idx
  ON public.meetings (context_snapshot_id);
CREATE INDEX IF NOT EXISTS support_messages_sender_idx
  ON public.support_messages (sender_id);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx
  ON public.support_messages (ticket_id);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx
  ON public.support_tickets (user_id);

