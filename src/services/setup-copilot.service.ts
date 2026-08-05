import { supabase } from '../lib/supabase';
import { openai } from '../lib/openai';
import { env } from '../config/env';
import { AppError } from '../types';
import { withRetry } from '../lib/retry';
import { sanitizeText } from './ai.service';
import {
  assignLeadsToCampaign,
  createCampaign,
  setCampaignStatus,
  upsertSequenceSteps,
} from './campaigns.service';
import { getIntegrationStates, clearCopilotDraft } from './setup.service';
import type { CopilotCampaignInput, CopilotPreviewInput } from '../schemas/setup.schema';

/**
 * Setup Copilot — the guided "create your first campaign" flow.
 *
 * Two hard rules are enforced here rather than in the UI:
 *  1. Nothing is created without `confirm: true` on the request.
 *  2. A campaign is only reported as launched when setCampaignStatus actually
 *     succeeded. A failed launch leaves a real draft and says so.
 */

const PREVIEW_TIMEOUT_MS = 20_000;

type AgentConfig = {
  agent_name: string | null;
  company: string | null;
  product_description: string | null;
  value_proposition: string | null;
  pain_points: string | null;
  tone: string | null;
};

async function loadAgentConfig(orgId: string): Promise<AgentConfig> {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('agent_name,company,product_description,value_proposition,pain_points,tone')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to load agent configuration', error);
  if (!data) {
    throw new AppError(409, 'Complete onboarding before creating a campaign so the agent knows what you sell.');
  }
  return data as AgentConfig;
}

function aiConfigured(): boolean {
  return Boolean(env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT);
}

// ---------------------------------------------------------------------------
// Message preview (generation only — nothing is ever sent or dialled here)
// ---------------------------------------------------------------------------

export type CopilotPreview = {
  generated: boolean;
  source: 'ai' | 'template';
  email: { subject: string; body: string } | null;
  call: { opening: string; disclosure: string; discovery: string[] } | null;
  note: string;
};

export function buildTemplatePreview(
  config: AgentConfig,
  input: CopilotPreviewInput,
): Pick<CopilotPreview, 'email' | 'call'> {
  const agentName = config.agent_name || 'your agent';
  const company = config.company || 'our team';
  const offer = input.offer || config.value_proposition || 'what we do';
  const audience = input.audience || 'your target accounts';

  const email = {
    subject: `Quick question about {{company}}`,
    body:
      `Hi {{first_name}},\n\n` +
      `I work with ${audience} at ${company}. ${offer}\n\n` +
      `Worth a short conversation to see whether it is relevant for you?\n\n` +
      `— ${agentName}`,
  };

  const call = {
    opening: `Hi {{first_name}}, this is ${agentName} calling on behalf of ${company}.`,
    disclosure: `Before we continue, I want to let you know this call is powered by AI.`,
    discovery: [
      `How does your team handle this today?`,
      `What made you look at options in this area?`,
      `Who else would need to be part of a decision like this?`,
    ],
  };

  return {
    email: input.channel === 'voice' ? null : email,
    call: input.channel === 'email' ? null : call,
  };
}

