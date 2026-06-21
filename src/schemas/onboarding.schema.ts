import { z } from 'zod';

export const onboardingPostSchema = z.object({
  productDescription: z.string().min(10, 'Describe your product in at least 10 characters'),
  valueProp: z.string().min(10, 'Describe your value proposition in at least 10 characters'),
  objections: z.string().optional().default(''),
  tone: z.string().min(1),
  hookStyle: z.string().optional().default(''),
  icpTitles: z.array(z.string()).min(1, 'Select at least one target title'),
  icpCompanySizes: z.array(z.string()).min(1, 'Select at least one company size'),
  icpGeos: z.array(z.string()).min(1, 'Select at least one geography'),
  agentName: z.string().min(1).max(40).default('Nexo'),
  bookingLink: z.string().url('Must be a valid URL').optional().or(z.literal('')).optional(),
});

export const onboardingPutSchema = onboardingPostSchema.partial();

export type OnboardingInput = z.infer<typeof onboardingPostSchema>;
