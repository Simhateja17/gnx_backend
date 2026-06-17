import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { UpdateSettingsInput } from '../schemas/settings.schema';

export async function getSettings(userId: string, orgId: string) {
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('first_name, last_name, email')
    .eq('id', userId)
    .single();

  if (userError || !user) throw new AppError(404, 'User not found');

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('name, website')
    .eq('id', orgId)
    .single();

  if (orgError || !org) throw new AppError(404, 'Organisation not found');

  // agent_configs may not exist yet if onboarding was skipped — return defaults gracefully
  const { data: config } = await supabase
    .from('agent_configs')
    .select('tone, auto_approve_replies, daily_email_send_cap')
    .eq('organization_id', orgId)
    .single();

  return {
    profile: {
      firstName: user.first_name ?? '',
      lastName:  user.last_name  ?? '',
      email:     user.email,
    },
    organization: {
      name:    org.name,
      website: org.website ?? '',
    },
    agentConfig: {
      tone:               config?.tone                ?? 'consultative',
      autoApproveReplies: config?.auto_approve_replies ?? false,
      dailyEmailSendCap:  config?.daily_email_send_cap ?? 100,
    },
  };
}

export async function updateSettings(userId: string, orgId: string, input: UpdateSettingsInput) {
  const userPatch: Record<string, unknown> = {};
  if (input.firstName !== undefined) userPatch.first_name = input.firstName;
  if (input.lastName  !== undefined) userPatch.last_name  = input.lastName;

  if (Object.keys(userPatch).length > 0) {
    const { error } = await supabase.from('users').update(userPatch).eq('id', userId);
    if (error) throw new AppError(500, 'Failed to update profile');
  }

  const orgPatch: Record<string, unknown> = {};
  if (input.orgName    !== undefined) orgPatch.name    = input.orgName;
  if (input.orgWebsite !== undefined) orgPatch.website = input.orgWebsite;

  if (Object.keys(orgPatch).length > 0) {
    const { error } = await supabase.from('organizations').update(orgPatch).eq('id', orgId);
    if (error) throw new AppError(500, 'Failed to update organisation');
  }

  const configPatch: Record<string, unknown> = {};
  if (input.tone               !== undefined) configPatch.tone                 = input.tone;
  if (input.autoApproveReplies !== undefined) configPatch.auto_approve_replies = input.autoApproveReplies;
  if (input.dailyEmailSendCap  !== undefined) configPatch.daily_email_send_cap = input.dailyEmailSendCap;

  if (Object.keys(configPatch).length > 0) {
    const { error } = await supabase
      .from('agent_configs')
      .update(configPatch)
      .eq('organization_id', orgId);
    if (error) throw new AppError(500, 'Failed to update agent configuration');
  }

  return getSettings(userId, orgId);
}
