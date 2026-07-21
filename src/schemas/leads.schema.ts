import { z } from 'zod';

const optionalText = z.string().trim().max(240).optional().or(z.literal(''));

export const leadCreateSchema = z.object({
  campaignId: z.string().uuid().optional(),
  apolloId: optionalText,
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
  campaignId: z.string().uuid().optional(),
  titles: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  locations: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  companySizes: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  keywords: z.string().trim().max(240).optional().default(''),
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

// Deliberately permissive: a single malformed row (e.g. a bad email) must not
// reject the whole batch. Per-row correctness (email format, etc.) is checked
// row-by-row in uploadCsvLeads, which skips bad rows instead of failing everything.
const csvRowSchema = z.object({
  campaignId: z.string().uuid().optional(),
  apolloId: z.string().trim().max(240).optional().or(z.literal('')),
  firstName: z.string().trim().max(240).optional().or(z.literal('')),
  lastName: z.string().trim().max(240).optional().or(z.literal('')),
  name: z.string().trim().max(240).optional().or(z.literal('')),
  title: z.string().trim().max(240).optional().or(z.literal('')),
  company: z.string().trim().max(240).optional().or(z.literal('')),
  email: z.string().trim().max(240).optional().or(z.literal('')),
  phone: z.string().trim().max(240).optional().or(z.literal('')),
  location: z.string().trim().max(240).optional().or(z.literal('')),
  linkedinUrl: z.string().trim().max(500).optional().or(z.literal('')),
  rawData: z.record(z.unknown()).optional(),
});

export const csvUploadSchema = z.object({
  campaignId: z.string().uuid().optional(),
  rows: z.array(csvRowSchema).min(1).max(1000),
});

export const apolloEnrichSchema = z.object({
  leadId: z.string().uuid(),
});

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type ApolloSearchInput = z.infer<typeof apolloSearchSchema>;
export type CsvUploadInput = z.infer<typeof csvUploadSchema>;
export type ApolloEnrichInput = z.infer<typeof apolloEnrichSchema>;
