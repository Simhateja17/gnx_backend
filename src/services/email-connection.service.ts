import { supabase } from '../lib/supabase';
import { decryptSecret, encryptSecret } from '../lib/secret-box';
import { AppError } from '../types';

export const EMAIL_PROVIDERS = ['gmail', 'smtp'] as const;
export type EmailProvider = typeof EMAIL_PROVIDERS[number];

export type SmtpConnectionMetadata = {
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  lastTestedAt?: string;
  lastImapUid?: number;
};

export type ActiveEmailConnection = {
  id: string;
  provider: EmailProvider;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  metadata: Record<string, unknown> | null;
};

type ConnectionRow = {
  id: string;
  provider: string;
  provider_account_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  metadata: Record<string, unknown> | null;
  is_active: boolean | null;
};

function isEmailProvider(value: string): value is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(value);
}

function asMetadata(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function mapConnection(row: ConnectionRow): ActiveEmailConnection {
  if (!isEmailProvider(row.provider)) throw new AppError(500, `Unsupported email provider: ${row.provider}`);
  return {
    id: row.id,
    provider: row.provider,
    email: row.provider_account_id ?? '',
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    metadata: asMetadata(row.metadata),
  };
}

export async function getActiveEmailConnection(organizationId: string): Promise<ActiveEmailConnection | null> {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id,provider,provider_account_id,access_token,refresh_token,metadata,is_active')
    .eq('organization_id', organizationId)
    .in('provider', [...EMAIL_PROVIDERS])
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch active email connection', error);
  return data ? mapConnection(data as ConnectionRow) : null;
}

export async function getEmailConnection(organizationId: string, connectionId: string): Promise<ActiveEmailConnection | null> {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id,provider,provider_account_id,access_token,refresh_token,metadata,is_active')
    .eq('organization_id', organizationId)
    .eq('id', connectionId)
    .in('provider', [...EMAIL_PROVIDERS])
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to fetch email connection', error);
  return data ? mapConnection(data as ConnectionRow) : null;
}

export async function getActiveEmailConnections(organizationId?: string) {
  let query = supabase
    .from('connected_accounts')
    .select('id,organization_id,provider,provider_account_id,access_token,refresh_token,metadata,is_active')
    .in('provider', [...EMAIL_PROVIDERS])
    .eq('is_active', true);

  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query;
  if (error) throw new AppError(500, 'Failed to fetch active email connections', error);
  return data ?? [];
}

export async function getEmailConnectionStatuses(organizationId: string) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id,provider,provider_account_id,metadata,is_active,updated_at')
    .eq('organization_id', organizationId)
    .in('provider', [...EMAIL_PROVIDERS])
    .order('updated_at', { ascending: false });

  if (error) throw new AppError(500, 'Failed to fetch email connection status', error);

  return (data ?? []).map((row: any) => ({
    id: row.id,
    provider: row.provider,
    email: row.provider_account_id ?? null,
    active: row.is_active === true,
    connected: true,
    smtpHost: row.provider === 'smtp' ? row.metadata?.smtpHost ?? null : null,
    imapHost: row.provider === 'smtp' ? row.metadata?.imapHost ?? null : null,
    lastTestedAt: row.provider === 'smtp' ? row.metadata?.lastTestedAt ?? null : null,
    updatedAt: row.updated_at ?? null,
  }));
}

export async function activateEmailProvider(organizationId: string, provider: EmailProvider) {
  const { error: deactivateError } = await supabase
    .from('connected_accounts')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .in('provider', [...EMAIL_PROVIDERS]);
  if (deactivateError) throw new AppError(500, 'Failed to deactivate the previous email provider', deactivateError);

  const { data, error } = await supabase
    .from('connected_accounts')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .select('id')
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to activate email provider', error);
  if (!data) throw new AppError(404, `${provider} email connection not found`);
  return { success: true, provider };
}

export async function removeEmailConnection(organizationId: string, provider: EmailProvider) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .delete()
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .select('id')
    .maybeSingle();

  if (error) return { data: null, error };

  // If the active provider was removed, make another connected email
  // provider active so queued campaigns continue to have a deterministic
  // route. Gmail remains the natural fallback when it exists.
  if (data) {
    const { data: fallback } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('organization_id', organizationId)
      .in('provider', [...EMAIL_PROVIDERS])
      .order('provider', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (fallback) {
      await supabase
        .from('connected_accounts')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('id', fallback.id);
    }
  }

  return { data, error: null };
}

export async function saveSmtpConnection(input: {
  organizationId: string;
  email: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
  lastTestedAt: string;
}) {
  const { organizationId, ...connection } = input;
  const { error: deactivateError } = await supabase
    .from('connected_accounts')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .in('provider', [...EMAIL_PROVIDERS]);
  if (deactivateError) throw new AppError(500, 'Failed to deactivate the previous email provider', deactivateError);

  const metadata: SmtpConnectionMetadata = {
    displayName: connection.displayName,
    smtpHost: connection.smtpHost,
    smtpPort: connection.smtpPort,
    smtpSecure: connection.smtpSecure,
    smtpUsername: connection.smtpUsername,
    imapHost: connection.imapHost,
    imapPort: connection.imapPort,
    imapSecure: connection.imapSecure,
    imapUsername: connection.imapUsername,
    lastTestedAt: connection.lastTestedAt,
    lastImapUid: 0,
  };

  const { data, error } = await supabase
    .from('connected_accounts')
    .upsert({
      organization_id: organizationId,
      provider: 'smtp',
      provider_account_id: connection.email,
      access_token: encryptSecret(connection.smtpPassword),
      refresh_token: encryptSecret(connection.imapPassword),
      expires_at: null,
      metadata,
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,provider' })
    .select('id,provider,provider_account_id,is_active')
    .single();

  if (error || !data) throw new AppError(500, 'Failed to save custom email connection', error);
  return {
    id: data.id,
    connected: true,
    active: true,
    provider: 'smtp' as const,
    email: data.provider_account_id,
  };
}

export function smtpConfigFromConnection(connection: ActiveEmailConnection) {
  if (connection.provider !== 'smtp' || !connection.metadata || !connection.accessToken || !connection.refreshToken) {
    throw new AppError(400, 'Custom SMTP is not configured correctly');
  }

  const metadata = connection.metadata as unknown as SmtpConnectionMetadata;
  return {
    smtp: {
      smtpHost: metadata.smtpHost,
      smtpPort: metadata.smtpPort,
      smtpSecure: metadata.smtpSecure,
      smtpUsername: metadata.smtpUsername,
      smtpPassword: decryptSecret(connection.accessToken),
    },
    imap: {
      imapHost: metadata.imapHost,
      imapPort: metadata.imapPort,
      imapSecure: metadata.imapSecure,
      imapUsername: metadata.imapUsername,
      imapPassword: decryptSecret(connection.refreshToken),
    },
    displayName: metadata.displayName,
  };
}

export async function updateSmtpPollCursor(connectionId: string, metadata: Record<string, unknown>, lastImapUid: number) {
  const nextMetadata = { ...metadata, lastImapUid, lastPolledAt: new Date().toISOString() };
  const { error } = await supabase
    .from('connected_accounts')
    .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
    .eq('id', connectionId)
    .eq('provider', 'smtp');
  if (error) throw new AppError(500, 'Failed to save IMAP poll cursor', error);
}
