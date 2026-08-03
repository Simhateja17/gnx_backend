import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { setAuthCookies } from '../lib/cookies';
import * as authService from '../services/auth.service';
import { verifyImpersonationToken } from '../services/admin.service';
import { AppError } from '../types';

export interface AuthenticatedRequest extends Request {
  user?: any;
  organization?: any;
  accessToken?: string;
}

async function loadOrgUser(supabaseUid: string) {
  const { data: orgUser } = await supabase
    .from('users')
    .select('*, organizations(*)')
    .eq('supabase_uid', supabaseUid)
    .single();

  if (!orgUser) {
    throw new AppError(401, 'User not found');
  }

  return orgUser;
}

async function loadOrgUserById(userId: string, organizationId: string) {
  const { data: orgUser } = await supabase
    .from('users')
    .select('*, organizations(*)')
    .eq('id', userId)
    .eq('organization_id', organizationId)
    .single();

  if (!orgUser) {
    throw new AppError(401, 'Impersonated user not found');
  }

  return orgUser;
}

function readImpersonationToken(token?: string) {
  if (!token) return null;
  try {
    const payload = verifyImpersonationToken(token);
    if (!payload?.userId || !payload?.organizationId) return null;
    return payload as { userId: string; organizationId: string; adminUserId?: string; expiresAt: string };
  } catch {
    return null;
  }
}

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const impersonation = readImpersonationToken(req.signedCookies?.impersonation_token);
    if (impersonation) {
      const orgUser = await loadOrgUserById(impersonation.userId, impersonation.organizationId);
      req.user = { ...orgUser, impersonatedBy: impersonation.adminUserId ?? null };
      req.organization = orgUser.organizations;
      return next();
    }

    const accessToken = req.signedCookies?.access_token;

    if (accessToken) {
      const { data: { user }, error } = await supabase.auth.getUser(accessToken);
      if (!error && user) {
        const orgUser = await loadOrgUser(user.id);
        req.user = orgUser;
        req.organization = orgUser.organizations;
        req.accessToken = accessToken;
        return next();
      }
    }

    const refreshToken = req.signedCookies?.refresh_token;
    if (!refreshToken) {
      throw new AppError(401, 'Unauthorized');
    }

    const session = await authService.refreshSession(refreshToken);
    setAuthCookies(res, session);

    const { data: { user }, error } = await supabase.auth.getUser(session.access_token);
    if (error || !user) {
      throw new AppError(401, 'Invalid or expired session');
    }

    const orgUser = await loadOrgUser(user.id);
    req.user = orgUser;
    req.organization = orgUser.organizations;
    req.accessToken = session.access_token;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return next(new AppError(403, 'Admin access required'));
  }
  next();
}
