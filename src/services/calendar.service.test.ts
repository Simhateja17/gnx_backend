import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/google-calendar', () => ({
  createCalendarOAuth2Client: vi.fn(),
  exchangeCalendarCode: vi.fn(),
  getCalendarApi: vi.fn(),
  getCalendarAuthUrl: vi.fn(),
}));

import { buildGoogleCalendarEvent } from './calendar.service';

describe('Google Calendar event contract', () => {
  it('creates a timezone-aware event with an attendee and optional Meet request', () => {
    const event = buildGoogleCalendarEvent({
      title: 'Discovery call',
      description: 'Discuss outbound workflow.',
      startAt: '2026-08-05T10:00:00.000Z',
      endAt: '2026-08-05T10:30:00.000Z',
      timezone: 'America/Los_Angeles',
      attendeeEmail: 'prospect@example.com',
      attendeeName: 'Prospect Person',
      createConference: true,
      requestId: 'globonexo-test-request',
    });

    expect(event).toMatchObject({
      summary: 'Discovery call',
      description: 'Discuss outbound workflow.',
      start: { dateTime: '2026-08-05T10:00:00.000Z', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-08-05T10:30:00.000Z', timeZone: 'America/Los_Angeles' },
      attendees: [{ email: 'prospect@example.com', displayName: 'Prospect Person' }],
      conferenceData: {
        createRequest: {
          requestId: 'globonexo-test-request',
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    });
  });

  it('does not request a conference when the flow only needs an event', () => {
    const event = buildGoogleCalendarEvent({
      title: 'Follow-up',
      startAt: '2026-08-05T10:00:00.000Z',
      endAt: '2026-08-05T10:30:00.000Z',
      timezone: 'UTC',
      attendeeEmail: 'prospect@example.com',
      createConference: false,
    });

    expect(event).not.toHaveProperty('conferenceData');
  });
});
