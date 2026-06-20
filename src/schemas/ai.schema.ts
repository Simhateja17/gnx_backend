import { z } from 'zod';

export const generateEmailSchema = z.object({
  campaignId: z.string().uuid(),
  leadId: z.string().uuid(),
  stepNumber: z.number().int().min(1).max(3),
});

export type GenerateEmailInput = z.infer<typeof generateEmailSchema>;

export const generateReplySchema = z.object({
  emailReplyId: z.string().uuid(),
});

export type GenerateReplyInput = z.infer<typeof generateReplySchema>;

export const generateVoicePromptSchema = z.object({
  campaignId: z.string().uuid(),
});

export type GenerateVoicePromptInput = z.infer<typeof generateVoicePromptSchema>;
