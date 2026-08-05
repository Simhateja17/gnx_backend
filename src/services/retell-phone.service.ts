import { retell } from '../lib/retell';
import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import { AppError } from '../types';

const PAID_PROVIDER_STATUSES = new Set(['active', 'authenticated']);
const PROVISIONING_STALE_MS = 5 * 60 * 1000;

export type RetellPhoneProvisioningResult = {
  status: 'active' | 'provisioning' | 'failed' | 'not_eligible';
  phoneNumber?: string | null;
  country?: 'US' | 'CA';
  numberType?: 'local' | 'toll_free';
  reason?: string;
};

type ProvisioningRow = {
  id: string;
  organization_id: string;
  agent_config_id: string | null;
  provider_phone_id: string | null;
  phone_number: string | null;
  country: 'US' | 'CA';
  number_type: 'local' | 'toll_free';
  status: 'requested' | 'provisioning' | 'active' | 'failed' | 'released';
  provisioning_key: string;
  created_at: string;
  updated_at: string;
};

function isUniqueViolation(error: any): boolean {
  return error?.code === '23505' || /duplicate key|unique constraint/i.test(error?.message ?? '');
}

function isRetellConfigured(): boolean {
  return Boolean(env.RETELL_API_KEY);
}

type RetellWeightedAgent = {
  agent_id: string;
  weight: 1;
  agent_version: 'latest_published';
};

export function buildRetellPhoneAgentBindings(agentId: string) {
  const binding: RetellWeightedAgent = {
    agent_id: agentId,
    weight: 1,
    agent_version: 'latest_published',
  };

  return {
    inbound_agents: [binding],
    outbound_agents: [{ ...binding }],
  } as const;
}

export function buildIncludedPhonePurchaseRequest(input: {
  country: 'US' | 'CA';
  organizationName: string;
  agentId?: string | null;
}) {
  return {
    country_code: input.country,
    toll_free: false,
    ...(input.agentId ? buildRetellPhoneAgentBindings(input.agentId) : {}),
    nickname: `${input.organizationName} included number`,
  } as const;
}

async function loadEntitlement(organizationId: string) {
  const [subscriptionResult, organizationResult, agentConfigResult] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('organization_id,plan_id,status')
      .eq('organization_id', organizationId)
      .maybeSingle(),
    supabase
      .from('organizations')
      .select('name,plan_id,subscription_status')
      .eq('id', organizationId)
      .single(),
    supabase
      .from('agent_configs')
      .select('id,agent_name,retell_agent_id,retell_phone_country')
      .eq('organization_id', organizationId)
      .maybeSingle(),
  ]);

  if (subscriptionResult.error) throw new AppError(500, 'Failed to load subscription for Retell provisioning', subscriptionResult.error);
  if (organizationResult.error || !organizationResult.data) throw new AppError(404, 'Organization not found for Retell provisioning', organizationResult.error);
  if (agentConfigResult.error) throw new AppError(500, 'Failed to load agent configuration for Retell provisioning', agentConfigResult.error);

  const subscription = subscriptionResult.data;
  if (!subscription || !PAID_PROVIDER_STATUSES.has(subscription.status)) {
    return { eligible: false as const, reason: 'subscription_not_active' };
  }

  const planId = subscription.plan_id ?? organizationResult.data.plan_id ?? 'starter';
  // Every paid plan receives one local number. Toll-free is intentionally not
  // part of this automatic path; it remains a Scale/add-on decision later.
  const country = agentConfigResult.data?.retell_phone_country === 'CA'
    ? 'CA'
    : agentConfigResult.data?.retell_phone_country === 'US'
      ? 'US'
      : env.RETELL_DEFAULT_COUNTRY;

  return {
    eligible: true as const,
    planId,
    country,
    organizationName: organizationResult.data.name,
    agentConfig: agentConfigResult.data ?? null,
  };
}

async function findProvisioningRow(provisioningKey: string): Promise<ProvisioningRow | null> {
  const { data, error } = await supabase
    .from('retell_phone_numbers')
    .select('*')
    .eq('provisioning_key', provisioningKey)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load Retell phone provisioning state', error);
  return data as ProvisioningRow | null;
}

async function claimProvisioningRow(input: {
  organizationId: string;
  agentConfigId: string | null;
  country: 'US' | 'CA';
  planId: string;
  provisioningKey: string;
}): Promise<{ row: ProvisioningRow | null; shouldProvision: boolean }> {
  const existing = await findProvisioningRow(input.provisioningKey);
  if (existing?.status === 'active' && existing.phone_number) return { row: existing, shouldProvision: false };
  if (existing?.status === 'provisioning' && Date.now() - new Date(existing.updated_at).getTime() < PROVISIONING_STALE_MS) {
    return { row: existing, shouldProvision: false };
  }

  const record = {
    organization_id: input.organizationId,
    agent_config_id: input.agentConfigId,
    country: input.country,
    number_type: 'local' as const,
    entitlement_kind: 'included' as const,
    entitlement_id: `plan:${input.planId}:included-local-v1`,
    provisioning_key: input.provisioningKey,
    status: 'provisioning' as const,
    error_code: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabase
      .from('retell_phone_numbers')
      .update(record)
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw new AppError(500, 'Failed to resume Retell phone provisioning', error);
    return { row: data as ProvisioningRow, shouldProvision: true };
  }

  const { data, error } = await supabase
    .from('retell_phone_numbers')
    .insert(record)
    .select('*')
    .single();

  if (!error) return { row: data as ProvisioningRow, shouldProvision: true };
  if (!isUniqueViolation(error)) throw new AppError(500, 'Failed to claim Retell phone provisioning', error);

  // A concurrent checkout/webhook won the unique provisioning key. Re-read
  // instead of purchasing a second number.
  return { row: await findProvisioningRow(input.provisioningKey), shouldProvision: false };
}

