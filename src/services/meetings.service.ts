import { supabase } from '../lib/supabase';
import { AppError } from '../types';

function fullName(lead: any) {
  return [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.name || 'Guest';
}

function mapMeeting(row: any) {
  const lead = row.leads as any;
  const campaign = row.campaigns as any;

  return {
    id: row.id,
    title: row.title,
    scheduledAt: row.scheduled_at,
    durationMinutes: row.duration_minutes,
    joinUrl: row.join_url,
    conferenceUrl: row.conference_url ?? null,
    status: row.status,
    source: row.source,
    provider: row.provider ?? null,
    providerCalendarId: row.provider_calendar_id ?? null,
    attendeeEmail: row.attendee_email ?? null,
    timezone: row.timezone ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lead: lead ? {
      id: lead.id,
      name: fullName(lead),
      firstName: lead.first_name ?? '',
      lastName: lead.last_name ?? '',
      title: lead.title ?? '',
      company: lead.company ?? '',
      email: lead.email ?? '',
    } : null,
    campaign: campaign ? {
      id: campaign.id,
      name: campaign.name,
    } : null,
  };
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfTomorrow() {
  const date = startOfToday();
  date.setDate(date.getDate() + 1);
  return date;
}

export async function listMeetings(orgId: string) {
  const now = new Date();
  const todayStart = startOfToday();
  const tomorrowStart = startOfTomorrow();

  const [meetingsResult, calendarResult] = await Promise.all([
    supabase
      .from('meetings')
      .select('id,title,scheduled_at,duration_minutes,join_url,conference_url,status,source,provider,provider_calendar_id,attendee_email,timezone,created_at,updated_at,leads(id,first_name,last_name,name,title,company,email),campaigns(id,name)')
      .eq('organization_id', orgId)
      .order('scheduled_at', { ascending: true }),
    supabase
      .from('calendar_connections')
      .select('provider,connected_email,selected_calendar_id,selected_calendar_name,timezone,status,last_error')
      .eq('organization_id', orgId)
      .eq('provider', 'google')
      .maybeSingle(),
  ]);

  if (meetingsResult.error) {
    throw new AppError(500, 'Failed to fetch meetings', meetingsResult.error);
  }
  if (calendarResult.error) {
    throw new AppError(500, 'Failed to fetch Google Calendar status', calendarResult.error);
  }

  const meetings = (meetingsResult.data ?? []).map(mapMeeting);
  const today = meetings.filter(meeting => {
    const scheduled = new Date(meeting.scheduledAt);
    return meeting.status === 'scheduled' && scheduled >= todayStart && scheduled < tomorrowStart;
  });
  const upcoming = meetings.filter(meeting => {
    const scheduled = new Date(meeting.scheduledAt);
    return meeting.status === 'scheduled' && scheduled >= tomorrowStart;
  });
  const past = meetings.filter(meeting => {
    const scheduled = new Date(meeting.scheduledAt);
    return meeting.status !== 'scheduled' || scheduled < now;
  }).sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());

  return {
    // Kept as an empty compatibility field while the frontend migrates from
    // booking-link CTAs to the Calendar connection controls.
    bookingLink: '',
    calendar: {
      connected: calendarResult.data?.status === 'connected',
      provider: calendarResult.data?.provider ?? 'google',
      email: calendarResult.data?.connected_email ?? null,
      selectedCalendarId: calendarResult.data?.selected_calendar_id ?? null,
      selectedCalendarName: calendarResult.data?.selected_calendar_name ?? null,
      timezone: calendarResult.data?.timezone ?? 'UTC',
      status: calendarResult.data?.status ?? 'disconnected',
      lastError: calendarResult.data?.last_error ?? null,
    },
    summary: {
      total: meetings.length,
      today: today.length,
      upcoming: upcoming.length,
      past: past.length,
    },
    meetings,
    today,
    upcoming,
    past,
  };
}
