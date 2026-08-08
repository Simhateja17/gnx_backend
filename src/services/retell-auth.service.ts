import crypto from 'crypto';
import Retell from 'retell-sdk';
import { env } from '../config/env';
import { AppError } from '../types';

export function verifyRetellRequest(rawBody: Buffer, signature: string) {
  if (!env.RETELL_API_KEY) {
    throw new AppError(500, 'RETELL_API_KEY is not configured - refusing an unverified Retell request');
  }
  if (!signature || !Retell.verify(rawBody.toString('utf8'), env.RETELL_API_KEY, signature)) {
    throw new AppError(401, 'Invalid Retell signature');
  }
}

export function verifyRetellToolSecret(value: string) {
  const expected = env.RETELL_TOOL_SECRET;
  if (!expected || !value) throw new AppError(401, 'Invalid tool secret');
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new AppError(401, 'Invalid tool secret');
  }
}
