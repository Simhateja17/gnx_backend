import { z } from 'zod';

export const updateSettingsSchema = z.object({
  firstName:          z.string().min(1, 'First name cannot be empty').optional(),
  lastName:           z.string().min(1, 'Last name cannot be empty').optional(),
  orgName:            z.string().min(1, 'Organisation name cannot be empty').optional(),
  orgWebsite:         z.string().url('Must be a valid URL').optional().or(z.literal('')),
  tone:               z.enum(['consultative', 'direct', 'friendly', 'formal', 'challenger'], {
                        errorMap: () => ({ message: 'Tone must be one of: consultative, direct, friendly, formal, challenger' }),
                      }).optional(),
  autoApproveReplies: z.boolean().optional(),
  dailyEmailSendCap:  z.number().int('Send cap must be a whole number').min(1, 'Minimum is 1').max(500, 'Maximum is 500').optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
