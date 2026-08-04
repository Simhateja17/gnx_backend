import { createHash, randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import {
  createCalendarOAuth2Client,
  exchangeCalendarCode,
  getCalendarApi,
  getCalendarAuthUrl,
} from '../lib/google-calendar';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

type CalendarConnection = {
  id: string;
  organization_id: string;
  provider: 'google';
  provider_account_id: string | null;
  connected_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scopes: string[];
  selected_calendar_id: string | null;
  selected_calendar_name: string | null;
  timezone: string;
  status: 'pending' | 'connected' | 'error' | 'revoked' | 'disconnected';
  last_error: string | null;
};

function connectionStatus(connection: CalendarConnection | null) {
  return {
    connected: connection?.status === 'connected' && Boolean(connection.access_token && connection.refresh_token),
    provider: connection?.provider ?? 'google',
    email: connection?.connected_email ?? null,
    selectedCalendarId: connection?.selected_calendar_id ?? null,
    selectedCalendarName: connection?.selected_calendar_name ?? null,
    timezone: connection?.timezone ?? 'UTC',
    status: connection?.status ?? 'disconnected',
    lastError: connection?.last_error ?? null,
  };
}

async function loadConnection(organizationId: string): Promise<CalendarConnection | null> {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider', 'google')
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to load Google Calendar connection', error);
  return data as CalendarConnection | null;
}

function assertConfigured() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new AppError(503, 'Google Calendar OAuth is not configured');
  }
}

function toState(returnTo?: string) {
  return returnTo
    ? Buffer.from(JSON.stringify({ returnTo })).toString('base64url')
    : undefined;
}

export function getGoogleCalendarAuthUrl(returnTo?: string) {
  assertConfigured();
  return getCalendarAuthUrl(toState(returnTo));
}

