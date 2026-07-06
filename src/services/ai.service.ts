import { openai } from '../lib/openai';
import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import { AppError } from '../types';
import { withRetry } from '../lib/retry';
import { ensureAgentConfig } from './agent-config.service';
import { GenerateEmailInput, GenerateReplyInput, GenerateVoicePromptInput } from '../schemas/ai.schema';
import { z } from 'zod';

const AI_TIMEOUT_MS = 30_000;

const emailOutputSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

const replyOutputSchema = z.object({
  body: z.string(),
});

const TONE_DESCRIPTIONS: Record<string, string> = {
  consultative:
    'Ask questions, show curiosity about their business, and position yourself as an advisor rather than a seller. Use a warm but professional tone.',
  direct:
    'Get straight to the point. Lead with the value, keep sentences short, and include a clear call to action. No fluff.',
  friendly:
    'Be conversational and approachable. Use casual language, light humor where appropriate, and make the reader feel like they are hearing from a colleague.',
  formal:
    'Use polished, professional language. Maintain a respectful and structured tone suitable for senior executives and enterprise buyers.',
  challenger:
    'Lead with a provocative insight or industry trend that challenges the prospect\'s current approach. Be bold and confident, backed by data or logic.',
};

function getToneInstruction(tone: string): string {
  return TONE_DESCRIPTIONS[tone] || TONE_DESCRIPTIONS.consultative;
}

function sanitizeText(text: string): string {
  return text
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/‘/g, "'")
    .replace(/’/g, "'")
    .replace(/“/g, '"')
    .replace(/”/g, '"')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    .replace(/ /g, ' ')
    .replace(/﻿/g, '')
    .replace(/​/g, '')
    .replace(/‍/g, '')
    .replace(/‌/g, '')
    .replace(/­/g, '');
}

function sanitizeDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return sanitizeText(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeDeep);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = sanitizeDeep(v);
    return result;
  }
  return obj;
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braced = raw.match(/\{[\s\S]*\}/);
  if (braced) return braced[0];
  return raw.trim();
}

function parseJsonSafe<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (e) {
    console.error(`[ai] Failed to parse ${label} JSON. Raw response:`, raw);
    throw new AppError(502, `AI returned malformed JSON for ${label}`);
  }

  const sanitized = sanitizeDeep(json);
  const result = schema.safeParse(sanitized);
  if (!result.success) {
    throw new AppError(502, `AI returned invalid ${label} format`);
  }
  return result.data;
}

function createTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ── Email generation ─────────────────────────────────────────────

function buildEmailSystemPrompt(
  agentConfig: any,
  campaign: any,
  tone: string,
  stepNumber: number,
  stepContext?: string | null,
): string {
  const toneInstruction = getToneInstruction(tone);

  const baseContext = `You are ${agentConfig.agent_name}, an AI sales agent.

PRODUCT: ${agentConfig.product_description}
VALUE PROPOSITION: ${agentConfig.value_proposition}
${agentConfig.objections ? `COMMON OBJECTIONS TO ADDRESS: ${agentConfig.objections}` : ''}
${agentConfig.booking_link ? `BOOKING LINK: ${agentConfig.booking_link}` : ''}
${campaign.prompt_context ? `CAMPAIGN CONTEXT: ${campaign.prompt_context}` : ''}

TONE: ${toneInstruction}`;

  const stepInstructions: Record<number, string> = {
    1: `Write a cold outreach intro email. Personalize it using the prospect's name, title, and company. Mention a specific pain point or opportunity relevant to their role. Keep it under 150 words. Do NOT include a subject line prefix like "Subject:". End with a soft call to action (question or invite).`,
    2: `Write a follow-up email referencing the first email that was sent. Do NOT repeat the same pitch. Add a new angle, a brief case study mention, or a relevant insight. Keep it under 120 words. Assume the prospect saw but didn't reply to the first email.`,
    3: `Write a final breakup email. Be brief (under 80 words), acknowledge you don't want to be a nuisance, and give one last reason to connect.${agentConfig.booking_link ? ' Include the booking link as a final CTA.' : ''} Make it easy for them to say "not now" without burning the bridge.`,
  };

  const task = stepInstructions[stepNumber] || stepInstructions[1];
  const customContext = stepContext ? `\nADDITIONAL INSTRUCTIONS FOR THIS STEP: ${stepContext}` : '';

  return `${baseContext}

TASK: ${task}${customContext}

Respond with JSON: { "subject": "...", "body": "..." }
The body should be plain text (no HTML). Use line breaks for paragraphs.`;
}

