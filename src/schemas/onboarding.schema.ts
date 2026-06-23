import { z } from 'zod';

export const onboardingPostSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  company: z.string().min(1, 'Company name is required'),
  role: z.string().min(1),
  industry: z.string().min(1),
  productDescription: z.string().min(10, 'Describe your product in at least 10 characters'),
  valueProp: z.string().min(10, 'Describe your value proposition in at least 10 characters'),
  painPoints: z.string().optional().default(''),
  tone: z.string().min(1),
  hookStyle: z.string().optional().default(''),
  followUpCadence: z.string().optional().default(''),
  icpTitles: z.array(z.string()).min(1, 'Select at least one target title'),
  icpCompanySizes: z.array(z.string()).min(1, 'Select at least one company size'),
  icpTargetIndustries: z.array(z.string()).optional().default([]),
  icpGeos: z.array(z.string()).min(1, 'Select at least one geography'),
  meetingTarget: z.number().int().min(1).max(50).optional().default(15),
  dealSize: z.string().optional().default(''),
  salesCycle: z.string().optional().default(''),
  agentName: z.string().min(1).max(40).default('Nexo'),
  bookingLink: z.string().url('Must be a valid URL').optional().or(z.literal('')).optional(),
  tools: z.array(z.string()).optional().default([]),
});

export const onboardingPutSchema = onboardingPostSchema.partial();

export type OnboardingInput = z.infer<typeof onboardingPostSchema>;
