import { z } from 'zod';
import { supabase, supabaseAuth } from '../lib/supabase';
import { redis } from '../lib/redis';
import { AppError } from '../types';
import { signupStartSchema, signupVerifySchema, loginStartSchema, loginVerifySchema } from '../schemas/auth.schema';

type SignupStartInput = z.infer<typeof signupStartSchema>;
type SignupVerifyInput = z.infer<typeof signupVerifySchema>;
type LoginStartInput = z.infer<typeof loginStartSchema>;
type LoginVerifyInput = z.infer<typeof loginVerifySchema>;

/**
 * Customer accounts have one role: member. The billing manager is an
 * organization-level responsibility, not an elevated customer role. Admins
 * are the only separate application role.
 */
export async function normalizeCustomerUser(orgUser: any) {
  if (!orgUser || orgUser.role === 'admin') return orgUser;

  let normalized = orgUser;
  if (orgUser.role !== 'member') {
    const { data: updatedUser } = await supabase
      .from('users')
      .update({ role: 'member' })
      .eq('id', orgUser.id)
      .select()
      .single();
    normalized = updatedUser ? { ...orgUser, ...updatedUser, role: 'member' } : { ...orgUser, role: 'member' };
  }

  if (!normalized.organizations?.billing_manager_user_id) {
    const { data: updatedOrganization } = await supabase
      .from('organizations')
      .update({ billing_manager_user_id: normalized.id })
      .eq('id', normalized.organization_id)
      .is('billing_manager_user_id', null)
      .select()
      .single();
    if (updatedOrganization) normalized = { ...normalized, organizations: updatedOrganization };
  }

  return normalized;
}

const PENDING_SIGNUP_TTL_SECONDS = 15 * 60; // matches the OTP validity window shown to the user

function pendingSignupKey(email: string) {
  return `signup:pending:${email}`;
}

export async function signupStart(input: SignupStartInput) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', input.email)
    .maybeSingle();

  if (existing) {
    throw new AppError(409, 'An account with this email already exists');
  }

  await redis.set(
    pendingSignupKey(input.email),
    JSON.stringify({ firstName: input.firstName, lastName: input.lastName, company: input.company }),
    'EX',
    PENDING_SIGNUP_TTL_SECONDS,
  );

  const { error } = await supabaseAuth.auth.signInWithOtp({
    email: input.email,
    options: {
      shouldCreateUser: true,
      // signInWithOtp always renders Supabase's "Magic Link" email template,
      // even for brand-new accounts - there's no separate signup template it
      // switches to. This flag lets that template say "confirm your sign up"
      // instead of "sign in" via {{ .Data.intent }} (see auth.service.ts login
      // path for the matching "login" flag).
      data: { intent: 'signup' },
    },
  });

  if (error) {
    throw new AppError(400, error.message || 'Failed to send verification code');
  }
}

export async function signupVerify(input: SignupVerifyInput) {
  const pendingRaw = await redis.get(pendingSignupKey(input.email));
  if (!pendingRaw) {
    throw new AppError(400, 'Your signup session expired. Please start again.');
  }
  const pending = JSON.parse(pendingRaw) as { firstName: string; lastName: string; company: string };

  const { data: verifyData, error: verifyError } = await supabaseAuth.auth.verifyOtp({
    email: input.email,
    token: input.otp,
    type: 'email',
  });

  if (verifyError || !verifyData.session || !verifyData.user) {
    throw new AppError(401, 'Invalid or expired code');
  }

  const authUser = verifyData.user;

  const { data: organization, error: orgError } = await supabase
    .from('organizations')
    .insert({ name: pending.company })
    .select()
    .single();

  if (orgError || !organization) {
    throw new AppError(500, 'Failed to create organization');
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      organization_id: organization.id,
      supabase_uid: authUser.id,
      email: input.email,
      first_name: pending.firstName,
      last_name: pending.lastName,
      role: 'member',
    })
    .select()
    .single();

  if (userError || !user) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    throw new AppError(500, 'Failed to create user record');
  }

  const { data: managedOrganization, error: managerError } = await supabase
    .from('organizations')
    .update({ billing_manager_user_id: user.id })
    .eq('id', organization.id)
    .select()
    .single();
  if (managerError || !managedOrganization) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    await supabase.auth.admin.deleteUser(authUser.id);
    throw new AppError(500, 'Failed to configure billing ownership');
  }

  await redis.del(pendingSignupKey(input.email));

  return { session: verifyData.session, user, organization: managedOrganization };
}

