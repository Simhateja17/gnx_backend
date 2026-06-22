-- Seed data for testing AI endpoints (generate-email, generate-reply, generate-voice-prompt)
-- Run manually against your dev Supabase project, then delete when no longer needed.

-- 1. Test organization
INSERT INTO organizations (id, name, website, plan_id, subscription_status)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Acme SaaS Inc.',
  'https://acmesaas.com',
  'growth',
  'active'
) ON CONFLICT (id) DO NOTHING;

-- 2. Test user (supabase_uid should match a real Supabase Auth user for cookie auth testing)
--    Replace the supabase_uid with your actual dev user's UID.
INSERT INTO users (id, organization_id, supabase_uid, email, first_name, last_name, role)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  '3bb78236-009d-4084-8685-0ccef54c93ee', -- REPLACE with your real Supabase Auth UID
  'manasa@acmesaas.com',
  'Manasa',
  'Test',
  'owner'
) ON CONFLICT (id) DO NOTHING;

-- 3. Agent config (populated by onboarding in production)
INSERT INTO agent_configs (id, organization_id, agent_name, product_description, value_proposition, objections, tone, icp_titles, icp_company_sizes, icp_geos, booking_link)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  'Nexo',
  'Globonexo is an AI-powered outbound sales platform that automates lead prospecting, email sequences, and voice calls to book meetings.',
  'We help B2B sales teams book 3x more meetings with zero manual prospecting. Our AI agent finds leads, writes personalized emails, and makes calls - all on autopilot.',
  'Price concerns: we save 40+ hours/month per rep. Already have an SDR team: Globonexo augments, not replaces. Data quality: we use Apollo.io for verified contacts.',
  'consultative',
  ARRAY['VP of Sales', 'Head of Growth', 'SDR Manager', 'Revenue Operations'],
  ARRAY['51-200', '201-500', '501-1000'],
  ARRAY['United States'],
  'https://calendly.com/acmesaas/15min'
) ON CONFLICT (id) DO NOTHING;

-- 4. Test email campaign
INSERT INTO campaigns (id, organization_id, name, channel, status, agent_config_id, prompt_context, max_leads, daily_send_cap, timezone)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  'Q3 Mid-Market Outreach',
  'email',
  'active',
  '33333333-3333-3333-3333-333333333333',
  'Targeting mid-market SaaS companies struggling with outbound pipeline. Lead with the "3x meetings" angle and our recent case study with TechCorp (went from 5 to 18 meetings/month).',
  100,
  100,
  'America/New_York'
) ON CONFLICT (id) DO NOTHING;

-- 4b. Sequence steps for email campaign (optional custom context per step)
INSERT INTO email_sequence_steps (id, campaign_id, step_number, delay_days, body_prompt_context)
VALUES
  ('44440001-0001-0001-0001-000000000001', '44444444-4444-4444-4444-444444444444', 1, 0, NULL),
  ('44440001-0001-0001-0001-000000000002', '44444444-4444-4444-4444-444444444444', 2, 3, 'Mention our recent case study with TechCorp who went from 5 to 18 meetings per month. Focus on the ROI angle.'),
  ('44440001-0001-0001-0001-000000000003', '44444444-4444-4444-4444-444444444444', 3, 7, 'Offer a free 14-day trial as a final incentive before closing the loop.')
ON CONFLICT (id) DO NOTHING;

-- 5. Test voice campaign
INSERT INTO campaigns (id, organization_id, name, channel, status, agent_config_id, prompt_context, max_leads, call_cadence_per_hour, voice_mode, timezone)
VALUES (
  '55555555-5555-5555-5555-555555555555',
  '11111111-1111-1111-1111-111111111111',
  'Q3 Voice Follow-ups',
  'voice',
  'active',
  '33333333-3333-3333-3333-333333333333',
  'Calling leads who opened our emails but did not reply. Reference the email they received and offer a quick 15-min chat.',
  50,
  5,
  'ai',
  'America/New_York'
) ON CONFLICT (id) DO NOTHING;

-- 6. Test lead
INSERT INTO leads (id, organization_id, campaign_id, source, first_name, last_name, name, title, company, email, phone, location, linkedin_url, timezone, score, status)
VALUES (
  '66666666-6666-6666-6666-666666666666',
  '11111111-1111-1111-1111-111111111111',
  '44444444-4444-4444-4444-444444444444',
  'apollo',
  'Sarah',
  'Chen',
  'Sarah Chen',
  'VP of Sales',
  'DataFlow Analytics',
  'sarah.chen@dataflow.example.com',
  '+14155551234',
  'San Francisco, CA',
  'https://linkedin.com/in/sarahchen',
  'America/Los_Angeles',
  85,
  'contacted'
) ON CONFLICT (id) DO NOTHING;

-- 7. Test email message (needed for step 2/3 and reply testing)
INSERT INTO email_messages (id, organization_id, campaign_id, lead_id, subject, body, gmail_thread_id, status, sent_at)
VALUES (
  '77777777-7777-7777-7777-777777777777',
  '11111111-1111-1111-1111-111111111111',
  '44444444-4444-4444-4444-444444444444',
  '66666666-6666-6666-6666-666666666666',
  'Quick question about DataFlow''s outbound pipeline',
  'Hi Sarah,

I noticed DataFlow Analytics has been growing quickly - congrats on the Series B. With that kind of growth, I imagine scaling outbound is top of mind for your sales team.

We built Globonexo to solve exactly that. Our AI agent handles lead sourcing, personalized email sequences, and even voice calls - so your reps can focus on closing instead of prospecting.

One of our customers, TechCorp, went from 5 to 18 meetings per month after switching. Would it make sense to chat for 15 minutes about whether we could do something similar for DataFlow?

Best,
Nexo',
  'thread_abc123',
  'sent',
  NOW() - INTERVAL '3 days'
) ON CONFLICT (id) DO NOTHING;

-- 8. Test email reply (needed for generate-reply testing)
INSERT INTO email_replies (id, organization_id, email_message_id, lead_id, body, gmail_message_id, ai_draft_status, received_at)
VALUES (
  '88888888-8888-8888-8888-888888888888',
  '11111111-1111-1111-1111-111111111111',
  '77777777-7777-7777-7777-777777777777',
  '66666666-6666-6666-6666-666666666666',
  'Hi,

Thanks for reaching out. We are actually looking at solutions like this. Our SDR team is struggling to keep up with our growth targets.

What does pricing look like? And how long does it typically take to get up and running?

Sarah',
  'msg_reply_456',
  'pending',
  NOW() - INTERVAL '1 day'
) ON CONFLICT (id) DO NOTHING;
