import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

export interface AuthenticatedRequest extends Request {
  user?: any;
  organization?: any;
}

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.access_token;
    if (!token) {
      throw new AppError(401, 'Unauthorized');
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      throw new AppError(401, 'Invalid or expired session');
    }

    const { data: orgUser } = await supabase
      .from('users')
      .select('*, organizations(*)')
      .eq('supabase_uid', user.id)
      .single();

    if (!orgUser) {
      throw new AppError(401, 'User not found');
    }

    req.user = orgUser;
    req.organization = orgUser.organizations;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return next(new AppError(403, 'Admin access required'));
  }
  next();
}
