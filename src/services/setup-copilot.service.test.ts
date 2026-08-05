import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../types';

const { supabaseMock, integrationsMock, campaignsMock, clearDraftMock } = vi.hoisted(() => ({
  supabaseMock: { leads: [] as Array<Record<string, any>> },
  integrationsMock: {
    value: {
      gmail: { connected: true, status: 'connected', label: 'sales@x.com', detail: '' },
      calendar: { connected: true, status: 'connected', label: null, detail: '' },
      apollo: { connected: true, status: 'connected', label: null, detail: '' },
      retell: { connected: true, status: 'connected', label: null, detail: '', phoneNumber: '+15550001111', agentReady: true },
    },
  },
  campaignsMock: {
    createCampaign: vi.fn(),
    upsertSequenceSteps: vi.fn(),
    assignLeadsToCampaign: vi.fn(),
    setCampaignStatus: vi.fn(),
  },
  clearDraftMock: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({
          data: {
            agent_name: 'Nexo',
            company: 'Globonexo',
            product_description: 'An AI sales agent.',
            value_proposition: 'Books meetings.',
            pain_points: null,
            tone: 'consultative',
          },
          error: null,
        }),
        in: () => Promise.resolve({ data: supabaseMock.leads, error: null }),
      };
      return builder;
    },
  },
}));

vi.mock('../lib/openai', () => ({ openai: {} }));
vi.mock('../config/env', () => ({
  env: { AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_CHAT_DEPLOYMENT: 'test' },
}));
vi.mock('./ai.service', () => ({ sanitizeText: (value: string) => value }));
vi.mock('./campaigns.service', () => campaignsMock);
vi.mock('./setup.service', () => ({
  getIntegrationStates: () => Promise.resolve(integrationsMock.value),
  clearCopilotDraft: clearDraftMock,
}));

import {
  buildTemplatePreview,
  checkCampaignReadiness,
  createCampaignFromCopilot,
  generateCopilotPreview,
} from './setup-copilot.service';
import type { CopilotCampaignInput } from '../schemas/setup.schema';

const ORG = '00000000-0000-0000-0000-0000000000aa';

function baseInput(overrides: Partial<CopilotCampaignInput> = {}): CopilotCampaignInput {
  return {
    confirm: true,
    launch: false,
    name: 'Q3 VP Sales',
    channel: 'email',
    audience: 'US SaaS, 51-500 employees',
    offer: 'Book more meetings without more headcount',
    maxLeads: 100,
    dailySendCap: 75,
    callCadencePerHour: 5,
    voiceMode: 'ai',
    businessHoursStart: '09:00',
    businessHoursEnd: '17:00',
    timezone: 'America/New_York',
    steps: [],
    leadIds: [],
    ...overrides,
  } as CopilotCampaignInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  supabaseMock.leads = [];
  integrationsMock.value = {
    gmail: { connected: true, status: 'connected', label: 'sales@x.com', detail: '' },
    calendar: { connected: true, status: 'connected', label: null, detail: '' },
    apollo: { connected: true, status: 'connected', label: null, detail: '' },
    retell: { connected: true, status: 'connected', label: null, detail: '', phoneNumber: '+15550001111', agentReady: true },
  } as any;
  campaignsMock.createCampaign.mockResolvedValue({ id: 'camp-1', name: 'Q3 VP Sales', status: 'draft' });
  campaignsMock.assignLeadsToCampaign.mockResolvedValue({ assigned: 2 });
  campaignsMock.upsertSequenceSteps.mockResolvedValue({ steps: [] });
  campaignsMock.setCampaignStatus.mockResolvedValue({ id: 'camp-1', status: 'active' });
});

describe('campaign confirmation', () => {
  it('refuses to create anything without explicit confirmation', async () => {
    await expect(
      createCampaignFromCopilot(ORG, baseInput({ confirm: false as unknown as true })),
    ).rejects.toThrow(/confirmation is required/i);

    expect(campaignsMock.createCampaign).not.toHaveBeenCalled();
  });

  it('creates a draft without launching when launch was not requested', async () => {
    const result = await createCampaignFromCopilot(ORG, baseInput({ launch: false }));

    expect(campaignsMock.createCampaign).toHaveBeenCalledOnce();
    expect(campaignsMock.setCampaignStatus).not.toHaveBeenCalled();
    expect(result.launched).toBe(false);
    expect(result.launchError).toBeNull();
  });

  it('only reports a launch when the backend status change succeeded', async () => {
    const result = await createCampaignFromCopilot(ORG, baseInput({ launch: true }));

    expect(campaignsMock.setCampaignStatus).toHaveBeenCalledWith(ORG, 'camp-1', 'active');
    expect(result.launched).toBe(true);
  });

  it('reports launch failure honestly instead of claiming the campaign is live', async () => {
    campaignsMock.setCampaignStatus.mockRejectedValue(new AppError(400, 'No send-ready leads in this campaign'));

    const result = await createCampaignFromCopilot(ORG, baseInput({ launch: true }));

    expect(result.launched).toBe(false);
    expect(result.launchError).toBe('No send-ready leads in this campaign');
    expect(result.campaign.id).toBe('camp-1');
  });

  it('clears the saved draft once the campaign exists', async () => {
    await createCampaignFromCopilot(ORG, baseInput());
    expect(clearDraftMock).toHaveBeenCalledWith(ORG);
  });

  it('saves sequence steps for email campaigns and skips empty ones', async () => {
    await createCampaignFromCopilot(ORG, baseInput({
      steps: [
        { delayDays: 0, subjectTemplate: 'Quick question', bodyPromptContext: 'Intro' },
        { delayDays: 3, subjectTemplate: '', bodyPromptContext: '' },
        { delayDays: 5, subjectTemplate: 'Following up', bodyPromptContext: '' },
      ],
    }));

    expect(campaignsMock.upsertSequenceSteps).toHaveBeenCalledWith(ORG, 'camp-1', {
      steps: [
        { stepNumber: 1, delayDays: 0, subjectTemplate: 'Quick question', bodyPromptContext: 'Intro' },
        { stepNumber: 2, delayDays: 5, subjectTemplate: 'Following up', bodyPromptContext: '' },
      ],
    });
  });

  it('does not save an email sequence on a voice-only campaign', async () => {
    await createCampaignFromCopilot(ORG, baseInput({
      channel: 'voice',
      steps: [{ delayDays: 0, subjectTemplate: 'Hello', bodyPromptContext: '' }],
    }));

    expect(campaignsMock.upsertSequenceSteps).not.toHaveBeenCalled();
  });
});

