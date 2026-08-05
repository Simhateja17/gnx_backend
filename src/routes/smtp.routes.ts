import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { validate } from '../middleware/validate.middleware';
import { smtpConnectionSchema, SmtpConnectionInput } from '../schemas/smtp.schema';
import { verifyImap, verifySmtp } from '../lib/smtp';
import { enqueueRecurringPollInbox, removeRecurringPollInbox } from '../jobs/poll-inbox.job';
import * as emailConnectionService from '../services/email-connection.service';
import { AppError } from '../types';

const router = Router();
router.use(authenticate);
router.use(requireActiveSubscription);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

async function verifyConnection(input: SmtpConnectionInput) {
  await verifySmtp({
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUsername: input.smtpUsername,
    smtpPassword: input.smtpPassword,
  });
  await verifyImap({
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    imapUsername: input.imapUsername,
    imapPassword: input.imapPassword,
  });
}

router.get('/status', async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json({ connections: await emailConnectionService.getEmailConnectionStatuses(getOrgId(req)) });
  } catch (err) {
    next(err);
  }
});

router.post('/test', validate(smtpConnectionSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await verifyConnection(req.body);
    res.json({ success: true, smtp: true, imap: true });
  } catch (err: any) {
    next(new AppError(502, `Custom email connection test failed: ${err?.message ?? 'provider rejected the connection'}`, err));
  }
});

router.post('/connect', validate(smtpConnectionSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = req.body as SmtpConnectionInput;
    await verifyConnection(input);
    const saved = await emailConnectionService.saveSmtpConnection({
      organizationId: getOrgId(req),
      ...input,
      lastTestedAt: new Date().toISOString(),
    });
    try {
      await enqueueRecurringPollInbox({ organizationId: getOrgId(req), connectedAccountId: saved.id });
    } catch (queueError) {
      console.warn('[SMTP] failed to schedule recurring inbox polling after connect:', (queueError as Error).message);
    }
    res.json(saved);
  } catch (err: any) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    next(new AppError(502, `Could not save custom email connection: ${err?.message ?? 'provider rejected the connection'}`, err));
  }
});

router.post('/activate', async (req: AuthenticatedRequest, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const result = await emailConnectionService.activateEmailProvider(organizationId, 'smtp');
    const connections = await emailConnectionService.getEmailConnectionStatuses(organizationId);
    const account = connections.find((connection) => connection.provider === 'smtp');
    if (account?.id) {
      try {
        await enqueueRecurringPollInbox({ organizationId, connectedAccountId: account.id });
      } catch (queueError) {
        console.warn('[SMTP] failed to schedule recurring inbox polling after activation:', (queueError as Error).message);
      }
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/disconnect', async (req: AuthenticatedRequest, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { data, error } = await emailConnectionService.removeEmailConnection(orgId, 'smtp');
    if (error) throw new AppError(500, 'Failed to disconnect custom email', error);
    if (!data) throw new AppError(404, 'No custom email connection found');
    try {
      await removeRecurringPollInbox(data.id);
    } catch (cleanupErr) {
      console.warn('[SMTP] failed to remove recurring poll-inbox job on disconnect:', (cleanupErr as Error).message);
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
