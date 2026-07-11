import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { UpdateSettingsInput } from '../schemas/settings.schema';

export async function getSettings(userId: string, orgId: string) {
  // These three queries are independent (different tables, no data
  // dependency between them) but ran sequentially — three round trips to
  // Supabase back-to-back on every settings load. Running them in parallel
  // caps the wait at the slowest single query instead of their sum.
  const [userResult, orgResult, configResult] = await Promise.all([
    supabase.from('users').select('first_name, last_name, email').eq('id', userId).single(),
    supabase.from('organizations').select('name, website').eq('id', orgId).single(),
    // agent_configs may not exist yet if onboarding was skipped — return defaults gracefully
    supabase
      .from('agent_configs')
      .select('tone, auto_approve_replies, daily_email_send_cap, booking_link, retell_phone_number, retell_agent_id')
      .eq('organization_id', orgId)
      .single(),
  ]);

  const { data: user, error: userError } = userResult;
  if (userError || !user) throw new AppError(404, 'User not found');

  const { data: org, error: orgError } = orgResult;
  if (orgError || !org) throw new AppError(404, 'Organisation not found');

  const { data: config } = configResult;

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
      bookingLink:        config?.booking_link         ?? '',
      retellPhoneNumber:  config?.retell_phone_number  ?? '',
      retellAgentId:      config?.retell_agent_id      ?? null,
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
  if (input.bookingLink        !== undefined) configPatch.booking_link         = input.bookingLink;
  if (input.retellPhoneNumber  !== undefined) configPatch.retell_phone_number  = input.retellPhoneNumber || null;

  if (Object.keys(configPatch).length > 0) {
    const { error } = await supabase
      .from('agent_configs')
      .update(configPatch)
      .eq('organization_id', orgId);
    if (error) throw new AppError(500, 'Failed to update agent configuration');
  }

  return getSettings(userId, orgId);
}
