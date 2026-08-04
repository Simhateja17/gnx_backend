import crypto from 'crypto';
import { supabase, supabaseAuth } from '../lib/supabase';
import { env } from '../config/env';

const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? '';

function signCookieValue(value: string): string {
  const signature = crypto.createHmac('sha256', env.COOKIE_SECRET).update(value).digest('base64').replace(/=+$/, '');
  return encodeURIComponent(`s:${value}.${signature}`);
}

async function ensureTestUser(): Promise<void> {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', TEST_USER_EMAIL)
    .maybeSingle();
  if (existing) return;

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: TEST_USER_EMAIL,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Failed to create test auth user: ${createError?.message}`);
  }

  const { data: organization, error: orgError } = await supabase
    .from('organizations')
    .insert({ name: 'Globonexo Test Org', subscription_status: 'active' })
    .select()
    .single();
  if (orgError || !organization) {
    throw new Error(`Failed to create test organization: ${orgError?.message}`);
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      organization_id: organization.id,
      supabase_uid: created.user.id,
      email: TEST_USER_EMAIL,
      first_name: 'Test',
      last_name: 'Auth',
      role: 'member',
    })
    .select()
    .single();
  if (userError || !user) {
    throw new Error(`Failed to create test user record: ${userError?.message}`);
  }

  const { error: managerError } = await supabase
    .from('organizations')
    .update({ billing_manager_user_id: user.id })
    .eq('id', organization.id);
  if (managerError) {
    throw new Error(`Failed to configure billing ownership: ${managerError.message}`);
  }
}

// Auth is OTP-only now, and OTP codes are only ever delivered by email, so
// integration tests can't drive the real signup/login endpoints end-to-end
// without a live mailbox. Instead this bootstraps (or reuses) the test auth
// user directly via the Supabase admin API, mints a session with
// generateLink + verifyOtp (which redeems a token without sending mail), and
// hand-signs the session cookies the same way cookie-parser does so the
// app's authenticate() middleware accepts them like a real login would.
export async function getTestUserCookies(): Promise<string[]> {
  if (!TEST_USER_EMAIL) {
    throw new Error('TEST_USER_EMAIL must be set in .env to run auth-middleware tests');
  }

  await ensureTestUser();

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: TEST_USER_EMAIL,
  });
  if (linkError || !linkData?.properties?.hashed_token) {
    throw new Error(`Failed to generate test session link: ${linkError?.message}`);
  }

  const { data: verifyData, error: verifyError } = await supabaseAuth.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError || !verifyData.session) {
    throw new Error(`Failed to redeem test session: ${verifyError?.message}`);
  }

  return [
    `access_token=${signCookieValue(verifyData.session.access_token)}`,
    `refresh_token=${signCookieValue(verifyData.session.refresh_token)}`,
  ];
}
