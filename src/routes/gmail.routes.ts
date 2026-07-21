import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { supabase } from '../lib/supabase';
import { enqueueRecurringPollInbox, removeRecurringPollInbox } from '../jobs/poll-inbox.job';
import { getAuthUrl, exchangeCode, createOAuth2Client } from '../lib/gmail';
import { google } from 'googleapis';
import { AppError } from '../types';

const router = Router();
router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/auth-url', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { returnTo, sendLeadId } = req.query as Record<string, string | undefined>;
    const state = returnTo || sendLeadId
      ? Buffer.from(JSON.stringify({ returnTo, sendLeadId })).toString('base64url')
      : undefined;
    const url = getAuthUrl(state);
    res.json({ url, orgId });
  } catch (err) {
    next(err);
  }
});

router.post('/callback', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { code } = req.body;
    if (!code) throw new AppError(400, 'Authorization code is required');

    const tokens = await exchangeCode(code);
    if (!tokens.access_token) throw new AppError(502, 'Failed to obtain access token from Google');

    const client = createOAuth2Client();
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = userInfo.email ?? '';

    const record = {
      organization_id: orgId,
      provider: 'gmail',
      provider_account_id: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? '',
      expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      metadata: { scope: tokens.scope },
    };

    const { data: existing } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('organization_id', orgId)
      .eq('provider', 'gmail')
      .maybeSingle();

    let connectedAccountId: string | null = null;
    if (existing) {
      await supabase
        .from('connected_accounts')
        .update(record)
        .eq('id', existing.id);
      connectedAccountId = existing.id;
    } else {
      const { data: created } = await supabase
        .from('connected_accounts')
        .insert(record)
        .select('id')
        .single();
      connectedAccountId = created?.id ?? null;
    }

    if (connectedAccountId) {
      await enqueueRecurringPollInbox({ organizationId: orgId, connectedAccountId });
    }

    res.json({ success: true, email });
  } catch (err) {
    next(err);
  }
});

router.get('/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);

    const { data, error } = await supabase
      .from('connected_accounts')
      .select('id,provider_account_id,expires_at')
      .eq('organization_id', orgId)
      .eq('provider', 'gmail')
      .maybeSingle();

    if (error) throw new AppError(500, 'Failed to check Gmail status', error);

    res.json({
      connected: !!data,
      email: data?.provider_account_id ?? null,
      expiresAt: data?.expires_at ?? null,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/disconnect', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);

    const { data, error } = await supabase
      .from('connected_accounts')
      .delete()
      .eq('organization_id', orgId)
      .eq('provider', 'gmail')
      .select('id')
      .maybeSingle();

    if (error) throw new AppError(500, 'Failed to disconnect Gmail', error);
    if (!data) throw new AppError(404, 'No Gmail connection found');

    // The account is already disconnected at this point (the DB row above
    // is gone). Removing the recurring poll job is best-effort cleanup — a
    // Redis hiccup here shouldn't make the whole request look like it failed.
    try {
      await removeRecurringPollInbox(data.id);
    } catch (cleanupErr) {
      console.warn('[Gmail] failed to remove recurring poll-inbox job on disconnect:', (cleanupErr as Error).message);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