export async function generateCopilotPreview(
  orgId: string,
  input: CopilotPreviewInput,
): Promise<CopilotPreview> {
  const config = await loadAgentConfig(orgId);
  const template = buildTemplatePreview(config, input);

  if (!aiConfigured()) {
    return {
      generated: true,
      source: 'template',
      ...template,
      note: 'AI generation is not enabled on this workspace, so this is the structural template your campaign will follow.',
    };
  }

  const wantsEmail = input.channel !== 'voice';
  const wantsCall = input.channel !== 'email';

  const systemPrompt = sanitizeText(
    `You are ${config.agent_name || 'a sales agent'}, writing outbound sales messaging for ${config.company || 'a company'}.

PRODUCT: ${config.product_description || 'not described'}
VALUE PROPOSITION: ${config.value_proposition || 'not described'}
${config.pain_points ? `BUYER PAIN POINTS: ${config.pain_points}` : ''}
TONE: ${input.tone || config.tone || 'consultative'}

RULES:
- This is a preview for the customer, not a message to a real prospect.
- Use {{first_name}}, {{company}}, and {{title}} as placeholders. Never invent a real person or company.
- Never claim to know a prospect's internal problems. Ask, do not assert.
- Keep the email under 120 words.
- The call opening must disclose that the caller is an AI assistant.

Respond with JSON shaped exactly as:
{ "email": { "subject": string, "body": string }, "call": { "opening": string, "disclosure": string, "discovery": string[] } }
${wantsEmail ? '' : 'Set "email" to null.\n'}${wantsCall ? '' : 'Set "call" to null.\n'}`,
  );

  const userPrompt = sanitizeText(
    `CAMPAIGN: ${input.campaignName}
CHANNEL: ${input.channel}
TARGET AUDIENCE: ${input.audience || 'not specified'}
OFFER FOR THIS CAMPAIGN: ${input.offer || 'use the value proposition above'}

Draft the preview.`,
  );

  try {
    const raw = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
      try {
        const completion = await openai.chat.completions.create(
          {
            model: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_completion_tokens: 900,
          },
          { signal: controller.signal },
        );
        const content = completion.choices[0]?.message?.content;
        if (!content) throw new AppError(502, 'No response from AI model');
        return content;
      } finally {
        clearTimeout(timer);
      }
    }, { label: 'copilot-preview' });

    const parsed = JSON.parse(raw) as Partial<CopilotPreview>;
    const email = wantsEmail && parsed.email?.subject && parsed.email?.body
      ? { subject: String(parsed.email.subject), body: String(parsed.email.body) }
      : wantsEmail ? template.email : null;
    const call = wantsCall && parsed.call?.opening
      ? {
          opening: String(parsed.call.opening),
          disclosure: String(parsed.call.disclosure || template.call?.disclosure || ''),
          discovery: Array.isArray(parsed.call.discovery)
            ? parsed.call.discovery.slice(0, 5).map(String)
            : template.call?.discovery ?? [],
        }
      : wantsCall ? template.call : null;

    return {
      generated: true,
      source: 'ai',
      email,
      call,
      note: 'This is a preview. Each real message is personalised per lead at send time.',
    };
  } catch (err) {
    // A preview failure must never block setup — fall back to the template and
    // say plainly that generation did not run.
    console.warn('[setup-copilot] preview generation failed:', (err as Error).message);
    return {
      generated: false,
      source: 'template',
      ...template,
      note: 'AI preview could not be generated right now. This is the structural template your campaign will follow — you can retry the preview.',
    };
  }
}

// ---------------------------------------------------------------------------
// Readiness — real backend state, never an assumption
// ---------------------------------------------------------------------------

export type CopilotReadiness = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
};

