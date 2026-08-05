import { z } from 'zod';
import { SETUP_STEP_IDS } from '../services/setup.service';

export const tourPatchSchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped']).optional(),
  lastStepId: z.string().trim().max(80).nullable().optional(),
  lastStepIndex: z.coerce.number().int().min(0).max(200).optional(),
  seenStepId: z.string().trim().max(80).optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one field is required');

export const setupStepActionSchema = z.object({
  stepId: z.enum(SETUP_STEP_IDS),
  action: z.enum(['complete', 'skip', 'reset']),
});

export const copilotDraftSchema = z.object({
  draft: z.record(z.unknown()),
});

export const copilotPreviewSchema = z.object({
  channel: z.enum(['email', 'voice', 'both']),
  campaignName: z.string().trim().min(1).max(120),
  audience: z.string().trim().max(600).optional().default(''),
  offer: z.string().trim().max(1200).optional().default(''),
  tone: z.enum(['consultative', 'direct', 'friendly', 'formal', 'challenger']).optional(),
});

const followUpSchema = z.object({
  delayDays: z.coerce.number().int().min(0).max(90),
  subjectTemplate: z.string().trim().max(500).optional().default(''),
  bodyPromptContext: z.string().trim().max(4000).optional().default(''),
});

export const copilotCampaignSchema = z.object({
  // Explicit, unambiguous confirmation. The route refuses to create anything
  // without it, so a mis-click in the wizard can never start outreach.
  confirm: z.literal(true),
  launch: z.boolean().optional().default(false),

  name: z.string().trim().min(3).max(120),
  channel: z.enum(['email', 'voice', 'both']),
  audience: z.string().trim().max(600).optional().default(''),
  offer: z.string().trim().max(1200).optional().default(''),

  maxLeads: z.coerce.number().int().min(1).max(10000).optional().default(100),
  dailySendCap: z.coerce.number().int().min(1).max(500).optional().default(75),
  callCadencePerHour: z.coerce.number().int().min(1).max(60).optional().default(5),
  voiceMode: z.enum(['ai', 'manual']).optional().default('ai'),
  businessHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().default('09:00'),
  businessHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().default('17:00'),
  timezone: z.string().trim().min(2).max(80).optional().default('America/New_York'),

  steps: z.array(followUpSchema).max(10).optional().default([]),
  leadIds: z.array(z.string().uuid()).max(500).optional().default([]),
});

export type TourPatchInput = z.infer<typeof tourPatchSchema>;
export type SetupStepActionInput = z.infer<typeof setupStepActionSchema>;
export type CopilotPreviewInput = z.infer<typeof copilotPreviewSchema>;
export type CopilotCampaignInput = z.infer<typeof copilotCampaignSchema>;
