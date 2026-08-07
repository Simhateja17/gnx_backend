import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import type { UpdateSettingsInput } from '../schemas/settings.schema';

export async function getSettings(userId: string, organizationId: string) {
  const [userResult, organizationResult, agentConfigResult] = await Promise.all([
    supabase.from('users').select('first_name,last_name').eq('id', userId).maybeSingle(),
    supabase.from('organizations').select('name,website').eq('id', organizationId).maybeSingle(),
    supabase
      .from('agent_configs')
      .select('tone,auto_approve_replies,daily_email_send_cap,booking_link,retell_phone_number')
      .eq('organization_id', organizationId)
      .maybeSingle(),
  ]);

  if (userResult.error) throw new AppError(500, 'Failed to load user settings', userResult.error);
  if (organizationResult.error) throw new AppError(500, 'Failed to load organization settings', organizationResult.error);
  if (agentConfigResult.error) throw new AppError(500, 'Failed to load agent settings', agentConfigResult.error);

  return {
    firstName: userResult.data?.first_name ?? '',
    lastName: userResult.data?.last_name ?? '',
    orgName: organizationResult.data?.name ?? '',
    orgWebsite: organizationResult.data?.website ?? '',
    tone: agentConfigResult.data?.tone ?? 'consultative',
    autoApproveReplies: agentConfigResult.data?.auto_approve_replies ?? false,
    dailyEmailSendCap: agentConfigResult.data?.daily_email_send_cap ?? 100,
    bookingLink: agentConfigResult.data?.booking_link ?? '',
    retellPhoneNumber: agentConfigResult.data?.retell_phone_number ?? '',
  };
}

export async function updateSettings(userId: string, organizationId: string, input: UpdateSettingsInput) {
  const userUpdate: Record<string, any> = {};
  if (input.firstName !== undefined) userUpdate.first_name = input.firstName;
  if (input.lastName !== undefined) userUpdate.last_name = input.lastName;
  if (Object.keys(userUpdate).length > 0) {
    const { error } = await supabase.from('users').update(userUpdate).eq('id', userId);
    if (error) throw new AppError(500, 'Failed to update user settings', error);
  }

  const organizationUpdate: Record<string, any> = {};
  if (input.orgName !== undefined) organizationUpdate.name = input.orgName;
  if (input.orgWebsite !== undefined) organizationUpdate.website = input.orgWebsite;
  if (Object.keys(organizationUpdate).length > 0) {
    organizationUpdate.updated_at = new Date().toISOString();
    const { error } = await supabase.from('organizations').update(organizationUpdate).eq('id', organizationId);
    if (error) throw new AppError(500, 'Failed to update organization settings', error);
  }

  const agentConfigUpdate: Record<string, any> = {};
  if (input.tone !== undefined) agentConfigUpdate.tone = input.tone;
  if (input.autoApproveReplies !== undefined) agentConfigUpdate.auto_approve_replies = input.autoApproveReplies;
  if (input.dailyEmailSendCap !== undefined) agentConfigUpdate.daily_email_send_cap = input.dailyEmailSendCap;
  if (input.bookingLink !== undefined) agentConfigUpdate.booking_link = input.bookingLink;
  if (input.retellPhoneNumber !== undefined) agentConfigUpdate.retell_phone_number = input.retellPhoneNumber;
  if (Object.keys(agentConfigUpdate).length > 0) {
    agentConfigUpdate.updated_at = new Date().toISOString();
    const { error } = await supabase.from('agent_configs').update(agentConfigUpdate).eq('organization_id', organizationId);
    if (error) throw new AppError(500, 'Failed to update agent settings', error);
  }

  return getSettings(userId, organizationId);
}

// --- Global platform settings (key-value), used as an admin-controlled
// runtime kill switch, e.g. for auto phone-number provisioning. Unrelated to
// the per-org profile settings above; backed by the separate `settings` table.

export async function getSetting(key: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new AppError(500, `Failed to load setting "${key}"`, error);
  return data?.value ?? null;
}

export async function setSetting(key: string, value: any, updatedByUserId: string): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .upsert({
      key,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedByUserId,
    });
  if (error) throw new AppError(500, `Failed to update setting "${key}"`, error);
}

export async function isAutoProvisionPhoneEnabled(): Promise<boolean> {
  return (await getSetting('auto_provision_phone_number')) === true;
}
