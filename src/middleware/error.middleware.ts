import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { AppError } from '../types';

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  Sentry.captureException(err);

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
}
