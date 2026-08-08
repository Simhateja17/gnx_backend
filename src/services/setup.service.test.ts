import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A small in-memory stand-in for the Supabase query builder, covering exactly
 * the shapes setup.service uses: select/eq/in/order/maybeSingle, head+count
 * selects, and upsert.
 */
type Row = Record<string, any>;

const db: Record<string, Row[]> = {};
let upserts: Array<{ table: string; values: Row }> = [];

function makeQuery(table: string) {
  let rows = () => (db[table] ?? []).slice();
  const filters: Array<(row: Row) => boolean> = [];
  let headCount = false;

  const apply = () => rows().filter(row => filters.every(fn => fn(row)));

  const builder: any = {
    select(_cols?: string, options?: { count?: string; head?: boolean }) {
      headCount = Boolean(options?.head);
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push(row => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push(row => values.includes(row[column]));
      return builder;
    },
    order() {
      return builder;
    },
    maybeSingle() {
      const found = apply();
      return Promise.resolve({ data: found[0] ?? null, error: null });
    },
    single() {
      const found = apply();
      return Promise.resolve({
        data: found[0] ?? null,
        error: found[0] ? null : { message: 'not found' },
      });
    },
    upsert(values: Row) {
      upserts.push({ table, values });
      const existing = (db[table] ?? []).find(row => row.organization_id === values.organization_id);
      if (existing) Object.assign(existing, values);
      else (db[table] = db[table] ?? []).push({ ...values });
      return Promise.resolve({ error: null });
    },
    then(resolve: (value: { data: Row[]; count: number; error: null }) => unknown) {
      const found = apply();
      return Promise.resolve(
        resolve({ data: headCount ? [] : found, count: found.length, error: null }),
      );
    },
  };

  return builder;
}

vi.mock('../lib/supabase', () => ({
  supabase: { from: (table: string) => makeQuery(table) },
}));

const { envMock } = vi.hoisted(() => ({
  envMock: { APOLLO_API_KEY: 'apollo-key', RETELL_API_KEY: 'retell-key' },
}));
vi.mock('../config/env', () => ({ env: envMock }));

import {
  applyTourPatch,
  getIntegrationStates,
  getSetupState,
  normalizeTour,
  sanitizeCopilotDraft,
  saveCopilotDraft,
  setStepAcknowledgement,
  summarizeSteps,
  updateTourState,
  type SetupStep,
} from './setup.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';

function resetDb() {
  for (const key of Object.keys(db)) delete db[key];
  upserts = [];
  envMock.APOLLO_API_KEY = 'apollo-key';
  envMock.RETELL_API_KEY = 'retell-key';

  db.org_setup_progress = [];
  db.connected_accounts = [];
  db.calendar_settings = [];
  db.retell_phone_numbers = [];
  db.agent_configs = [];
  db.leads = [];
  db.campaigns = [];
}

function seedCompleteOnboarding() {
  db.agent_configs = [{
    organization_id: ORG,
    id: 'cfg-1',
    first_name: 'Simha',
    company: 'Globonexo',
    product_description: 'An AI sales agent that books meetings.',
    value_proposition: 'Books qualified meetings without more headcount.',
    tone: 'consultative',
    icp_titles: ['VP Sales'],
    icp_geos: ['United States'],
    retell_agent_id: null,
  }];
}

function stepById(steps: SetupStep[], id: string) {
  const found = steps.find(step => step.id === id);
  if (!found) throw new Error(`missing step ${id}`);
  return found;
}

beforeEach(resetDb);

describe('integration state handling', () => {
  it('never reports a provider as connected without a backing record', async () => {
    const integrations = await getIntegrationStates(ORG);

    expect(integrations.gmail.connected).toBe(false);
    expect(integrations.retell.connected).toBe(false);
    expect(integrations.apollo.connected).toBe(false);
    expect(integrations.gmail.label).toBeNull();
  });

  it('reports Gmail connected with the mailbox identity once a row exists', async () => {
    db.connected_accounts = [{
      organization_id: ORG,
      provider: 'gmail',
      provider_account_id: 'sales@globonexo.com',
      expires_at: null,
    }];

    const { gmail } = await getIntegrationStates(ORG);

    expect(gmail.connected).toBe(true);
    expect(gmail.label).toBe('sales@globonexo.com');
  });

  it('distinguishes a provisioning number from an active one', async () => {
    db.agent_configs = [{ organization_id: ORG, retell_agent_id: 'agent_123' }];
    db.retell_phone_numbers = [{ organization_id: ORG, status: 'provisioning', phone_number: null }];

    const provisioning = await getIntegrationStates(ORG);
    expect(provisioning.retell.connected).toBe(false);
    expect(provisioning.retell.status).toBe('pending');
    expect(provisioning.retell.phoneNumber).toBeNull();

    db.retell_phone_numbers = [{ organization_id: ORG, status: 'active', phone_number: '+15551234567' }];
    const active = await getIntegrationStates(ORG);
    expect(active.retell.connected).toBe(true);
    expect(active.retell.phoneNumber).toBe('+15551234567');
  });

  it('marks unconfigured providers as unavailable rather than incomplete', async () => {
    envMock.APOLLO_API_KEY = '';
    envMock.RETELL_API_KEY = '';
    seedCompleteOnboarding();

    const { steps } = await getSetupState(ORG);

    expect(stepById(steps, 'apollo').status).toBe('unavailable');
    expect(stepById(steps, 'retell').status).toBe('unavailable');
  });
});

describe('setup step derivation', () => {
  it('derives onboarding steps from agent config content', async () => {
    const before = await getSetupState(ORG);
    expect(stepById(before.steps, 'profile').status).toBe('incomplete');
    expect(stepById(before.steps, 'product').status).toBe('incomplete');

    seedCompleteOnboarding();
    const after = await getSetupState(ORG);

    expect(stepById(after.steps, 'profile').status).toBe('complete');
    expect(stepById(after.steps, 'product').status).toBe('complete');
    expect(stepById(after.steps, 'icp').status).toBe('complete');
    expect(stepById(after.steps, 'outreach').status).toBe('complete');
  });

  it('completes lead, campaign, and launch steps only from real records', async () => {
    seedCompleteOnboarding();

    const empty = await getSetupState(ORG);
    expect(stepById(empty.steps, 'leads').status).toBe('incomplete');
    expect(stepById(empty.steps, 'campaign').status).toBe('incomplete');
    expect(stepById(empty.steps, 'launch').status).toBe('incomplete');

    db.leads = [{ organization_id: ORG, id: 'lead-1', source: 'csv' }];
    db.campaigns = [{ organization_id: ORG, id: 'c-1', status: 'draft' }];
    const drafted = await getSetupState(ORG);
    expect(stepById(drafted.steps, 'leads').status).toBe('complete');
    expect(stepById(drafted.steps, 'campaign').status).toBe('complete');
    expect(stepById(drafted.steps, 'launch').status).toBe('incomplete');

    db.campaigns = [{ organization_id: ORG, id: 'c-1', status: 'active' }];
    const launched = await getSetupState(ORG);
    expect(stepById(launched.steps, 'launch').status).toBe('complete');
  });

  it('points at the first unresolved step and excludes unavailable ones from the total', async () => {
    envMock.APOLLO_API_KEY = '';
    envMock.RETELL_API_KEY = '';
    seedCompleteOnboarding();

    const { summary, steps } = await getSetupState(ORG);

    expect(summary.nextStepId).toBe('gmail');
    expect(summary.total).toBe(steps.length - 2);
    expect(summary.allRequiredComplete).toBe(false);
  });
});

describe('availability step', () => {
  it('stays incomplete on the auto-created default row until the customer explicitly saves', async () => {
    seedCompleteOnboarding();
    // Mirrors calendar.service's getCalendarSettings auto-insert: a row exists
    // with generic defaults, but is_configured is only ever flipped by a PUT.
    db.calendar_settings = [{ organization_id: ORG, is_configured: false }];

    const { steps } = await getSetupState(ORG);

    expect(stepById(steps, 'calendar').status).toBe('incomplete');
  });

  it('completes once the customer has explicitly saved availability', async () => {
    seedCompleteOnboarding();
    db.calendar_settings = [{ organization_id: ORG, is_configured: true }];

    const { steps } = await getSetupState(ORG);

    expect(stepById(steps, 'calendar').status).toBe('complete');
  });
});

describe('setup progress persistence', () => {
  it('persists a skip for an optional step and counts it as resolved', async () => {
    seedCompleteOnboarding();

    const state = await setStepAcknowledgement(ORG, 'calendar', 'skip');
    const calendar = stepById(state.steps, 'calendar');

    expect(calendar.skipped).toBe(true);
    expect(calendar.status).toBe('incomplete');
    expect(state.summary.nextStepId).not.toBe('calendar');

    // Survives a fresh read — this is what makes it persistent per organization.
    const reread = await getSetupState(ORG);
    expect(stepById(reread.steps, 'calendar').skipped).toBe(true);
  });

  it('refuses to skip a required step', async () => {
    await expect(setStepAcknowledgement(ORG, 'gmail', 'skip')).rejects.toThrow(/cannot be skipped/i);
  });

  it('refuses to hand-complete a step that is derived from real data', async () => {
    await expect(setStepAcknowledgement(ORG, 'gmail', 'complete')).rejects.toThrow(/cannot be marked complete/i);
  });

  it('clears a skip on reset', async () => {
    await setStepAcknowledgement(ORG, 'retell', 'skip');
    const reset = await setStepAcknowledgement(ORG, 'retell', 'reset');
    expect(stepById(reset.steps, 'retell').skipped).toBe(false);
  });

  it('stores the tour position so it can resume after a refresh or logout', async () => {
    await updateTourState(ORG, { status: 'in_progress', lastStepId: 'prospects', lastStepIndex: 3, seenStepId: 'prospects' });

    const state = await getSetupState(ORG);

    expect(state.tour.status).toBe('in_progress');
    expect(state.tour.lastStepId).toBe('prospects');
    expect(state.tour.lastStepIndex).toBe(3);
    expect(state.tour.seenStepIds).toContain('prospects');
    expect(state.tour.startedAt).not.toBeNull();
  });

  it('keeps the copilot draft per organization and drops unknown keys', async () => {
    await saveCopilotDraft(ORG, {
      channel: 'both',
      campaignName: 'Q3 VP Sales',
      apiKey: 'should-not-persist',
      accessToken: 'should-not-persist',
    });

    const stored = db.org_setup_progress[0].copilot;
    expect(stored).toEqual({ channel: 'both', campaignName: 'Q3 VP Sales' });
    expect(stored).not.toHaveProperty('apiKey');
    expect(stored).not.toHaveProperty('accessToken');
  });
});

describe('tour state transitions', () => {
  it('records a start time once and a completion time on finish', () => {
    const started = applyTourPatch(normalizeTour({}), { status: 'in_progress' }, '2026-08-05T10:00:00.000Z');
    expect(started.startedAt).toBe('2026-08-05T10:00:00.000Z');

    const advanced = applyTourPatch(started, { lastStepIndex: 4, seenStepId: 'inbox' }, '2026-08-05T10:01:00.000Z');
    expect(advanced.startedAt).toBe('2026-08-05T10:00:00.000Z');
    expect(advanced.lastStepIndex).toBe(4);

    const finished = applyTourPatch(advanced, { status: 'completed' }, '2026-08-05T10:02:00.000Z');
    expect(finished.status).toBe('completed');
    expect(finished.completedAt).toBe('2026-08-05T10:02:00.000Z');
  });

  it('rewinds to the beginning when the tour is restarted from Settings', () => {
    const finished = applyTourPatch(normalizeTour({}), { status: 'completed', lastStepIndex: 9 });
    const restarted = applyTourPatch(finished, { status: 'not_started' });

    expect(restarted.lastStepIndex).toBe(0);
    expect(restarted.lastStepId).toBeNull();
    expect(restarted.seenStepIds).toEqual([]);
    expect(restarted.completedAt).toBeNull();
  });

  it('shows the tour once to an existing organization that predates the feature', async () => {
    // No org_setup_progress row at all — the state an account created before
    // this feature shipped is in.
    db.org_setup_progress = [];
    seedCompleteOnboarding();

    const first = await getSetupState(ORG);
    expect(first.tour.status).toBe('not_started');

    // They watch it and finish.
    await updateTourState(ORG, { status: 'in_progress', lastStepIndex: 0 });
    await updateTourState(ORG, { status: 'completed' });

    const afterward = await getSetupState(ORG);
    expect(afterward.tour.status).toBe('completed');
    expect(afterward.tour.completedAt).not.toBeNull();
  });

  it('does not re-open the tour for someone who skipped it', async () => {
    await updateTourState(ORG, { status: 'skipped' });
    const state = await getSetupState(ORG);
    expect(state.tour.status).toBe('skipped');
  });

  it('normalizes malformed stored tour state instead of throwing', () => {
    const tour = normalizeTour({ status: 'nonsense', lastStepIndex: -5, seenStepIds: 'not-an-array' });

    expect(tour.status).toBe('not_started');
    expect(tour.lastStepIndex).toBe(0);
    expect(tour.seenStepIds).toEqual([]);
  });
});

describe('copilot draft sanitisation', () => {
  it('rejects a draft that is too large to store', () => {
    expect(() => sanitizeCopilotDraft({ offer: 'x'.repeat(40_000) })).toThrow(/too large/i);
  });

  it('returns an empty draft for non-object input', () => {
    expect(sanitizeCopilotDraft(null)).toEqual({});
    expect(sanitizeCopilotDraft(['a'])).toEqual({});
  });
});

describe('summary maths', () => {
  it('counts skipped optional steps toward progress but not toward completion', () => {
    const steps: SetupStep[] = [
      { id: 'gmail', status: 'complete', detail: '', skipped: false, manual: false, dependsOn: [] },
      { id: 'calendar', status: 'incomplete', detail: '', skipped: true, manual: false, dependsOn: [] },
      { id: 'leads', status: 'incomplete', detail: '', skipped: false, manual: false, dependsOn: [] },
      { id: 'apollo', status: 'unavailable', detail: '', skipped: false, manual: false, dependsOn: [] },
    ];

    const summary = summarizeSteps(steps);

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(1);
    expect(summary.resolved).toBe(2);
    expect(summary.nextStepId).toBe('leads');
  });
});
