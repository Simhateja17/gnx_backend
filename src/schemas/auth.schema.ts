import { z } from 'zod';

const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const signupStartSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Invalid email address'),
  company: z.string().min(1, 'Company name is required'),
});

export const signupVerifySchema = z.object({
  email: z.string().email('Invalid email address'),
  otp: otpSchema,
});

export const loginStartSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const loginVerifySchema = z.object({
  email: z.string().email('Invalid email address'),
  otp: otpSchema,
});
