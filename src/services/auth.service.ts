import { z } from 'zod';
import { supabase, supabaseAuth } from '../lib/supabase';
import { env } from '../config/env';
import { AppError } from '../types';
import { signupSchema, loginSchema, resetPasswordSchema } from '../schemas/auth.schema';

type SignupInput = z.infer<typeof signupSchema>;
type LoginInput = z.infer<typeof loginSchema>;
type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export async function signup(input: SignupInput) {
  const { data: createData, error: createError } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });

  if (createError || !createData.user) {
    const isDuplicate =
      createError?.status === 422 || /already registered|already exists/i.test(createError?.message ?? '');
    if (isDuplicate) {
      throw new AppError(409, 'An account with this email already exists');
    }
    throw new AppError(400, createError?.message ?? 'Failed to create user');
  }

  const authUser = createData.user;

  const { data: organization, error: orgError } = await supabase
    .from('organizations')
    .insert({ name: input.company })
    .select()
    .single();

  if (orgError || !organization) {
    await supabase.auth.admin.deleteUser(authUser.id);
    throw new AppError(500, 'Failed to create organization');
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      organization_id: organization.id,
      supabase_uid: authUser.id,
      email: input.email,
      first_name: input.firstName,
      last_name: input.lastName,
      role: 'owner',
    })
    .select()
    .single();

  if (userError || !user) {
    await supabase.from('organizations').delete().eq('id', organization.id);
    await supabase.auth.admin.deleteUser(authUser.id);
    throw new AppError(500, 'Failed to create user record');
  }

  const { data: signInData, error: signInError } = await supabaseAuth.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (signInError || !signInData.session) {
    throw new AppError(500, 'Account created but sign-in failed');
  }

  return { session: signInData.session, user, organization };
}

export async function login(input: LoginInput) {
  const { data: signInData, error: signInError } = await supabaseAuth.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (signInError || !signInData.session || !signInData.user) {
    throw new AppError(401, 'Invalid email or password');
  }

  const { data: orgUser, error: orgUserError } = await supabase
    .from('users')
    .select('*, organizations(*)')
    .eq('supabase_uid', signInData.user.id)
    .single();

  if (orgUserError || !orgUser) {
    throw new AppError(401, 'User not found');
  }

  return { session: signInData.session, user: orgUser, organization: orgUser.organizations };
}

export async function logout(accessToken?: string) {
  if (!accessToken) return;
  try {
    await supabase.auth.admin.signOut(accessToken, 'global');
  } catch {
    // best-effort; cookies are cleared regardless
  }
}

export async function forgotPassword(email: string) {
  await supabaseAuth.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.FRONTEND_URL}/reset-password`,
  });
}

export async function resetPassword(input: ResetPasswordInput) {
  const { data, error } = await supabase.auth.getUser(input.accessToken);
  if (error || !data.user) {
    throw new AppError(401, 'Invalid or expired reset link');
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(data.user.id, {
    password: input.newPassword,
  });
  if (updateError) {
    throw new AppError(500, 'Failed to update password');
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