describe('readiness checks', () => {
  it('blocks an email campaign when Gmail is not connected', async () => {
    integrationsMock.value.gmail = { connected: false, status: 'disconnected', label: null, detail: '' } as any;

    const readiness = await checkCampaignReadiness(ORG, 'email', []);

    expect(readiness.ok).toBe(false);
    expect(readiness.blockers[0]).toMatch(/No email account is connected/i);
  });

  it('blocks a voice campaign when the voice agent is not ready', async () => {
    integrationsMock.value.retell = {
      connected: false,
      status: 'pending',
      label: null,
      detail: 'Your included number is being provisioned.',
      phoneNumber: null,
      agentReady: false,
    } as any;

    const readiness = await checkCampaignReadiness(ORG, 'voice', []);

    expect(readiness.ok).toBe(false);
    expect(readiness.blockers[0]).toMatch(/provisioned/i);
  });

  it('warns rather than blocks when Calendar is disconnected', async () => {
    integrationsMock.value.calendar = { connected: false, status: 'disconnected', label: null, detail: '' } as any;

    const readiness = await checkCampaignReadiness(ORG, 'email', []);

    expect(readiness.ok).toBe(true);
    expect(readiness.warnings.join(' ')).toMatch(/Google Calendar is not connected/i);
  });

  it('blocks when no selected lead is contactable on the chosen channel', async () => {
    supabaseMock.leads = [
      { id: 'l1', email: 'a@x.com', phone: null, email_unsubscribed: true, do_not_email: false, do_not_call: false, status: 'new' },
    ];

    const readiness = await checkCampaignReadiness(ORG, 'email', ['l1']);

    expect(readiness.ok).toBe(false);
    expect(readiness.blockers.join(' ')).toMatch(/contactable email/i);
  });

  it('warns about suppressed leads that will be skipped', async () => {
    supabaseMock.leads = [
      { id: 'l1', email: 'a@x.com', phone: null, email_unsubscribed: false, do_not_email: false, do_not_call: false, status: 'new' },
      { id: 'l2', email: 'b@x.com', phone: null, email_unsubscribed: false, do_not_email: true, do_not_call: false, status: 'new' },
    ];

    const readiness = await checkCampaignReadiness(ORG, 'email', ['l1', 'l2']);

    expect(readiness.ok).toBe(true);
    expect(readiness.warnings.join(' ')).toMatch(/1 selected lead will be skipped/i);
  });

  it('blocks when a selected lead has disappeared from the workspace', async () => {
    supabaseMock.leads = [
      { id: 'l1', email: 'a@x.com', phone: null, email_unsubscribed: false, do_not_email: false, do_not_call: false, status: 'new' },
    ];

    const readiness = await checkCampaignReadiness(ORG, 'email', ['l1', 'gone']);

    expect(readiness.ok).toBe(false);
    expect(readiness.blockers.join(' ')).toMatch(/no longer available/i);
  });

  it('refuses to create a campaign that fails readiness', async () => {
    integrationsMock.value.gmail = { connected: false, status: 'disconnected', label: null, detail: '' } as any;

    await expect(createCampaignFromCopilot(ORG, baseInput())).rejects.toThrow(/No email account is connected/i);
    expect(campaignsMock.createCampaign).not.toHaveBeenCalled();
  });
});

describe('message preview', () => {
  it('falls back to a labelled template when AI generation is not configured', async () => {
    const preview = await generateCopilotPreview(ORG, {
      channel: 'both',
      campaignName: 'Q3 VP Sales',
      audience: 'US SaaS',
      offer: 'More meetings',
    });

    expect(preview.source).toBe('template');
    expect(preview.email?.body).toContain('{{first_name}}');
    expect(preview.call?.disclosure).toMatch(/powered by AI/i);
  });

  it('omits the channel that was not selected', () => {
    const emailOnly = buildTemplatePreview(
      { agent_name: 'Nexo', company: 'X', product_description: null, value_proposition: 'v', pain_points: null, tone: 'direct' },
      { channel: 'email', campaignName: 'c', audience: '', offer: '' },
    );
    expect(emailOnly.call).toBeNull();
    expect(emailOnly.email).not.toBeNull();

    const voiceOnly = buildTemplatePreview(
      { agent_name: 'Nexo', company: 'X', product_description: null, value_proposition: 'v', pain_points: null, tone: 'direct' },
      { channel: 'voice', campaignName: 'c', audience: '', offer: '' },
    );
    expect(voiceOnly.email).toBeNull();
    expect(voiceOnly.call).not.toBeNull();
  });
});
