import { openai } from '../lib/openai';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import { GenerateEmailInput, GenerateReplyInput, GenerateVoicePromptInput } from '../schemas/ai.schema';
import { z } from 'zod';

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

// ── Email generation ─────────────────────────────────────────────

function buildEmailSystemPrompt(
  agentConfig: any,
  campaign: any,
  tone: string,
  stepNumber: number,
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

  return `${baseContext}

TASK: ${stepInstructions[stepNumber] || stepInstructions[1]}

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
  const [agentResult, campaignResult, leadResult] = await Promise.all([
    supabase.from('agent_configs').select('*').eq('organization_id', orgId).single(),
    supabase.from('campaigns').select('*').eq('id', input.campaignId).eq('organization_id', orgId).single(),
    supabase.from('leads').select('*').eq('id', input.leadId).eq('organization_id', orgId).single(),
  ]);

  if (!agentResult.data) throw new AppError(404, 'Agent config not found');
  if (!campaignResult.data) throw new AppError(404, 'Campaign not found');
  if (!leadResult.data) throw new AppError(404, 'Lead not found');

  const agentConfig = agentResult.data;
  const campaign = campaignResult.data;
  const lead = leadResult.data;

  let previousEmails: any[] = [];
  if (input.stepNumber > 1) {
    const { data } = await supabase
      .from('email_messages')
      .select('subject, body, created_at')
      .eq('campaign_id', input.campaignId)
      .eq('lead_id', input.leadId)
      .order('created_at', { ascending: true });
    previousEmails = data || [];
  }

  const systemPrompt = buildEmailSystemPrompt(agentConfig, campaign, agentConfig.tone, input.stepNumber);
  const userPrompt = buildEmailUserPrompt(lead, input.stepNumber, previousEmails);

  const completion = await openai.chat.completions.create({
    model: '',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_completion_tokens: 1024,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new AppError(502, 'No response from AI model');

  const parsed = emailOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new AppError(502, 'AI returned invalid email format');

  return parsed.data;
}

// ── Reply generation ─────────────────────────────────────────────

function buildReplySystemPrompt(agentConfig: any): string {
  const toneInstruction = getToneInstruction(agentConfig.tone);

  return `You are ${agentConfig.agent_name}, an AI sales agent replying to a prospect's email.

PRODUCT: ${agentConfig.product_description}
VALUE PROPOSITION: ${agentConfig.value_proposition}
${agentConfig.objections ? `COMMON OBJECTIONS TO ADDRESS: ${agentConfig.objections}` : ''}
${agentConfig.booking_link ? `BOOKING LINK: ${agentConfig.booking_link}` : ''}

TONE: ${toneInstruction}

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

function buildReplyUserPrompt(thread: { outbound: any[]; reply: any }): string {
  let prompt = 'CONVERSATION HISTORY:\n';

  for (const msg of thread.outbound) {
    prompt += `\n--- OUR EMAIL ---\nSubject: ${msg.subject}\n${msg.body}\n`;
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

  const { data: agentConfig } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('organization_id', orgId)
    .single();

  if (!agentConfig) throw new AppError(404, 'Agent config not found');

  const { data: threadMessages } = await supabase
    .from('email_messages')
    .select('subject, body, created_at')
    .eq('lead_id', emailReply.lead_id)
    .eq('campaign_id', emailReply.email_messages.campaign_id)
    .order('created_at', { ascending: true });

  const thread = {
    outbound: threadMessages || [],
    reply: emailReply,
  };

  const systemPrompt = buildReplySystemPrompt(agentConfig);
  const userPrompt = buildReplyUserPrompt(thread);

  const completion = await openai.chat.completions.create({
    model: '',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_completion_tokens: 512,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new AppError(502, 'No response from AI model');

  const parsed = replyOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new AppError(502, 'AI returned invalid reply format');

  return parsed.data;
}

// ── Voice prompt generation ──────────────────────────────────────

export async function generateVoicePrompt(orgId: string, input: GenerateVoicePromptInput) {
  const [agentResult, campaignResult] = await Promise.all([
    supabase.from('agent_configs').select('*').eq('organization_id', orgId).single(),
    supabase.from('campaigns').select('*').eq('id', input.campaignId).eq('organization_id', orgId).single(),
  ]);

  if (!agentResult.data) throw new AppError(404, 'Agent config not found');
  if (!campaignResult.data) throw new AppError(404, 'Campaign not found');

  const agentConfig = agentResult.data;
  const campaign = campaignResult.data;
  const toneInstruction = getToneInstruction(agentConfig.tone);

  const prompt = `You are ${agentConfig.agent_name}, an AI sales agent making outbound phone calls.

COMPLIANCE — YOU MUST FOLLOW THESE RULES:
1. At the very start of every call, disclose that you are an AI assistant: "Hi, this is ${agentConfig.agent_name}, an AI assistant calling on behalf of [company]. Before we continue, I want to let you know this call is powered by AI."
2. Before recording, you MUST ask for verbal consent: "Do you mind if I record this call for quality purposes?"
3. If the prospect says no to recording, continue the call without recording.
4. If the prospect asks you to stop calling or remove them, acknowledge immediately and end the call politely.

ABOUT YOU:
- Product: ${agentConfig.product_description}
- Value Proposition: ${agentConfig.value_proposition}
${agentConfig.objections ? `- Common Objections: ${agentConfig.objections}` : ''}
${campaign.prompt_context ? `- Campaign Context: ${campaign.prompt_context}` : ''}

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
- {{lead_name}} — prospect's full name
- {{lead_title}} — prospect's job title
- {{lead_company}} — prospect's company name
- {{lead_email}} — prospect's email address

Keep responses concise and conversational. Do not monologue.`;

  return { prompt };
}