export async function checkCampaignReadiness(
  orgId: string,
  channel: 'email' | 'voice' | 'both',
  leadIds: string[],
): Promise<CopilotReadiness> {
  const integrations = await getIntegrationStates(orgId);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (channel !== 'voice' && !integrations.gmail.connected) {
    blockers.push('No email account is connected, so this campaign cannot send email. Connect Gmail or custom SMTP/IMAP in Settings.');
  }
  if (channel !== 'email' && !integrations.retell.connected) {
    blockers.push(integrations.retell.detail);
  }
  if (!integrations.calendar.connected) {
    warnings.push('Google Calendar is not connected — the agent cannot book meetings directly.');
  }

  if (leadIds.length > 0) {
    const { data, error } = await supabase
      .from('leads')
      .select('id,email,phone,email_unsubscribed,do_not_email,do_not_call,status')
      .eq('organization_id', orgId)
      .in('id', leadIds);

    if (error) throw new AppError(500, 'Failed to verify selected leads', error);

    const rows = data ?? [];
    if (rows.length !== leadIds.length) {
      blockers.push('Some selected leads are no longer available in your workspace.');
    }

    const emailable = rows.filter(
      row => row.email && !row.email_unsubscribed && !row.do_not_email && row.status !== 'unsubscribed',
    ).length;
    const callable = rows.filter(row => row.phone && !row.do_not_call && row.status !== 'unsubscribed').length;
    const suppressed = rows.length - new Set([
      ...rows.filter(r => r.email && !r.email_unsubscribed && !r.do_not_email).map(r => r.id),
      ...rows.filter(r => r.phone && !r.do_not_call).map(r => r.id),
    ]).size;

    if (channel !== 'voice' && emailable === 0) {
      blockers.push('None of the selected leads have a contactable email address.');
    }
    if (channel !== 'email' && callable === 0) {
      blockers.push('None of the selected leads have a callable phone number.');
    }
    if (suppressed > 0) {
      warnings.push(`${suppressed} selected lead${suppressed === 1 ? '' : 's'} will be skipped due to unsubscribe, do-not-email, or do-not-call settings.`);
    }
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

// ---------------------------------------------------------------------------
// Campaign creation (confirmation required)
// ---------------------------------------------------------------------------

export type CopilotCampaignResult = {
  campaign: Awaited<ReturnType<typeof createCampaign>>;
  stepsSaved: number;
  leadsAssigned: number;
  launched: boolean;
  /** Set when launch was requested but the backend refused or failed. */
  launchError: string | null;
  warnings: string[];
};

export async function createCampaignFromCopilot(
  orgId: string,
  input: CopilotCampaignInput,
): Promise<CopilotCampaignResult> {
  if (input.confirm !== true) {
    throw new AppError(400, 'Explicit confirmation is required before a campaign can be created.');
  }

  const readiness = await checkCampaignReadiness(orgId, input.channel, input.leadIds);
  if (!readiness.ok) {
    throw new AppError(409, readiness.blockers[0], { blockers: readiness.blockers });
  }

  const promptNotes = [
    input.audience ? `Target audience: ${input.audience}` : '',
    input.offer ? `Offer: ${input.offer}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 2000);

  const campaign = await createCampaign(orgId, {
    name: input.name,
    channel: input.channel,
    icpSource: '',
    promptNotes,
    maxLeads: input.maxLeads,
    dailySendCap: input.dailySendCap,
    callCadencePerHour: input.callCadencePerHour,
    voiceMode: input.voiceMode,
    businessHoursStart: input.businessHoursStart,
    businessHoursEnd: input.businessHoursEnd,
    timezone: input.timezone,
  });

  let stepsSaved = 0;
  const usableSteps = input.steps
    .filter(step => step.subjectTemplate.trim() || step.bodyPromptContext.trim())
    .slice(0, 10)
    .map((step, index) => ({
      stepNumber: index + 1,
      delayDays: step.delayDays,
      subjectTemplate: step.subjectTemplate,
      bodyPromptContext: step.bodyPromptContext,
    }));

  if (input.channel !== 'voice' && usableSteps.length > 0) {
    await upsertSequenceSteps(orgId, campaign.id, { steps: usableSteps });
    stepsSaved = usableSteps.length;
  }

  let leadsAssigned = 0;
  if (input.leadIds.length > 0) {
    const assigned = await assignLeadsToCampaign(orgId, campaign.id, { leadIds: input.leadIds });
    leadsAssigned = typeof (assigned as { assigned?: number })?.assigned === 'number'
      ? (assigned as { assigned: number }).assigned
      : input.leadIds.length;
  }

  let launched = false;
  let launchError: string | null = null;

  if (input.launch) {
    try {
      await setCampaignStatus(orgId, campaign.id, 'active');
      launched = true;
    } catch (err) {
      // The campaign genuinely exists as a draft; only the launch failed. Report
      // that accurately rather than claiming outreach has started.
      launchError = err instanceof AppError
        ? err.message
        : 'The campaign was saved as a draft but could not be launched.';
    }
  }

  await clearCopilotDraft(orgId);

  return {
    campaign,
    stepsSaved,
    leadsAssigned,
    launched,
    launchError,
    warnings: readiness.warnings,
  };
}
