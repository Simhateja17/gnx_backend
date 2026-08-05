import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import { AppError } from '../types';

/**
 * Guided setup state for an organization.
 *
 * Design rule that runs through this whole file: a step is only reported as
 * `complete` when a real record proves it. Gmail, Google Calendar, Apollo,
 * Retell, leads, and campaigns are derived from live tables on every read. The
 * stored row (org_setup_progress) never carries a "connected" flag a client
 * could set — it only carries tour position, explicit acknowledgements for the
 * steps that have nothing to derive from, and the Copilot draft.
 */

export const SETUP_STEP_IDS = [
  'profile',
  'product',
  'icp',
  'outreach',
  'gmail',
  'calendar',
  'apollo',
  'retell',
  'leads',
  'campaign',
  'launch',
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export type SetupStepStatus = 'complete' | 'incomplete' | 'blocked' | 'unavailable';

export type SetupStep = {
  id: SetupStepId;
  status: SetupStepStatus;
  /** Short, user-safe explanation of the current state. Never contains secrets. */
  detail: string;
  /** True when the customer explicitly skipped an optional step. */
  skipped: boolean;
  /** True when this step can be marked done by the customer (nothing to derive). */
  manual: boolean;
  /** Ids of steps that must be complete first. */
  dependsOn: SetupStepId[];
};

export type TourStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

export type TourState = {
  status: TourStatus;
  lastStepId: string | null;
  lastStepIndex: number;
  seenStepIds: string[];
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};

type StoredSteps = Record<string, { acknowledged?: boolean; skipped?: boolean; updatedAt?: string }>;

type ProgressRow = {
  organization_id: string;
  steps: StoredSteps;
  tour: Partial<TourState>;
  copilot: Record<string, unknown>;
};

/** Steps the customer can tick off themselves — nothing in the data proves them. */
const MANUAL_STEPS = new Set<SetupStepId>([]);

/** Steps a customer may skip and still reach a launchable campaign. */
const SKIPPABLE_STEPS = new Set<SetupStepId>(['calendar', 'apollo', 'retell']);

const STEP_DEPENDENCIES: Record<SetupStepId, SetupStepId[]> = {
  profile: [],
  product: [],
  icp: [],
  outreach: [],
  gmail: [],
  calendar: [],
  apollo: ['icp'],
  retell: [],
  leads: [],
  campaign: ['leads'],
  launch: ['campaign'],
};

// ---------------------------------------------------------------------------
// Stored progress
// ---------------------------------------------------------------------------

/**
 * Reads stored tour state, defaulting to 'not_started'.
 *
 * An organization that predates this feature has no org_setup_progress row at
 * all, so it lands here with an empty object and reads as 'not_started' — which
 * is what makes existing customers see the tour exactly once. Once they finish
 * or skip it the status is persisted and it never auto-opens again.
 */
export function normalizeTour(raw: unknown): TourState {
  const value = (raw ?? {}) as Partial<TourState>;
  const status: TourStatus =
    value.status === 'in_progress' || value.status === 'completed' || value.status === 'skipped'
      ? value.status
      : 'not_started';

  const index = Number(value.lastStepIndex);

  return {
    status,
    lastStepId: typeof value.lastStepId === 'string' ? value.lastStepId : null,
    lastStepIndex: Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0,
    seenStepIds: Array.isArray(value.seenStepIds)
      ? Array.from(new Set(value.seenStepIds.filter((id): id is string => typeof id === 'string'))).slice(0, 100)
      : [],
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

async function loadProgressRow(organizationId: string): Promise<ProgressRow> {
  const { data, error } = await supabase
    .from('org_setup_progress')
    .select('organization_id,steps,tour,copilot')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to load setup progress', error);

  return {
    organization_id: organizationId,
    steps: (data?.steps ?? {}) as StoredSteps,
    tour: (data?.tour ?? {}) as Partial<TourState>,
    copilot: (data?.copilot ?? {}) as Record<string, unknown>,
  };
}

async function saveProgressRow(
  organizationId: string,
  patch: Partial<Pick<ProgressRow, 'steps' | 'tour' | 'copilot'>>,
): Promise<void> {
  const { error } = await supabase
    .from('org_setup_progress')
    .upsert(
      {
        organization_id: organizationId,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id' },
    );

  if (error) throw new AppError(500, 'Failed to save setup progress', error);
}

// ---------------------------------------------------------------------------
// Live integration state
// ---------------------------------------------------------------------------

export type IntegrationState = {
  connected: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'not_configured' | 'pending';
  /** Safe display identity only — never a token, key, or raw provider payload. */
  label: string | null;
  detail: string;
};

export type IntegrationStates = {
  gmail: IntegrationState;
  calendar: IntegrationState;
  apollo: IntegrationState;
  retell: IntegrationState & { phoneNumber: string | null; agentReady: boolean };
};

type AgentConfigRow = {
  id: string;
  agent_name: string | null;
  first_name: string | null;
  company: string | null;
  role: string | null;
  industry: string | null;
  product_description: string | null;
  value_proposition: string | null;
  pain_points: string | null;
  tone: string | null;
  hook_style: string | null;
  follow_up_cadence: string | null;
  icp_titles: string[] | null;
  icp_company_sizes: string[] | null;
  icp_target_industries: string[] | null;
  icp_geos: string[] | null;
  meeting_target: number | null;
  retell_agent_id: string | null;
  ai_disclosure_enabled: boolean | null;
  recording_consent_required: boolean | null;
  default_language: string | null;
  default_voice_id: string | null;
};

const AGENT_CONFIG_COLUMNS =
  'id,agent_name,first_name,company,role,industry,product_description,value_proposition,pain_points,' +
  'tone,hook_style,follow_up_cadence,icp_titles,icp_company_sizes,icp_target_industries,icp_geos,' +
  'meeting_target,retell_agent_id,ai_disclosure_enabled,recording_consent_required,default_language,default_voice_id';

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.filter(item => typeof item === 'string' && item.trim()).length > 0;
}

function isFilled(value: unknown, minLength = 1): boolean {
  return typeof value === 'string' && value.trim().length >= minLength;
}

export async function getIntegrationStates(organizationId: string): Promise<IntegrationStates> {
  const [gmailResult, calendarResult, phoneResult, agentConfigResult, apolloLeadResult] = await Promise.all([
    supabase
      .from('connected_accounts')
      .select('provider_account_id,expires_at')
      .eq('organization_id', organizationId)
      .eq('provider', 'gmail')
      .maybeSingle(),
    supabase
      .from('calendar_connections')
      .select('connected_email,status,selected_calendar_name,timezone,last_error,access_token,refresh_token')
      .eq('organization_id', organizationId)
      .eq('provider', 'google')
      .maybeSingle(),
    supabase
      .from('retell_phone_numbers')
      .select('phone_number,status,error_message')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false }),
    supabase
      .from('agent_configs')
      .select('retell_agent_id')
      .eq('organization_id', organizationId)
      .maybeSingle(),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('source', 'apollo'),
  ]);

  const gmailRow = gmailResult.data;
  const gmail: IntegrationState = gmailRow
    ? {
        connected: true,
        status: 'connected',
        label: gmailRow.provider_account_id ?? null,
        detail: `Sending from ${gmailRow.provider_account_id ?? 'the connected mailbox'}.`,
      }
    : {
        connected: false,
        status: 'disconnected',
        label: null,
        detail: 'Gmail is not connected yet. Emails cannot be sent until it is.',
      };

  const calendarRow = calendarResult.data as
    | {
        connected_email: string | null;
        status: string | null;
        selected_calendar_name: string | null;
        timezone: string | null;
        last_error: string | null;
        access_token: string | null;
        refresh_token: string | null;
      }
    | null;

  const calendarConnected = Boolean(
    calendarRow && calendarRow.status === 'connected' && calendarRow.access_token && calendarRow.refresh_token,
  );
  const calendar: IntegrationState = calendarConnected
    ? {
        connected: true,
        status: 'connected',
        label: calendarRow?.connected_email ?? null,
        detail: `Booking into ${calendarRow?.selected_calendar_name || 'the primary calendar'} (${calendarRow?.timezone || 'UTC'}).`,
      }
    : {
        connected: false,
        status: calendarRow?.status === 'error' ? 'error' : 'disconnected',
        label: calendarRow?.connected_email ?? null,
        detail: calendarRow?.status === 'error'
          ? 'Google Calendar needs to be reconnected before meetings can be booked.'
          : 'Google Calendar is not connected. Meetings still appear here, but the agent cannot book slots.',
      };

  const apolloEnrichedCount = apolloLeadResult.count ?? 0;
  const apolloConfigured = Boolean(env.APOLLO_API_KEY);
  const apollo: IntegrationState = !apolloConfigured
    ? {
        connected: false,
        status: 'not_configured',
        label: null,
        detail: 'Apollo prospecting is not enabled on this workspace. You can still import leads by CSV or add them manually.',
      }
    : apolloEnrichedCount > 0
      ? {
          connected: true,
          status: 'connected',
          label: null,
          detail: `${apolloEnrichedCount} lead${apolloEnrichedCount === 1 ? '' : 's'} sourced from Apollo.`,
        }
      : {
          connected: false,
          status: 'disconnected',
          label: null,
          detail: 'Apollo is available. Run a search from Prospects to pull in matching people.',
        };

  const phoneRows = (phoneResult.data ?? []) as Array<{
    phone_number: string | null;
    status: string;
    error_message: string | null;
  }>;
  const activePhone = phoneRows.find(row => row.status === 'active' && row.phone_number);
  const pendingPhone = phoneRows.find(row => row.status === 'requested' || row.status === 'provisioning');
  const failedPhone = phoneRows.find(row => row.status === 'failed');
  const retellAgentId = agentConfigResult.data?.retell_agent_id ?? null;
  const retellConfigured = Boolean(env.RETELL_API_KEY);

  let retellStatus: IntegrationState['status'] = 'disconnected';
  let retellDetail = 'AI calling is not set up yet. Create the voice agent to enable call campaigns.';

  if (!retellConfigured) {
    retellStatus = 'not_configured';
    retellDetail = 'AI calling is not enabled on this workspace. Email campaigns are unaffected.';
  } else if (activePhone && retellAgentId) {
    retellStatus = 'connected';
    retellDetail = `Voice agent ready on ${activePhone.phone_number}.`;
  } else if (pendingPhone) {
    retellStatus = 'pending';
    retellDetail = 'Your included number is being provisioned. This usually finishes within a few minutes.';
  } else if (failedPhone) {
    retellStatus = 'error';
    retellDetail = 'Number provisioning failed. Retry it from Settings or contact support.';
  } else if (retellAgentId) {
    retellDetail = 'Voice agent created. A phone number is still needed before calls can be placed.';
  }

  const retell = {
    connected: retellStatus === 'connected',
    status: retellStatus,
    label: activePhone?.phone_number ?? null,
    detail: retellDetail,
    phoneNumber: activePhone?.phone_number ?? null,
    agentReady: Boolean(retellAgentId),
  };

  return { gmail, calendar, apollo, retell };
}

// ---------------------------------------------------------------------------
// Derived setup steps
// ---------------------------------------------------------------------------

export type SetupSummary = {
  completed: number;
  total: number;
  /** Steps counted toward "done" including explicitly skipped optional steps. */
  resolved: number;
  percent: number;
  nextStepId: SetupStepId | null;
  allRequiredComplete: boolean;
};

export type SetupState = {
  steps: SetupStep[];
  summary: SetupSummary;
  tour: TourState;
  integrations: IntegrationStates;
  counts: { leads: number; campaigns: number; activeCampaigns: number };
};

export function summarizeSteps(steps: SetupStep[]): SetupSummary {
  const countable = steps.filter(step => step.status !== 'unavailable');
  const completed = countable.filter(step => step.status === 'complete').length;
  const resolved = countable.filter(step => step.status === 'complete' || step.skipped).length;
  const next = steps.find(step => step.status !== 'complete' && step.status !== 'unavailable' && !step.skipped);

  return {
    completed,
    total: countable.length,
    resolved,
    percent: countable.length === 0 ? 0 : Math.round((resolved / countable.length) * 100),
    nextStepId: next?.id ?? null,
    allRequiredComplete: !next,
  };
}

export async function getSetupState(organizationId: string): Promise<SetupState> {
  const [progress, integrations, agentConfigResult, leadsResult, campaignsResult, activeCampaignsResult] =
    await Promise.all([
      loadProgressRow(organizationId),
      getIntegrationStates(organizationId),
      supabase
        .from('agent_configs')
        .select(AGENT_CONFIG_COLUMNS)
        .eq('organization_id', organizationId)
        .maybeSingle(),
      supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId),
      supabase
        .from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId),
      supabase
        .from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('status', 'active'),
    ]);

  const config = (agentConfigResult.data ?? null) as AgentConfigRow | null;
  const leadCount = leadsResult.count ?? 0;
  const campaignCount = campaignsResult.count ?? 0;
  const activeCampaignCount = activeCampaignsResult.count ?? 0;

  const derived: Record<SetupStepId, { status: SetupStepStatus; detail: string }> = {
    profile: isFilled(config?.first_name) && isFilled(config?.company)
      ? { status: 'complete', detail: `${config?.first_name} at ${config?.company}.` }
      : { status: 'incomplete', detail: 'Tell the agent who you are and which company it represents.' },

    product: isFilled(config?.product_description, 10)
      ? { status: 'complete', detail: 'The agent knows what you sell.' }
      : { status: 'incomplete', detail: 'Describe your product so the agent can explain it accurately.' },

    icp: hasItems(config?.icp_titles) && hasItems(config?.icp_geos)
      ? {
          status: 'complete',
          detail: `Targeting ${(config?.icp_titles ?? []).slice(0, 3).join(', ')}${(config?.icp_titles ?? []).length > 3 ? '…' : ''}.`,
        }
      : { status: 'incomplete', detail: 'Define the titles, company sizes, and regions worth contacting.' },

    outreach: isFilled(config?.value_proposition, 10) && isFilled(config?.tone)
      ? { status: 'complete', detail: `${config?.tone} tone, value proposition saved.` }
      : { status: 'incomplete', detail: 'Set your value proposition, tone, and follow-up cadence.' },

    gmail: integrations.gmail.connected
      ? { status: 'complete', detail: integrations.gmail.detail }
      : { status: 'incomplete', detail: integrations.gmail.detail },

    calendar: integrations.calendar.connected
      ? { status: 'complete', detail: integrations.calendar.detail }
      : {
          status: integrations.calendar.status === 'error' ? 'blocked' : 'incomplete',
          detail: integrations.calendar.detail,
        },

    apollo: integrations.apollo.status === 'not_configured'
      ? { status: 'unavailable', detail: integrations.apollo.detail }
      : integrations.apollo.connected
        ? { status: 'complete', detail: integrations.apollo.detail }
        : { status: 'incomplete', detail: integrations.apollo.detail },

    retell: integrations.retell.status === 'not_configured'
      ? { status: 'unavailable', detail: integrations.retell.detail }
      : integrations.retell.connected
        ? { status: 'complete', detail: integrations.retell.detail }
        : {
            status: integrations.retell.status === 'error' ? 'blocked' : 'incomplete',
            detail: integrations.retell.detail,
          },

    leads: leadCount > 0
      ? { status: 'complete', detail: `${leadCount} lead${leadCount === 1 ? '' : 's'} in your workspace.` }
      : { status: 'incomplete', detail: 'Import a CSV, add leads manually, or search Apollo.' },

    campaign: campaignCount > 0
      ? { status: 'complete', detail: `${campaignCount} campaign${campaignCount === 1 ? '' : 's'} created.` }
      : { status: 'incomplete', detail: 'Build your first campaign with the Setup Copilot.' },

    launch: activeCampaignCount > 0
      ? { status: 'complete', detail: `${activeCampaignCount} campaign${activeCampaignCount === 1 ? '' : 's'} running.` }
      : { status: 'incomplete', detail: 'Review the campaign, then launch it when you are ready.' },
  };

  const steps: SetupStep[] = SETUP_STEP_IDS.map(id => {
    const stored = progress.steps[id] ?? {};
    const base = derived[id];
    const manual = MANUAL_STEPS.has(id);
    const skipped = Boolean(stored.skipped) && SKIPPABLE_STEPS.has(id) && base.status !== 'complete';

    // A manual step has nothing to derive from, so an acknowledgement is what
    // completes it. Derived steps ignore acknowledgements entirely.
    const status: SetupStepStatus =
      manual && stored.acknowledged && base.status !== 'unavailable' ? 'complete' : base.status;

    return {
      id,
      status,
      detail: base.detail,
      skipped,
      manual,
      dependsOn: STEP_DEPENDENCIES[id],
    };
  });

  return {
    steps,
    summary: summarizeSteps(steps),
    tour: normalizeTour(progress.tour),
    integrations,
    counts: { leads: leadCount, campaigns: campaignCount, activeCampaigns: activeCampaignCount },
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type TourPatch = {
  status?: TourStatus;
  lastStepId?: string | null;
  lastStepIndex?: number;
  seenStepId?: string;
};

export function applyTourPatch(current: TourState, patch: TourPatch, now = new Date().toISOString()): TourState {
  const next: TourState = { ...current, updatedAt: now };

  if (patch.status) {
    next.status = patch.status;
    if (patch.status === 'in_progress' && !next.startedAt) next.startedAt = now;
    if (patch.status === 'completed') next.completedAt = now;
    // Restarting clears the completion marker so "resume" starts from the top.
    if (patch.status === 'in_progress') next.completedAt = null;
    if (patch.status === 'not_started') {
      next.startedAt = null;
      next.completedAt = null;
      next.lastStepId = null;
      next.lastStepIndex = 0;
      next.seenStepIds = [];
      return next;
    }
  }

  if (patch.lastStepId !== undefined) next.lastStepId = patch.lastStepId;
  if (patch.lastStepIndex !== undefined && Number.isFinite(patch.lastStepIndex) && patch.lastStepIndex >= 0) {
    next.lastStepIndex = Math.floor(patch.lastStepIndex);
  }
  if (patch.seenStepId) {
    next.seenStepIds = Array.from(new Set([...next.seenStepIds, patch.seenStepId])).slice(0, 100);
  }

  return next;
}

export async function updateTourState(organizationId: string, patch: TourPatch): Promise<TourState> {
  const progress = await loadProgressRow(organizationId);
  const next = applyTourPatch(normalizeTour(progress.tour), patch);
  await saveProgressRow(organizationId, { tour: next });
  return next;
}

export async function setStepAcknowledgement(
  organizationId: string,
  stepId: SetupStepId,
  action: 'complete' | 'skip' | 'reset',
): Promise<SetupState> {
  if (!SETUP_STEP_IDS.includes(stepId)) {
    throw new AppError(400, 'Unknown setup step');
  }
  if (action === 'complete' && !MANUAL_STEPS.has(stepId)) {
    throw new AppError(
      400,
      'This step is confirmed by your actual account data and cannot be marked complete manually.',
    );
  }
  if (action === 'skip' && !SKIPPABLE_STEPS.has(stepId)) {
    throw new AppError(400, 'This step is required and cannot be skipped.');
  }

  const progress = await loadProgressRow(organizationId);
  const steps: StoredSteps = { ...progress.steps };

  if (action === 'reset') {
    delete steps[stepId];
  } else {
    steps[stepId] = {
      ...(steps[stepId] ?? {}),
      acknowledged: action === 'complete' ? true : steps[stepId]?.acknowledged ?? false,
      skipped: action === 'skip',
      updatedAt: new Date().toISOString(),
    };
  }

  await saveProgressRow(organizationId, { steps });
  return getSetupState(organizationId);
}

// ---------------------------------------------------------------------------
// Copilot draft
// ---------------------------------------------------------------------------

export type CopilotDraft = Record<string, unknown>;

const COPILOT_DRAFT_MAX_BYTES = 32_000;

/** Keys the Copilot is allowed to persist. Anything else is dropped. */
const COPILOT_DRAFT_KEYS = new Set([
  'channel',
  'audience',
  'campaignName',
  'offer',
  'tone',
  'timezone',
  'businessHoursStart',
  'businessHoursEnd',
  'maxLeads',
  'dailySendCap',
  'callCadencePerHour',
  'voiceMode',
  'followUps',
  'selectedLeadIds',
  'stepIndex',
  'acknowledgedIntegrations',
]);

export function sanitizeCopilotDraft(raw: unknown): CopilotDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const draft: CopilotDraft = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COPILOT_DRAFT_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    draft[key] = value;
  }

  if (JSON.stringify(draft).length > COPILOT_DRAFT_MAX_BYTES) {
    throw new AppError(400, 'Setup draft is too large to save.');
  }

  return draft;
}

export async function getCopilotDraft(organizationId: string): Promise<CopilotDraft> {
  const progress = await loadProgressRow(organizationId);
  return sanitizeCopilotDraft(progress.copilot);
}

export async function saveCopilotDraft(organizationId: string, raw: unknown): Promise<CopilotDraft> {
  const draft = sanitizeCopilotDraft(raw);
  await saveProgressRow(organizationId, { copilot: draft });
  return draft;
}

export async function clearCopilotDraft(organizationId: string): Promise<void> {
  await saveProgressRow(organizationId, { copilot: {} });
}
