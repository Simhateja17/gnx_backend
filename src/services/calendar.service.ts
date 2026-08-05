import { supabase } from '../lib/supabase';
import { AppError } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export type CalendarSettings = {
  timezone: string;
  workingDays: number[];
  dayStartTime: string;
  dayEndTime: string;
  meetingDurationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  bookingWindowDays: number;
};

type CalendarSettingsRow = {
  timezone: string;
  working_days: number[];
  day_start_time: string;
  day_end_time: string;
  meeting_duration_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  booking_window_days: number;
};

function mapSettings(row: CalendarSettingsRow): CalendarSettings {
  return {
    timezone: row.timezone,
    workingDays: row.working_days,
    dayStartTime: row.day_start_time.slice(0, 5),
    dayEndTime: row.day_end_time.slice(0, 5),
    meetingDurationMinutes: row.meeting_duration_minutes,
    bufferMinutes: row.buffer_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    bookingWindowDays: row.booking_window_days,
  };
}

export async function getCalendarSettings(organizationId: string): Promise<CalendarSettings> {
  const { data, error } = await supabase
    .from('calendar_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load calendar settings', error);
  if (data) return mapSettings(data as CalendarSettingsRow);

  const { data: created, error: createError } = await supabase
    .from('calendar_settings')
    .insert({ organization_id: organizationId })
    .select('*')
    .single();
  if (createError || !created) throw new AppError(500, 'Failed to initialize calendar settings', createError);
  return mapSettings(created as CalendarSettingsRow);
}

export async function updateCalendarSettings(
  organizationId: string,
  input: Partial<CalendarSettings>,
): Promise<CalendarSettings> {
  await getCalendarSettings(organizationId); // ensures the row exists before patching

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.workingDays !== undefined) patch.working_days = input.workingDays;
  if (input.dayStartTime !== undefined) patch.day_start_time = input.dayStartTime;
  if (input.dayEndTime !== undefined) patch.day_end_time = input.dayEndTime;
  if (input.meetingDurationMinutes !== undefined) patch.meeting_duration_minutes = input.meetingDurationMinutes;
  if (input.bufferMinutes !== undefined) patch.buffer_minutes = input.bufferMinutes;
  if (input.minNoticeMinutes !== undefined) patch.min_notice_minutes = input.minNoticeMinutes;
  if (input.bookingWindowDays !== undefined) patch.booking_window_days = input.bookingWindowDays;

  const { data, error } = await supabase
    .from('calendar_settings')
    .update(patch)
    .eq('organization_id', organizationId)
    .select('*')
    .single();
  if (error || !data) throw new AppError(500, 'Failed to update calendar settings', error);
  return mapSettings(data as CalendarSettingsRow);
}

// ── Timezone-aware slot math (no date library in this project - see
// email.service.ts's startOfDayUtcForTimezone for the same technique) ──

function timezoneOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);

  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

