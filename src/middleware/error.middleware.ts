import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { AppError } from '../types';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  Sentry.captureException(err);

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
    });
  }

  console.error(err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
}
