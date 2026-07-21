import Razorpay from 'razorpay';
import { validatePaymentVerification } from 'razorpay/dist/utils/razorpay-utils';
import { env } from '../config/env';

// Created lazily, not at module load — mirrors lib/resend.ts's reasoning:
// constructing this eagerly with empty keys would crash every request in
// any environment where Razorpay isn't configured yet.
let razorpayClient: Razorpay | null = null;

export function getRazorpayClient(): Razorpay {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing)');
  }
  if (!razorpayClient) {
    razorpayClient = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  }
  return razorpayClient;
}

export function verifyRazorpayWebhookSignature(rawBody: string, signature: string): boolean {
  return Razorpay.validateWebhookSignature(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET);
}

export function verifyRazorpayCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  return validatePaymentVerification({ order_id: orderId, payment_id: paymentId }, signature, env.RAZORPAY_KEY_SECRET);
}