// Resolves `HH:MM` local time in `timeZone` to a UTC instant, on the local
// calendar day that `reference` falls on.
function localTimeToUtc(timeZone: string, reference: Date, hhmm: string): Date {
  const offsetMinutes = timezoneOffsetMinutes(timeZone, reference);
  const shifted = new Date(reference.getTime() + offsetMinutes * 60_000);
  const [hours, minutes] = hhmm.split(':').map(Number);
  shifted.setUTCHours(hours, minutes, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
}

function localDayOfWeek(timeZone: string, date: Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

function localHour(timeZone: string, date: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}

function formatSlotLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

function parsePreferredDayOfWeek(text?: string): number | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const idx = WEEKDAY_NAMES.findIndex(day => lower.includes(day));
  return idx === -1 ? null : idx;
}

function preferredTimeOfDayRange(period?: string): [number, number] | null {
  switch (period) {
    case 'morning': return [0, 12];
    case 'afternoon': return [12, 17];
    case 'evening': return [17, 24];
    default: return null;
  }
}

function generateCandidateSlots(
  settings: CalendarSettings,
  opts: { minStart: Date; maxDays: number; limit: number },
): Date[] {
  const slots: Date[] = [];
  const stepMinutes = settings.meetingDurationMinutes + settings.bufferMinutes;
  const durationMs = settings.meetingDurationMinutes * 60_000;

  for (let dayOffset = 0; dayOffset <= opts.maxDays && slots.length < opts.limit; dayOffset++) {
    const dayReference = new Date(opts.minStart.getTime() + dayOffset * DAY_MS);
    if (!settings.workingDays.includes(localDayOfWeek(settings.timezone, dayReference))) continue;

    let cursor = localTimeToUtc(settings.timezone, dayReference, settings.dayStartTime);
    const dayEnd = localTimeToUtc(settings.timezone, dayReference, settings.dayEndTime);

    while (cursor.getTime() + durationMs <= dayEnd.getTime() && slots.length < opts.limit) {
      if (cursor.getTime() >= opts.minStart.getTime()) slots.push(new Date(cursor));
      cursor = new Date(cursor.getTime() + stepMinutes * 60_000);
    }
  }
  return slots;
}

export async function checkAvailability(
  organizationId: string,
  opts: { preferredDay?: string; preferredTimeOfDay?: string } = {},
) {
  const settings = await getCalendarSettings(organizationId);
  const minStart = new Date(Date.now() + settings.minNoticeMinutes * 60_000);
  const windowEnd = new Date(minStart.getTime() + settings.bookingWindowDays * DAY_MS);

  const pool = generateCandidateSlots(settings, { minStart, maxDays: settings.bookingWindowDays, limit: 300 });

  const { data: busyRows, error } = await supabase
    .from('meetings')
    .select('scheduled_at, duration_minutes')
    .eq('organization_id', organizationId)
    .eq('status', 'scheduled')
    .gte('scheduled_at', minStart.toISOString())
    .lte('scheduled_at', windowEnd.toISOString());
  if (error) throw new AppError(500, 'Failed to check existing meetings', error);

  const busyRanges = (busyRows ?? []).map(row => {
    const start = new Date(row.scheduled_at).getTime();
    return { start, end: start + row.duration_minutes * 60_000 };
  });

  const durationMs = settings.meetingDurationMinutes * 60_000;
  const isFree = (slot: Date) => {
    const start = slot.getTime();
    const end = start + durationMs;
    return !busyRanges.some(b => start < b.end && end > b.start);
  };

  const preferredDow = parsePreferredDayOfWeek(opts.preferredDay);
  const timeRange = preferredTimeOfDayRange(opts.preferredTimeOfDay);
  const matchesPreference = (slot: Date) => {
    if (preferredDow !== null && localDayOfWeek(settings.timezone, slot) !== preferredDow) return false;
    if (timeRange) {
      const hour = localHour(settings.timezone, slot);
      if (hour < timeRange[0] || hour >= timeRange[1]) return false;
    }
    return true;
  };

  const free = pool.filter(isFree);
  let candidates = free.filter(matchesPreference).slice(0, 3);
  if (candidates.length === 0) candidates = free.slice(0, 3);

  return {
    timezone: settings.timezone,
    meetingDurationMinutes: settings.meetingDurationMinutes,
    slots: candidates.map(slot => ({ startAt: slot.toISOString(), label: formatSlotLabel(slot, settings.timezone) })),
  };
}

async function findActiveMeetingForLead(organizationId: string, leadId: string) {
  const { data, error } = await supabase
    .from('meetings')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to look up existing meeting', error);
  return data;
}

function assertMeetsNotice(settings: CalendarSettings, start: Date) {
  if (Number.isNaN(start.getTime())) throw new AppError(400, 'startAt must be a valid ISO timestamp');
  const minStart = new Date(Date.now() + settings.minNoticeMinutes * 60_000);
  if (start.getTime() < minStart.getTime()) {
    throw new AppError(409, 'That time no longer meets our minimum notice window');
  }
}

export async function bookMeeting(
  organizationId: string,
  input: { leadId: string | null; campaignId: string | null; callId: string | null; startAt: string },
) {
  if (!input.leadId) throw new AppError(400, 'No lead associated with this call');

  const settings = await getCalendarSettings(organizationId);
  const start = new Date(input.startAt);
  assertMeetsNotice(settings, start);

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('id, first_name, last_name, name, company, phone')
    .eq('organization_id', organizationId)
    .eq('id', input.leadId)
    .single();
  if (leadError || !lead) throw new AppError(404, 'Lead not found for booking', leadError);

  const attendeeName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.name || 'Prospect';
  const title = `Sales call with ${attendeeName}${lead.company ? ` (${lead.company})` : ''}`;

  const { data: meeting, error } = await supabase
    .from('meetings')
    .insert({
      organization_id: organizationId,
      campaign_id: input.campaignId,
      lead_id: input.leadId,
      call_id: input.callId,
      title,
      scheduled_at: start.toISOString(),
      duration_minutes: settings.meetingDurationMinutes,
      attendee_phone: lead.phone ?? null,
      timezone: settings.timezone,
      source: 'call',
      status: 'scheduled',
    })
    .select('*')
    .single();

  if (error?.code === '23505') {
    throw new AppError(409, 'That slot was just taken. Please offer the prospect a different time.');
  }
  if (error || !meeting) throw new AppError(500, 'Failed to book meeting', error);

  await supabase.from('leads').update({ status: 'meeting_booked' }).eq('id', input.leadId);

  return { booked: true, scheduledAt: meeting.scheduled_at, label: formatSlotLabel(start, settings.timezone), timezone: settings.timezone };
}

export async function rescheduleMeetingForLead(organizationId: string, leadId: string | null, newStartAt: string) {
  if (!leadId) throw new AppError(400, 'No lead associated with this call');
  const meeting = await findActiveMeetingForLead(organizationId, leadId);
  if (!meeting) throw new AppError(404, 'This prospect has no upcoming meeting to reschedule');

  const settings = await getCalendarSettings(organizationId);
  const start = new Date(newStartAt);
  assertMeetsNotice(settings, start);

  const { data, error } = await supabase
    .from('meetings')
    .update({ scheduled_at: start.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', meeting.id)
    .select('*')
    .single();

  if (error?.code === '23505') throw new AppError(409, 'That slot was just taken. Please offer the prospect a different time.');
  if (error || !data) throw new AppError(500, 'Failed to reschedule meeting', error);

  return { rescheduled: true, scheduledAt: data.scheduled_at, label: formatSlotLabel(start, settings.timezone), timezone: settings.timezone };
}

export async function cancelMeetingForLead(organizationId: string, leadId: string | null) {
  if (!leadId) throw new AppError(400, 'No lead associated with this call');
  const meeting = await findActiveMeetingForLead(organizationId, leadId);
  if (!meeting) throw new AppError(404, 'This prospect has no upcoming meeting to cancel');

  const { error } = await supabase
    .from('meetings')
    .update({ status: 'cancelled', canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', meeting.id);
  if (error) throw new AppError(500, 'Failed to cancel meeting', error);

  await supabase.from('leads').update({ status: 'engaged' }).eq('id', leadId).eq('status', 'meeting_booked');

  return { cancelled: true };
}

export async function cancelMeetingById(organizationId: string, meetingId: string) {
  const { data: meeting, error: fetchError } = await supabase
    .from('meetings')
    .select('id, lead_id, status')
    .eq('organization_id', organizationId)
    .eq('id', meetingId)
    .single();
  if (fetchError || !meeting) throw new AppError(404, 'Meeting not found');
  if (meeting.status === 'cancelled') return { id: meeting.id, status: 'cancelled' };

  const { data, error } = await supabase
    .from('meetings')
    .update({ status: 'cancelled', canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', meetingId)
    .select('id,status')
    .single();
  if (error || !data) throw new AppError(500, 'Failed to cancel meeting', error);

  if (meeting.lead_id) {
    await supabase.from('leads').update({ status: 'engaged' }).eq('id', meeting.lead_id).eq('status', 'meeting_booked');
  }
  return data;
}