async function updateAccessToken(connectionId: string, accessToken: string, expiryDate: number | null) {
  const { error } = await supabase
    .from('calendar_connections')
    .update({
      access_token: accessToken,
      expires_at: expiryDate ? new Date(expiryDate).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectionId);
  if (error) console.warn('[calendar] failed to persist refreshed Google token:', error.message);
}

async function loadCalendarClient(organizationId: string) {
  const connection = await loadConnection(organizationId);
  if (!connection || connection.status !== 'connected' || !connection.access_token || !connection.refresh_token) {
    throw new AppError(409, 'Connect Google Calendar before using calendar features');
  }

  const calendar = getCalendarApi(
    connection.access_token,
    connection.refresh_token,
    (tokens) => { void updateAccessToken(connection.id, tokens.access_token, tokens.expiry_date); },
  );
  return { connection, calendar };
}

export async function connectGoogleCalendar(organizationId: string, code: string) {
  assertConfigured();
  if (!code?.trim()) throw new AppError(400, 'Google Calendar authorization code is required');

  let tokens: Awaited<ReturnType<typeof exchangeCalendarCode>>;
  try {
    tokens = await exchangeCalendarCode(code);
  } catch (error: any) {
    throw new AppError(502, `Google Calendar authorization failed: ${error?.message ?? 'unknown error'}`, error);
  }
  if (!tokens.access_token) throw new AppError(502, 'Google did not return a Calendar access token');

  const client = createCalendarOAuth2Client();
  client.setCredentials(tokens);
  let email = '';
  try {
    const userInfo = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = userInfo.data.email ?? '';
  } catch (error: any) {
    throw new AppError(502, `Failed to read Google account identity: ${error?.message ?? 'unknown error'}`, error);
  }

  const existing = await loadConnection(organizationId);
  const selectedCalendarId = existing?.selected_calendar_id ?? 'primary';
  const scopes = typeof tokens.scope === 'string'
    ? tokens.scope.split(' ').filter(Boolean)
    : existing?.scopes ?? [];
  const { data, error } = await supabase
    .from('calendar_connections')
    .upsert({
      organization_id: organizationId,
      provider: 'google',
      provider_account_id: (email || existing?.provider_account_id) ?? null,
      connected_email: (email || existing?.connected_email) ?? null,
      access_token: tokens.access_token,
      // Google may omit refresh_token when the user has already granted the
      // scopes. Preserve the existing refresh token in that case.
      refresh_token: tokens.refresh_token ?? existing?.refresh_token ?? null,
      expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scopes,
      selected_calendar_id: selectedCalendarId,
      selected_calendar_name: existing?.selected_calendar_name ?? null,
      timezone: existing?.timezone ?? 'UTC',
      status: 'connected',
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,provider' })
    .select('*')
    .single();
  if (error || !data) throw new AppError(500, 'Failed to save Google Calendar connection', error);

  return connectionStatus(data as CalendarConnection);
}

export async function getGoogleCalendarStatus(organizationId: string) {
  return connectionStatus(await loadConnection(organizationId));
}

export async function listGoogleCalendars(organizationId: string) {
  const { connection, calendar } = await loadCalendarClient(organizationId);
  try {
    const result = await calendar.calendarList.list({ maxResults: 250, showDeleted: false });
    return (result.data.items ?? []).map(item => ({
      id: item.id ?? '',
      name: item.summaryOverride ?? item.summary ?? item.id ?? 'Calendar',
      description: item.description ?? null,
      primary: item.primary === true,
      selected: item.id === (connection.selected_calendar_id ?? 'primary'),
      timezone: item.timeZone ?? connection.timezone ?? 'UTC',
      accessRole: item.accessRole ?? null,
    })).filter(item => item.id);
  } catch (error: any) {
    throw new AppError(502, `Failed to list Google Calendars: ${error?.message ?? 'unknown error'}`, error);
  }
}

export async function selectGoogleCalendar(organizationId: string, calendarId: string) {
  if (!calendarId?.trim()) throw new AppError(400, 'Calendar ID is required');
  const { calendar } = await loadCalendarClient(organizationId);
  let selected;
  try {
    selected = await calendar.calendars.get({ calendarId });
  } catch (error: any) {
    throw new AppError(502, `Failed to load selected Google Calendar: ${error?.message ?? 'unknown error'}`, error);
  }

  const { data, error } = await supabase
    .from('calendar_connections')
    .update({
      selected_calendar_id: calendarId,
      selected_calendar_name: selected.data.summary ?? calendarId,
      timezone: selected.data.timeZone ?? 'UTC',
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', organizationId)
    .eq('provider', 'google')
    .select('*')
    .single();
  if (error || !data) throw new AppError(500, 'Failed to save selected Google Calendar', error);
  return connectionStatus(data as CalendarConnection);
}

function parseDate(value: string, field: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new AppError(400, `${field} must be a valid ISO date`);
  return date;
}

export async function getGoogleCalendarFreeBusy(
  organizationId: string,
  input: { timeMin: string; timeMax: string; calendarId?: string },
) {
  const start = parseDate(input.timeMin, 'timeMin');
  const end = parseDate(input.timeMax, 'timeMax');
  if (end <= start) throw new AppError(400, 'timeMax must be after timeMin');
  if (end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1000) {
    throw new AppError(400, 'Free/busy range cannot exceed 31 days');
  }

  const { connection, calendar } = await loadCalendarClient(organizationId);
  const calendarId = input.calendarId?.trim() || connection.selected_calendar_id || 'primary';
  try {
    const result = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: connection.timezone || 'UTC',
        items: [{ id: calendarId }],
      },
    });
    return {
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      busy: result.data.calendars?.[calendarId]?.busy ?? [],
    };
  } catch (error: any) {
    throw new AppError(502, `Failed to read Google Calendar availability: ${error?.message ?? 'unknown error'}`, error);
  }
}

export function buildGoogleCalendarEvent(input: {
  title: string;
  description?: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  attendeeEmail: string;
  attendeeName?: string | null;
  createConference?: boolean;
  requestId?: string;
}) {
  const event: Record<string, unknown> = {
    summary: input.title,
    description: input.description ?? undefined,
    start: { dateTime: input.startAt, timeZone: input.timezone },
    end: { dateTime: input.endAt, timeZone: input.timezone },
    attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName ?? undefined }],
  };
  if (input.createConference) {
    event.conferenceData = {
      createRequest: {
        requestId: input.requestId ?? randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }
  return event;
}

function meetingJoinUrl(event: any): string | null {
  return event.hangoutLink
    ?? event.conferenceData?.entryPoints?.find((entry: any) => entry.entryPointType === 'video')?.uri
    ?? event.htmlLink
    ?? null;
}

export async function createGoogleCalendarMeeting(input: {
  organizationId: string;
  leadId?: string | null;
  campaignId?: string | null;
  title?: string;
  description?: string | null;
  startAt: string;
  durationMinutes?: number;
  timezone?: string;
  calendarId?: string;
  createConference?: boolean;
  idempotencyKey?: string;
}) {
  const start = parseDate(input.startAt, 'startAt');
  const durationMinutes = input.durationMinutes ?? 30;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    throw new AppError(400, 'durationMinutes must be an integer between 5 and 480');
  }
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const idempotencyKey = input.idempotencyKey?.trim()
    || createHash('sha256').update(JSON.stringify({
      leadId: input.leadId ?? null,
      campaignId: input.campaignId ?? null,
      startAt: start.toISOString(),
      durationMinutes,
      calendarId: input.calendarId ?? null,
    })).digest('hex');

  const { data: existingMeeting, error: existingError } = await supabase
    .from('meetings')
    .select('*')
    .eq('organization_id', input.organizationId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingError) throw new AppError(500, 'Failed to check existing calendar meeting', existingError);
  if (existingMeeting) return existingMeeting;

  let lead: any = null;
  if (input.leadId) {
    const leadResult = await supabase
      .from('leads')
      .select('id,account_id,first_name,last_name,name,email,company')
      .eq('organization_id', input.organizationId)
      .eq('id', input.leadId)
      .single();
    if (leadResult.error || !leadResult.data) throw new AppError(404, 'Lead not found for calendar meeting', leadResult.error);
    lead = leadResult.data;
  }
  const attendeeEmail = lead?.email;
  if (!attendeeEmail || !/^\S+@\S+\.\S+$/.test(attendeeEmail)) {
    throw new AppError(400, 'A valid lead email is required to create a calendar meeting');
  }

  const { connection, calendar } = await loadCalendarClient(input.organizationId);
  const calendarId = input.calendarId?.trim() || connection.selected_calendar_id || 'primary';
  const timezone = input.timezone?.trim() || connection.timezone || 'UTC';
  const attendeeName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.name;
  const title = input.title?.trim() || `Sales meeting with ${attendeeName || lead.company || 'prospect'}`;
  const eventBody = buildGoogleCalendarEvent({
    title,
    description: input.description,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    timezone,
    attendeeEmail,
    attendeeName,
    createConference: input.createConference !== false,
    requestId: `globonexo-${randomUUID()}`,
  });

  let event;
  try {
    const result = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody: eventBody as any,
    });
    event = result.data;
  } catch (error: any) {
    throw new AppError(502, `Failed to create Google Calendar event: ${error?.message ?? 'unknown error'}`, error);
  }
  if (!event.id) throw new AppError(502, 'Google Calendar returned an event without an ID');

  const joinUrl = meetingJoinUrl(event);
  const { data: meeting, error: meetingError } = await supabase
    .from('meetings')
    .insert({
      organization_id: input.organizationId,
      campaign_id: input.campaignId ?? null,
      lead_id: input.leadId ?? null,
      account_id: lead?.account_id ?? null,
      title,
      scheduled_at: start.toISOString(),
      duration_minutes: durationMinutes,
      join_url: joinUrl,
      conference_url: joinUrl,
      attendee_email: attendeeEmail,
      timezone,
      provider: 'google_calendar',
      provider_calendar_id: calendarId,
      provider_event_id: event.id,
      external_etag: event.etag ?? null,
      idempotency_key: idempotencyKey,
      source: 'calendar',
      status: 'scheduled',
      last_synced_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (meetingError?.code === '23505') {
    const { data: concurrent } = await supabase
      .from('meetings')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (concurrent) return concurrent;
  }
  if (meetingError || !meeting) throw new AppError(500, 'Google event was created but meeting could not be saved', meetingError);
  return meeting;
}

export async function cancelGoogleCalendarMeeting(organizationId: string, meetingId: string) {
  const { data: meeting, error: meetingError } = await supabase
    .from('meetings')
    .select('id,provider,provider_calendar_id,provider_event_id,status')
    .eq('organization_id', organizationId)
    .eq('id', meetingId)
    .single();
  if (meetingError || !meeting) throw new AppError(404, 'Meeting not found', meetingError);
  if (meeting.status === 'cancelled') return { id: meeting.id, status: 'cancelled' };

  if (meeting.provider === 'google_calendar' && meeting.provider_calendar_id && meeting.provider_event_id) {
    const { calendar } = await loadCalendarClient(organizationId);
    try {
      await calendar.events.delete({
        calendarId: meeting.provider_calendar_id,
        eventId: meeting.provider_event_id,
        sendUpdates: 'all',
      });
    } catch (error: any) {
      if (error?.code !== 404) throw new AppError(502, `Failed to cancel Google Calendar event: ${error?.message ?? 'unknown error'}`, error);
    }
  }

  const { data, error } = await supabase
    .from('meetings')
    .update({ status: 'cancelled', canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', meetingId)
    .select('id,status')
    .single();
  if (error || !data) throw new AppError(500, 'Failed to mark meeting cancelled', error);
  return data;
}
