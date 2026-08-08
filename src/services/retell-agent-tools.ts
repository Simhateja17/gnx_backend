import { env } from '../config/env';

export const RETELL_GENERAL_TOOLS = [
  {
    name: 'end_call',
    type: 'end_call' as const,
    description: 'End the call when the conversation has naturally concluded, the caller says goodbye, or asks not to be contacted again.',
  },
];

function customTool(
  name: string,
  path: string,
  description: string,
  parameters: Record<string, unknown>,
) {
  return {
    name,
    type: 'custom' as const,
    url: `${env.BACKEND_PUBLIC_URL}/webhooks/retell/tools/${path}`,
    method: 'POST' as const,
    headers: { 'x-tool-secret': env.RETELL_TOOL_SECRET },
    description,
    speak_during_execution: true,
    speak_after_execution: true,
    timeout_ms: 8000,
    max_retry: 0,
    parameters,
  };
}

export function buildMeetingTools() {
  return [
    customTool(
      'check_availability',
      'check-availability',
      'Look up open meeting slots. Call immediately after the caller agrees to a meeting, and again after they state a different preferred day or time.',
      {
        type: 'object',
        properties: {
          preferred_day: { type: 'string', description: 'Preferred day, if stated.' },
          preferred_time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening'], description: 'Preferred time of day, if stated.' },
        },
      },
    ),
    customTool(
      'book_meeting',
      'book-meeting',
      'Book the exact slot the caller just confirmed. If this is an unidentified inbound caller, call create_inbound_lead first.',
      {
        type: 'object',
        properties: {
          start_at: { type: 'string', description: 'Exact ISO 8601 start time copied from check_availability.' },
        },
        required: ['start_at'],
      },
    ),
    customTool(
      'reschedule_meeting',
      'reschedule-meeting',
      'Move an existing meeting after check_availability finds a new slot and the caller agrees.',
      {
        type: 'object',
        properties: {
          new_start_at: { type: 'string', description: 'New ISO 8601 start time the caller agreed to.' },
        },
        required: ['new_start_at'],
      },
    ),
    customTool(
      'cancel_meeting',
      'cancel-meeting',
      'Cancel the caller\'s existing booked meeting when they do not want to reschedule.',
      { type: 'object', properties: {} },
    ),
  ];
}

export function buildInboundIdentityTools() {
  return [
    customTool(
      'identify_caller',
      'identify-caller',
      'Use only when the inbound call was not matched by phone, or the person says the phone match is wrong. Ask for both name and company first. Treat ambiguous or failed lookup as unknown.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Caller\'s confirmed full name.' },
          company: { type: 'string', description: 'Caller\'s confirmed company name.' },
        },
        required: ['name', 'company'],
      },
    ),
    customTool(
      'create_inbound_lead',
      'create-inbound-lead',
      'Create a new inbound lead only after an unidentified caller explicitly requests follow-up or agrees to book a meeting. Confirm name, company, and email before calling.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Confirmed full name.' },
          company: { type: 'string', description: 'Confirmed company.' },
          email: { type: 'string', description: 'Confirmed email address.' },
          intent: { type: 'string', enum: ['meeting', 'follow_up'], description: 'The high-intent action explicitly requested.' },
        },
        required: ['name', 'company', 'email', 'intent'],
      },
    ),
  ];
}

export function buildOutboundAgentTools() {
  return [...RETELL_GENERAL_TOOLS, ...buildMeetingTools()];
}

export function buildInboundAgentTools() {
  return [...RETELL_GENERAL_TOOLS, ...buildInboundIdentityTools(), ...buildMeetingTools()];
}