async function markProvisioningFailed(rowId: string, error: any) {
  await supabase
    .from('retell_phone_numbers')
    .update({
      status: 'failed',
      error_code: error?.statusCode ? String(error.statusCode) : 'retell_provisioning_failed',
      error_message: error?.message ?? 'Retell phone provisioning failed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', rowId);
}

export async function provisionIncludedRetellPhoneNumber(
  organizationId: string,
): Promise<RetellPhoneProvisioningResult> {
  const entitlement = await loadEntitlement(organizationId);
  if (!entitlement.eligible) return { status: 'not_eligible', reason: entitlement.reason };

  const provisioningKey = `${organizationId}:included:local:v1`;
  const claim = await claimProvisioningRow({
    organizationId,
    agentConfigId: entitlement.agentConfig?.id ?? null,
    country: entitlement.country,
    planId: entitlement.planId,
    provisioningKey,
  });

  const row = claim.row;
  if (!row) throw new AppError(500, 'Retell phone provisioning state was not created');
  if (row.status === 'active' && row.phone_number) {
    return {
      status: 'active',
      phoneNumber: row.phone_number,
      country: row.country,
      numberType: row.number_type,
    };
  }
  if (!claim.shouldProvision) {
    // Another request is already buying this number. Let its owner finish.
    return { status: 'provisioning', country: row.country, numberType: row.number_type };
  }

  if (!isRetellConfigured()) {
    const missingKeyError = new AppError(503, 'RETELL_API_KEY is not configured');
    await markProvisioningFailed(row.id, missingKeyError);
    throw missingKeyError;
  }

  const agentId = entitlement.agentConfig?.retell_agent_id ?? null;
  try {
    // retell-sdk 4.0.0 still exposes the removed single-agent fields in its
    // TypeScript definitions. The API request itself must use the weighted
    // agent arrays, so keep this cast at the SDK boundary until the package is
    // updated.
    const purchased = await retell.phoneNumber.create(buildIncludedPhonePurchaseRequest({
      country: entitlement.country,
      organizationName: entitlement.organizationName,
      agentId,
    }) as any);

    const phoneNumber = purchased.phone_number;
    const purchasedWithCurrentAgentFields = purchased as typeof purchased & {
      inbound_agents?: Array<{ agent_id?: string }>;
      outbound_agents?: Array<{ agent_id?: string }>;
    };
    const { error: updateError } = await supabase
      .from('retell_phone_numbers')
      .update({
        provider_phone_id: phoneNumber,
        phone_number: phoneNumber,
        status: 'active',
        // These columns are an internal compatibility mirror. They are not
        // sent back to Retell; provider_metadata stores the current arrays.
        inbound_agent_id: purchasedWithCurrentAgentFields.inbound_agents?.[0]?.agent_id
          ?? purchased.inbound_agent_id
          ?? agentId,
        outbound_agent_id: purchasedWithCurrentAgentFields.outbound_agents?.[0]?.agent_id
          ?? purchased.outbound_agent_id
          ?? agentId,
        provider_metadata: purchased,
        provisioned_at: new Date().toISOString(),
        last_reconciled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (updateError) throw new AppError(500, 'Retell number was purchased but could not be saved', updateError);

    // Keep the old field populated until every call path reads the new table.
    if (entitlement.agentConfig?.id) {
      const { error: configError } = await supabase
        .from('agent_configs')
        .update({ retell_phone_number: phoneNumber, retell_phone_country: entitlement.country })
        .eq('id', entitlement.agentConfig.id)
        .eq('organization_id', organizationId);
      if (configError) {
        // The durable retell_phone_numbers row is already active and is the
        // source used by new call paths. Keep the paid number usable and let
        // the reconciliation path repair this legacy mirror later.
        console.error(`[retell] Failed to mirror purchased number into agent config for org ${organizationId}:`, configError.message);
      }
    }

    return {
      status: 'active',
      phoneNumber,
      country: entitlement.country,
      numberType: 'local',
    };
  } catch (error: any) {
    await markProvisioningFailed(row.id, error);
    throw error instanceof AppError ? error : new AppError(502, `Retell phone purchase failed: ${error?.message ?? 'unknown error'}`, error);
  }
}

export async function listRetellPhoneNumbers(organizationId: string) {
  const { data, error } = await supabase
    .from('retell_phone_numbers')
    .select('id,phone_number,country,number_type,entitlement_kind,status,provisioned_at,error_message,created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw new AppError(500, 'Failed to list Retell phone numbers', error);
  return data ?? [];
}

export async function bindActiveRetellPhoneNumbers(organizationId: string, agentId: string) {
  const { data: rows, error } = await supabase
    .from('retell_phone_numbers')
    .select('id,phone_number')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .not('phone_number', 'is', null);
  if (error) throw new AppError(500, 'Failed to load active Retell numbers for agent binding', error);

  for (const row of rows ?? []) {
    if (!row.phone_number) continue;
    try {
      // Keep rebinding on the same current Retell API contract as purchase.
      const updated = await retell.phoneNumber.update(
        row.phone_number,
        buildRetellPhoneAgentBindings(agentId) as any,
      );
      await supabase.from('retell_phone_numbers').update({
        inbound_agent_id: agentId,
        outbound_agent_id: agentId,
        provider_metadata: updated,
        last_reconciled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
    } catch (bindingError: any) {
      console.warn(`[retell] Failed to bind ${row.phone_number} to agent ${agentId}:`, bindingError?.message ?? bindingError);
    }
  }
}
