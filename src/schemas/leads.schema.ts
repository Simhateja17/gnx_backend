import { z } from 'zod';

const optionalText = z.string().trim().max(240).optional().or(z.literal(''));

export const leadCreateSchema = z.object({
  campaignId: z.string().uuid().optional(),
  firstName: optionalText,
  lastName: optionalText,
  name: z.string().trim().min(1).max(240).optional(),
  title: optionalText,
  company: optionalText,
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: optionalText,
  location: optionalText,
  linkedinUrl: z.string().trim().url().optional().or(z.literal('')),
  source: z.enum(['apollo', 'csv', 'manual']).default('manual'),
});

export const apolloSearchSchema = z.object({
  titles: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  locations: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  companySizes: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  keywords: z.string().trim().max(240).optional().default(''),
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

export const csvUploadSchema = z.object({
  campaignId: z.string().uuid().optional(),
  rows: z.array(leadCreateSchema.omit({ source: true }).extend({
    rawData: z.record(z.unknown()).optional(),
  })).min(1).max(1000),
});

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type ApolloSearchInput = z.infer<typeof apolloSearchSchema>;
export type CsvUploadInput = z.infer<typeof csvUploadSchema>;
