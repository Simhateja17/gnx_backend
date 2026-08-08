import { supabase } from '../lib/supabase';
import { AppError } from '../types';
import * as calendarService from './calendar.service';

// The LLM supplies `call_id` inside its own tool args in theory, but that
// makes org/lead identity a client-controlled value on an unauthenticated
// endpoint. Instead we trust only the `call` object Retell itself attaches
// to every custom-function invocation, and resolve org/lead from our own
// `calls` record - the same trust boundary the call_analyzed webhook uses.
async function resolveCallContext(retellCallId: string | undefined) {
  if (!retellCallId) throw new AppError(400, 'Missing call context');
  const { data: call, error } = await supabase
    .from('calls')
    .select('id, organization_id, lead_id, campaign_id')
    .eq('retell_call_id', retellCallId)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to resolve call context', error);
  if (!call) throw new AppError(404, 'Unknown call');
  return call;
}

export async function handleRetellTool(toolName: string, body: any) {
  const retellCallId: string | undefined = body?.call?.call_id ?? body?.call_id;
  const args = (body?.args ?? {}) as Record<string, unknown>;
  const call = await resolveCallContext(retellCallId);

  switch (toolName) {
    case 'check-availability':
      return calendarService.checkAvailability(call.organization_id, {
        preferredDay: typeof args.preferred_day === 'string' ? args.preferred_day : undefined,
        preferredTimeOfDay: typeof args.preferred_time_of_day === 'string' ? args.preferred_time_of_day : undefined,
      });

    case 'book-meeting':
      if (typeof args.start_at !== 'string' || !args.start_at) {
        throw new AppError(400, 'start_at is required');
      }
      return calendarService.bookMeeting(call.organization_id, {
        leadId: call.lead_id,
        campaignId: call.campaign_id,
        callId: call.id,
        startAt: args.start_at,
      });

    case 'reschedule-meeting':
      if (typeof args.new_start_at !== 'string' || !args.new_start_at) {
        throw new AppError(400, 'new_start_at is required');
      }
      return calendarService.rescheduleMeetingForLead(call.organization_id, call.lead_id, args.new_start_at);

    case 'cancel-meeting':
      return calendarService.cancelMeetingForLead(call.organization_id, call.lead_id);

    default:
      throw new AppError(404, `Unknown tool: ${toolName}`);
  }
}