export async function loginStart(input: LoginStartInput) {
  const { error } = await supabaseAuth.auth.signInWithOtp({
    email: input.email,
    options: {
      shouldCreateUser: false,
      data: { intent: 'login' },
    },
  });

  if (error) {
    throw new AppError(400, 'We could not send a code to that email');
  }
}

export async function loginVerify(input: LoginVerifyInput) {
  const { data: verifyData, error: verifyError } = await supabaseAuth.auth.verifyOtp({
    email: input.email,
    token: input.otp,
    type: 'email',
  });

  if (verifyError || !verifyData.session || !verifyData.user) {
    throw new AppError(401, 'Invalid or expired code');
  }

  const { data: orgUser, error: orgUserError } = await supabase
    .from('users')
    .select('*, organizations(*)')
    .eq('supabase_uid', verifyData.user.id)
    .single();

  if (orgUserError || !orgUser) {
    throw new AppError(401, 'User not found');
  }

  const normalizedUser = await normalizeCustomerUser(orgUser);

  return { session: verifyData.session, user: normalizedUser, organization: normalizedUser.organizations };
}

export async function logout(accessToken?: string) {
  if (!accessToken) return;
  try {
    await supabase.auth.admin.signOut(accessToken, 'global');
  } catch {
    // best-effort; cookies are cleared regardless
  }
}

export async function googleCallback(accessToken: string, refreshToken: string, expiresIn: number) {
  const { data: { user: authUser }, error } = await supabase.auth.getUser(accessToken);
  if (error || !authUser) throw new AppError(401, 'Invalid or expired Google token');

  const { data: existingUser } = await supabase
    .from('users')
    .select('*, organizations(*)')
    .eq('supabase_uid', authUser.id)
    .single();

  const session = { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };

  if (existingUser) {
    const normalizedUser = await normalizeCustomerUser(existingUser);
    return { session, user: normalizedUser, organization: normalizedUser.organizations };
  }

  // New Google user — derive org name from email domain
  const email = authUser.email!;
  const fullName = ((authUser.user_metadata?.full_name || authUser.user_metadata?.name || '') as string).trim();
  const [firstName = '', ...rest] = fullName.split(' ');
  const lastName = rest.join(' ');
  const domainRoot = email.split('@')[1]?.split('.')[0] || 'company';
  const orgName = domainRoot.charAt(0).toUpperCase() + domainRoot.slice(1);

  const { data: organization, error: orgError } = await supabase
    .from('organizations')
    .insert({ name: orgName })
    .select()
    .single();
  if (orgError || !organization) throw new AppError(500, 'Failed to create organisation');

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      organization_id: organization.id,
      supabase_uid: authUser.id,
      email,
      first_name: firstName,
      last_name: lastName,
      role: 'member',
    })
    .select()
    .single();

  if (userError || !user) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    throw new AppError(500, 'Failed to create user record');
  }

  const { data: managedOrganization, error: managerError } = await supabase
    .from('organizations')
    .update({ billing_manager_user_id: user.id })
    .eq('id', organization.id)
    .select()
    .single();
  if (managerError || !managedOrganization) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    throw new AppError(500, 'Failed to configure billing ownership');
  }

  return { session, user, organization: managedOrganization };
}

export async function refreshSession(refreshToken: string) {
  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    throw new AppError(401, 'Unable to refresh session');
  }
  return data.session;
}
