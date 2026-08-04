import { openai } from '../lib/openai';
import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import { AppError } from '../types';
import { withRetry } from '../lib/retry';
import { ensureAgentConfig } from './agent-config.service';
import { getToneInstruction, sanitizeText } from './ai.service';
import { searchApolloForIcp, getHotLeadsSummary } from './leads.service';
import { pauseAllActiveEmailCampaigns } from './campaigns.service';
import { draftEarlyFollowUps } from './email.service';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

const AGENT_CHAT_TIMEOUT_MS = 45_000;
const MAX_TOOL_ROUNDTRIPS = 3;
const HISTORY_LIMIT = 20;

type AgentMessageRow = {
  id: string;
  role: 'user' | 'agent';
  kind: 'text' | 'stats' | 'draft_review';
  content: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function toApiMessage(row: AgentMessageRow) {
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function listAgentMessages(orgId: string) {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('id, role, kind, content, metadata, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) throw new AppError(500, 'Failed to load agent chat history', error);
  return { items: ((data ?? []) as AgentMessageRow[]).map(toApiMessage) };
}

async function saveMessage(
  orgId: string,
  role: 'user' | 'agent',
  kind: 'text' | 'stats' | 'draft_review',
  content: string | null,
  metadata?: Record<string, unknown> | null,
) {
  const { data, error } = await supabase
    .from('agent_messages')
    .insert({ organization_id: orgId, role, kind, content, metadata: metadata ?? null })
    .select('id, role, kind, content, metadata, created_at')
    .single();

  if (error || !data) throw new AppError(500, 'Failed to save agent chat message', error);
  return toApiMessage(data as AgentMessageRow);
}

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_icp_leads',
      description:
        "Search Apollo for new leads matching the organization's ideal customer profile (ICP) and save them. Use whenever the user asks to find, get, or generate leads/accounts/prospects, e.g. 'give me 50 ICP leads', 'find VP Sales in Texas'.",
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'How many net-new leads the user wants. Defaults to 50 if unspecified. Capped at 100.' },
          titles: { type: 'array', items: { type: 'string' }, description: "Job titles to target. Omit to use the organization's saved ICP titles." },
          locations: { type: 'array', items: { type: 'string' }, description: "Locations to target. Omit to use the organization's saved ICP locations." },
          companySizes: { type: 'array', items: { type: 'string' }, description: "Company size ranges, e.g. '50,200'. Omit to use the organization's saved ICP company sizes." },
          keywords: { type: 'string', description: 'Free-text keywords to narrow the search, e.g. industry or product terms.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_hot_leads',
      description:
        "Summarize the organization's hottest (highest-scored) leads. Use for requests like 'summarize my hottest leads' or 'who should I focus on'.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many leads to return. Defaults to 5.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_campaigns',
      description:
        "Pause all currently active email campaigns. Use for requests like 'pause weekend sending' or 'stop sending emails for now'.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_early_followups',
      description:
        "Generate the next scheduled follow-up email early for leads who haven't replied yet, and hold each one for human review instead of sending it immediately. Use for requests like 'draft follow-ups for no-replies'.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max number of leads to draft for in this request. Defaults to 10, capped at 10.' },
        },
      },
    },
  },
];

function buildSystemPrompt(agentName: string, tone: string): string {
  return `You are ${agentName}, an AI sales agent operating inside a sales outreach platform. You act on the user's behalf using the tools available to you.

TONE: ${getToneInstruction(tone)}

HARD RULES - THESE OVERRIDE EVERYTHING ELSE:
1. Never claim an action happened unless you actually called the matching tool and it succeeded. If no tool matches the request, say so plainly and explain what you can do instead - never invent a result.
2. Base every number, name, or fact in your reply strictly on the tool's real output. Never round up, estimate, or state the number the user asked for instead of the number actually achieved.
3. If a tool call fails or returns partial/zero results, state the real reason plainly, using only what the tool actually reported (e.g. a providerDetails field) - never guess or infer a cause (like "billing" or "payment") that wasn't in the tool's output. Never respond with a vague "something went wrong, try again" when you know the actual cause.
4. When a failure comes from a third-party provider (Apollo, the email provider, etc.), always name that provider explicitly in your reply (e.g. "Apollo's account has a payment issue" or "the search provider is rejecting requests"). Never say bare "billing" or "payment issue" with no owner - the user has their own separate subscription billing here, and an unnamed "billing" problem reads as being about that, not a third-party vendor's account.
5. Do not ask the user to confirm before calling a tool - act immediately on clear requests.
6. Keep replies concise and to the point. No filler, no over-explaining.`;
}

function createTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_CHAT_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function callChatCompletion(messages: ChatCompletionMessageParam[]) {
  const timeout = createTimeout();
  try {
    return await openai.chat.completions.create({
      model: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.4,
      max_completion_tokens: 700,
    }, { signal: timeout.signal });
  } finally {
    timeout.clear();
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function executeTool(orgId: string, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'search_icp_leads':
      return searchApolloForIcp(orgId, {
        count: typeof args.count === 'number' ? args.count : undefined,
        titles: Array.isArray(args.titles) ? (args.titles as string[]) : undefined,
        locations: Array.isArray(args.locations) ? (args.locations as string[]) : undefined,
        companySizes: Array.isArray(args.companySizes) ? (args.companySizes as string[]) : undefined,
        keywords: typeof args.keywords === 'string' ? args.keywords : undefined,
      });
    case 'summarize_hot_leads':
      return getHotLeadsSummary(orgId, typeof args.limit === 'number' ? args.limit : undefined);
    case 'pause_campaigns':
      return pauseAllActiveEmailCampaigns(orgId);
    case 'draft_early_followups':
      return draftEarlyFollowUps(orgId, { limit: typeof args.limit === 'number' ? args.limit : undefined });
    default:
      throw new AppError(400, `Unknown tool: ${name}`);
  }
}

type ToolOutcome = { name: string; output: any };

function buildMetadata(toolOutcome: ToolOutcome | null): Record<string, unknown> | null {
  if (!toolOutcome) return null;

  if (toolOutcome.name === 'draft_early_followups' && Array.isArray(toolOutcome.output?.drafted)) {
    return { tool: toolOutcome.name, drafts: toolOutcome.output.drafted };
  }
  if (toolOutcome.name === 'search_icp_leads' && !toolOutcome.output?.error) {
    return {
      tool: toolOutcome.name,
      stats: [
        [toolOutcome.output.inserted, 'new leads'],
        [toolOutcome.output.skippedDuplicates, 'duplicates skipped'],
      ],
    };
  }
  return { tool: toolOutcome.name };
}

function resolveKind(toolOutcome: ToolOutcome | null): 'text' | 'stats' | 'draft_review' {
  if (!toolOutcome || toolOutcome.output?.error) return 'text';
  if (toolOutcome.name === 'draft_early_followups') {
    return Array.isArray(toolOutcome.output?.drafted) && toolOutcome.output.drafted.length > 0 ? 'draft_review' : 'text';
  }
  if (toolOutcome.name === 'search_icp_leads' || toolOutcome.name === 'summarize_hot_leads') return 'stats';
  return 'text';
}

export async function handleAgentMessage(orgId: string, userMessage: string) {
  await saveMessage(orgId, 'user', 'text', userMessage);

  const [agentConfig, historyResult] = await Promise.all([
    ensureAgentConfig(orgId),
    supabase
      .from('agent_messages')
      .select('role, content')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  const history = (historyResult.data ?? []).slice().reverse() as Array<{ role: 'user' | 'agent'; content: string | null }>;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: sanitizeText(buildSystemPrompt(agentConfig.agent_name, agentConfig.tone)) },
    ...history.map((m): ChatCompletionMessageParam => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content ?? '',
    })),
  ];

  let toolOutcome: ToolOutcome | null = null;
  let finalText: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
    const completion = await withRetry(() => callChatCompletion(messages), { label: 'agent-chat' });
    const choice = completion.choices[0]?.message;
    if (!choice) throw new AppError(502, 'No response from AI model');

    if (choice.tool_calls && choice.tool_calls.length > 0) {
      messages.push({ role: 'assistant', content: choice.content ?? null, tool_calls: choice.tool_calls });

      // Execute only the first tool call - one action per user message keeps
      // behavior predictable and stops ambiguous phrasing from silently
      // chaining unrelated side effects.
      const call = choice.tool_calls[0];
      const args = safeParseArgs(call.function.arguments);

      try {
        const output = await executeTool(orgId, call.function.name, args);
        toolOutcome = { name: call.function.name, output };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      } catch (err: any) {
        const message = err instanceof AppError ? err.message : (err?.message ?? 'Tool execution failed');
        // Surface the provider's actual response text (e.g. Apollo's raw error
        // body) alongside our own message, so the model explains the real
        // cause instead of guessing one from the HTTP status code alone.
        const details = err instanceof AppError && err.details ? String(err.details).slice(0, 500) : undefined;
        const errorPayload = details ? { error: message, providerDetails: details } : { error: message };
        toolOutcome = { name: call.function.name, output: errorPayload };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(errorPayload) });
      }

      for (const extraCall of choice.tool_calls.slice(1)) {
        messages.push({
          role: 'tool',
          tool_call_id: extraCall.id,
          content: JSON.stringify({ skipped: true, reason: 'Only one action is executed per message.' }),
        });
      }
      continue;
    }

    finalText = choice.content?.trim() || null;
    break;
  }

  if (!finalText) {
    finalText = toolOutcome
      ? "I ran that, but didn't get a clear summary back - check the relevant page for the result."
      : "I'm not sure how to help with that yet. I can search for ICP leads, summarize your hottest leads, pause active campaigns, or draft follow-ups for leads who haven't replied.";
  }

  return saveMessage(orgId, 'agent', resolveKind(toolOutcome), sanitizeText(finalText), buildMetadata(toolOutcome));
}
