import { z } from 'zod';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM (24h)');

export const updateCalendarSettingsSchema = z.object({
  timezone: z.string().min(1).optional(),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  dayStartTime: timeOfDay.optional(),
  dayEndTime: timeOfDay.optional(),
  meetingDurationMinutes: z.number().int().min(5).max(240).optional(),
  bufferMinutes: z.number().int().min(0).max(120).optional(),
  minNoticeMinutes: z.number().int().min(0).max(10080).optional(),
  bookingWindowDays: z.number().int().min(1).max(90).optional(),
}).refine(
  data => !data.dayStartTime || !data.dayEndTime || data.dayStartTime < data.dayEndTime,
  { message: 'dayEndTime must be after dayStartTime', path: ['dayEndTime'] },
);

export type UpdateCalendarSettingsInput = z.infer<typeof updateCalendarSettingsSchema>;
