import { z } from 'zod';

export const checkoutSchema = z.object({
  planId: z.enum(['starter', 'growth', 'scale']),
  billingPeriod: z.enum(['monthly', 'annual']),
});

export const checkoutVerifySchema = z.object({
  razorpay_order_id: z.string().trim().min(1),
  razorpay_payment_id: z.string().trim().min(1),
  razorpay_signature: z.string().trim().min(1),
});
