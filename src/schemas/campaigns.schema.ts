import { z } from 'zod';

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm format');

export const campaignChannelSchema = z.enum(['email', 'voice']);

export const campaignCreateSchema = z.object({
  name: z.string().trim().min(3).max(120),
  channel: campaignChannelSchema,
  icpSource: z.string().trim().min(2).max(240),
  promptNotes: z.string().trim().max(2000).optional().default(''),
  maxLeads: z.coerce.number().int().min(1).max(10000).default(100),
  dailySendCap: z.coerce.number().int().min(1).max(500).default(75),
  callCadencePerHour: z.coerce.number().int().min(1).max(60).default(5),
  voiceMode: z.enum(['ai', 'manual']).default('ai'),
  businessHoursStart: timeSchema.default('09:00'),
  businessHoursEnd: timeSchema.default('17:00'),
  timezone: z.string().trim().min(2).max(80).default('America/New_York'),
});

export const campaignUpdateSchema = campaignCreateSchema.partial().refine(
  value => Object.keys(value).length > 0,
  'At least one field is required'
);

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;
