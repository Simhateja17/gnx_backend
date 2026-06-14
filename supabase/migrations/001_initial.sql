-- Globonexo Sales AI — Initial Supabase Schema
-- Run via: supabase db push or psql

-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  website TEXT,
  plan_id TEXT NOT NULL DEFAULT 'starter',
  subscription_status TEXT NOT NULL DEFAULT 'trialing',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users (single user per org for v0.1)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supabase_uid UUID UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent configuration from onboarding
CREATE TABLE agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT 'Nexo',
  product_description TEXT NOT NULL,
  value_proposition TEXT NOT NULL,
  objections TEXT,
  tone TEXT NOT NULL DEFAULT 'consultative',
  icp_titles TEXT[] NOT NULL DEFAULT '{}',
  icp_company_sizes TEXT[] NOT NULL DEFAULT '{}',
  icp_geos TEXT[] NOT NULL DEFAULT '{}',
  booking_link TEXT,
  retell_agent_id TEXT,
  retell_phone_number TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Connected accounts (Gmail, etc.)
CREATE TABLE connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organization_id, provider)
);

-- Campaigns
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'voice')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  agent_config_id UUID REFERENCES agent_configs(id),
  prompt_context TEXT,
  max_leads INTEGER NOT NULL DEFAULT 100,
  daily_send_cap INTEGER NOT NULL DEFAULT 100,
  call_cadence_per_hour INTEGER NOT NULL DEFAULT 5,
  voice_mode TEXT NOT NULL DEFAULT 'ai' CHECK (voice_mode IN ('ai','manual')),
  business_hours_start TIME NOT NULL DEFAULT '09:00',
  business_hours_end TIME NOT NULL DEFAULT '17:00',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sequence steps for email campaigns
CREATE TABLE email_sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  delay_days INTEGER NOT NULL,
  subject_template TEXT,
  body_prompt_context TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Leads
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('apollo','csv','manual')),
  apollo_id TEXT,
  first_name TEXT,
  last_name TEXT,
  name TEXT,
  title TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  location TEXT,
  linkedin_url TEXT,
  timezone TEXT,
  score INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','enrichment_failed','queued','contacted','engaged','meeting_booked','not_interested','unsubscribed')),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Email messages sent
CREATE TABLE email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_step_id UUID REFERENCES email_sequence_steps(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','bounced')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Email replies received
CREATE TABLE email_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  gmail_message_id TEXT,
  ai_draft_reply TEXT,
  ai_draft_status TEXT NOT NULL DEFAULT 'pending' CHECK (ai_draft_status IN ('pending','approved','rejected','sent')),
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Voice calls
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  retell_call_id TEXT UNIQUE,
  from_number TEXT,
  to_number TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','completed','failed','voicemail')),
  transcript TEXT,
  recording_url TEXT,
  disposition TEXT CHECK (disposition IN ('interested','not_interested','meeting_booked','voicemail','callback','no_answer')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Support tickets
CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Support messages
CREATE TABLE support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user','admin')),
  sender_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_campaigns_org ON campaigns(organization_id);
CREATE INDEX idx_leads_org ON leads(organization_id);
CREATE INDEX idx_leads_campaign ON leads(campaign_id);
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_email_messages_org ON email_messages(organization_id);
CREATE INDEX idx_email_messages_lead ON email_messages(lead_id);
CREATE INDEX idx_email_messages_thread ON email_messages(gmail_thread_id);
CREATE INDEX idx_email_replies_message ON email_replies(email_message_id);
CREATE INDEX idx_calls_org ON calls(organization_id);
CREATE INDEX idx_calls_retell ON calls(retell_call_id);
CREATE INDEX idx_support_tickets_org ON support_tickets(organization_id);

-- Row Level Security
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- Basic RLS policies: org isolation by organization_id
-- Express uses service role key; these policies protect against accidental direct access.
CREATE POLICY org_isolation ON organizations USING (id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY user_org_isolation ON users USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY agent_config_org_isolation ON agent_configs USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY connected_account_org_isolation ON connected_accounts USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY campaign_org_isolation ON campaigns USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY sequence_org_isolation ON email_sequence_steps USING (campaign_id IN (SELECT id FROM campaigns WHERE organization_id = current_setting('app.current_org_id', true)::UUID));
CREATE POLICY lead_org_isolation ON leads USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY email_message_org_isolation ON email_messages USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY email_reply_org_isolation ON email_replies USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY call_org_isolation ON calls USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY subscription_org_isolation ON subscriptions USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY support_ticket_org_isolation ON support_tickets USING (organization_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY support_message_org_isolation ON support_messages USING (ticket_id IN (SELECT id FROM support_tickets WHERE organization_id = current_setting('app.current_org_id', true)::UUID));