function buildEmailUserPrompt(lead: any, stepNumber: number, previousEmails: any[]): string {
  let prompt = `PROSPECT:
- Name: ${lead.first_name || ''} ${lead.last_name || ''}
- Title: ${lead.title || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
${lead.location ? `- Location: ${lead.location}` : ''}
${lead.linkedin_url ? `- LinkedIn: ${lead.linkedin_url}` : ''}`;

  if (stepNumber > 1 && previousEmails.length > 0) {
    prompt += '\n\nPREVIOUS EMAILS IN SEQUENCE:';
    for (const email of previousEmails) {
      prompt += `\n---\nSubject: ${email.subject}\n${email.body}`;
    }
  }

  return prompt;
}

export async function generateEmail(orgId: string, input: GenerateEmailInput) {
  const [agentConfig, campaignResult, leadResult] = await Promise.all([
    ensureAgentConfig(orgId),
    supabase.from('campaigns').select('*').eq('id', input.campaignId).eq('organization_id', orgId).single(),
    supabase.from('leads').select('*').eq('id', input.leadId).eq('organization_id', orgId).single(),
  ]);

  if (!campaignResult.data) throw new AppError(404, 'Campaign not found');
  if (!leadResult.data) throw new AppError(404, 'Lead not found');

  const campaign = campaignResult.data;
  const lead = leadResult.data;

  const [previousEmailsResult, sequenceStepResult] = await Promise.all([
    input.stepNumber > 1
      ? supabase
          .from('email_messages')
          .select('subject, body, created_at')
          .eq('campaign_id', input.campaignId)
          .eq('lead_id', input.leadId)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [] }),
    supabase
      .from('email_sequence_steps')
      .select('body_prompt_context')
      .eq('campaign_id', input.campaignId)
      .eq('step_number', input.stepNumber)
      .maybeSingle(),
  ]);

  const previousEmails = previousEmailsResult.data || [];
  const stepContext = sequenceStepResult.data?.body_prompt_context || null;

  const systemPrompt = sanitizeText(buildEmailSystemPrompt(agentConfig, campaign, agentConfig.tone, input.stepNumber, stepContext));
  const userPrompt = sanitizeText(buildEmailUserPrompt(lead, input.stepNumber, previousEmails));

  const raw = await withRetry(async () => {
    const timeout = createTimeout();
    try {
      const completion = await openai.chat.completions.create({
        model: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_completion_tokens: 1024,
      }, { signal: timeout.signal });

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new AppError(502, 'No response from AI model');
      return content;
    } finally {
      timeout.clear();
    }
  }, { label: 'generate-email' });

  return parseJsonSafe(raw, emailOutputSchema, 'email');
}

// ── Reply generation ─────────────────────────────────────────────

function buildReplySystemPrompt(agentConfig: any, hasHistory: boolean): string {
  const toneInstruction = getToneInstruction(agentConfig.tone);

  const historyNote = hasHistory
    ? ''
    : '\nNOTE: The original outreach emails are unavailable. Reply based on the prospect\'s message and your product knowledge.\n';

  return `You are ${agentConfig.agent_name}, an AI sales agent replying to a prospect's email.

PRODUCT: ${agentConfig.product_description}
VALUE PROPOSITION: ${agentConfig.value_proposition}
${agentConfig.objections ? `COMMON OBJECTIONS TO ADDRESS: ${agentConfig.objections}` : ''}
${agentConfig.booking_link ? `BOOKING LINK: ${agentConfig.booking_link}` : ''}

TONE: ${toneInstruction}
${historyNote}
RULES:
- Reply naturally to what the prospect said.
- If they asked a question, answer it directly.
- If they expressed interest, move toward booking a meeting.${agentConfig.booking_link ? ` Share the booking link: ${agentConfig.booking_link}` : ''}
- If they objected, address the objection with empathy and redirect.
- If they asked to unsubscribe or said "not interested", acknowledge politely and do NOT push further.
- Keep the reply under 120 words.

Respond with JSON: { "body": "..." }
The body should be plain text (no HTML). Use line breaks for paragraphs.`;
}

function buildReplyUserPrompt(
  thread: { outbound: any[]; reply: any },
  lead: { first_name?: string; last_name?: string; title?: string; company?: string } | null,
): string {
  let prompt = '';

  if (lead) {
    prompt += `PROSPECT:
- Name: ${lead.first_name || ''} ${lead.last_name || ''}
- Title: ${lead.title || 'Unknown'}
- Company: ${lead.company || 'Unknown'}\n\n`;
  }

  if (thread.outbound.length > 0) {
    prompt += 'CONVERSATION HISTORY:\n';
    for (const msg of thread.outbound) {
      prompt += `\n--- OUR EMAIL ---\nSubject: ${msg.subject}\n${msg.body}\n`;
    }
  }

  prompt += `\n--- PROSPECT'S REPLY ---\n${thread.reply.body}\n`;
  prompt += '\nDraft a reply to the prospect.';

  return prompt;
}

