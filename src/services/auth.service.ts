import { z } from 'zod';
import { supabase, supabaseAuth } from '../lib/supabase';
import { redis } from '../lib/redis';
import { AppError } from '../types';
import { signupStartSchema, signupVerifySchema, loginStartSchema, loginVerifySchema } from '../schemas/auth.schema';

type SignupStartInput = z.infer<typeof signupStartSchema>;
type SignupVerifyInput = z.infer<typeof signupVerifySchema>;
type LoginStartInput = z.infer<typeof loginStartSchema>;
type LoginVerifyInput = z.infer<typeof loginVerifySchema>;

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
    options: { shouldCreateUser: true },
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
      role: 'owner',
    })
    .select()
    .single();

  if (userError || !user) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    throw new AppError(500, 'Failed to create user record');
  }

  await redis.del(pendingSignupKey(input.email));

  return { session: verifyData.session, user, organization };
}

export async function loginStart(input: LoginStartInput) {
  const { error } = await supabaseAuth.auth.signInWithOtp({
    email: input.email,
    options: { shouldCreateUser: false },
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

  return { session: verifyData.session, user: orgUser, organization: orgUser.organizations };
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
    return { session, user: existingUser, organization: existingUser.organizations };
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
      role: 'owner',
    })
    .select()
    .single();

  if (userError || !user) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    throw new AppError(500, 'Failed to create user record');
  }

  return { session, user, organization };
}

export async function refreshSession(refreshToken: string) {
  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    throw new AppError(401, 'Unable to refresh session');
  }
  return data.session;
}