export async function generateReply(orgId: string, input: GenerateReplyInput) {
  const { data: emailReply } = await supabase
    .from('email_replies')
    .select('*, email_messages!inner(*, campaigns(*))')
    .eq('id', input.emailReplyId)
    .eq('organization_id', orgId)
    .single();

  if (!emailReply) throw new AppError(404, 'Email reply not found');

  const agentConfig = await ensureAgentConfig(orgId);

  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, last_name, title, company')
    .eq('id', emailReply.lead_id)
    .single();

  let outbound: any[] = [];
  const campaignId = emailReply.email_messages?.campaign_id;

  if (campaignId) {
    const { data: threadMessages } = await supabase
      .from('email_messages')
      .select('subject, body, created_at')
      .eq('lead_id', emailReply.lead_id)
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true });
    outbound = threadMessages || [];
  }

  if (outbound.length === 0 && emailReply.email_messages) {
    outbound = [{
      subject: emailReply.email_messages.subject,
      body: emailReply.email_messages.body,
    }];
  }

  const thread = { outbound, reply: emailReply };
  const hasHistory = outbound.length > 0;

  const systemPrompt = sanitizeText(buildReplySystemPrompt(agentConfig, hasHistory));
  const userPrompt = sanitizeText(buildReplyUserPrompt(thread, lead));

  const raw = await withRetry(async () => {
    const timeout = createTimeout();
    try {
      const completion = await openai.chat.completions.create({
        model: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_completion_tokens: 512,
      }, { signal: timeout.signal });

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new AppError(502, 'No response from AI model');
      return content;
    } finally {
      timeout.clear();
    }
  }, { label: 'generate-reply' });

  return parseJsonSafe(raw, replyOutputSchema, 'reply');
}

// ── Voice prompt generation ──────────────────────────────────────

export async function generateVoicePrompt(orgId: string, input: GenerateVoicePromptInput) {
  const agentConfig = await ensureAgentConfig(orgId);

  let campaignContext = '';
  if (input.campaignId) {
    const campaignResult = await supabase
      .from('campaigns')
      .select('prompt_context')
      .eq('id', input.campaignId)
      .eq('organization_id', orgId)
      .single();
    if (!campaignResult.data) throw new AppError(404, 'Campaign not found');
    if (campaignResult.data.prompt_context) {
      campaignContext = `- Campaign Context: ${campaignResult.data.prompt_context}`;
    }
  }

  const toneInstruction = getToneInstruction(agentConfig.tone);

  const prompt = `You are ${agentConfig.agent_name}, an AI sales agent making outbound phone calls.

COMPLIANCE - YOU MUST FOLLOW THESE RULES:
1. At the very start of every call, disclose that you are an AI assistant: "Hi, this is ${agentConfig.agent_name}, an AI assistant calling on behalf of [company]. Before we continue, I want to let you know this call is powered by AI."
2. Before recording, you MUST ask for verbal consent: "Do you mind if I record this call for quality purposes?"
3. If the prospect says no to recording, continue the call without recording.
4. If the prospect asks you to stop calling or remove them, acknowledge immediately and end the call politely.

ABOUT YOU:
- Product: ${agentConfig.product_description}
- Value Proposition: ${agentConfig.value_proposition}
${agentConfig.objections ? `- Common Objections: ${agentConfig.objections}` : ''}
${campaignContext}

TONE: ${toneInstruction}

CALL STRUCTURE:
1. Greet the prospect by name: "Hi {{lead_name}}, this is ${agentConfig.agent_name}..."
2. Deliver the AI disclosure immediately.
3. Give a one-sentence reason for calling tied to their role as {{lead_title}} at {{lead_company}}.
4. Ask an open-ended qualifying question.
5. Listen and respond to their answers naturally.
6. If there is interest, propose a meeting: "I'd love to set up a quick 15-minute call with our team. Would {{lead_name}}, does sometime this week work?"${agentConfig.booking_link ? ` Mention you will send a booking link to their email.` : ''}
7. If not interested, thank them for their time and end politely.

VARIABLES AVAILABLE AT CALL TIME:
- {{lead_name}} - prospect's full name
- {{lead_title}} - prospect's job title
- {{lead_company}} - prospect's company name
- {{lead_email}} - prospect's email address

Keep responses concise and conversational. Do not monologue.`;

  return { prompt: sanitizeText(prompt) };
}
