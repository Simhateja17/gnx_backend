import { Router, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import {
  approveMessagesSchema,
  assignLeadsSchema,
  autopilotSchema,
  campaignCreateSchema,
  campaignUpdateSchema,
  messageEditSchema,
  sequenceStepsUpsertSchema,
} from '../schemas/campaigns.schema';
import {
  assignLeadsToCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  getSequenceSteps,
  listCampaigns,
  setCampaignStatus,
  updateCampaign,
  upsertSequenceSteps,
} from '../services/campaigns.service';
import {
  approveMessages,
  getCampaignApprovalState,
  listCampaignMessages,
  markMessageEdited,
  setCampaignAutopilot,
} from '../services/campaign-approval.service';
import { getGenerationProgress } from '../services/campaign-generation.service';
import { enqueueCampaignGeneration } from '../jobs/campaign-generation.job';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await listCampaigns(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireActiveSubscription, validate(campaignCreateSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await createCampaign(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getCampaign(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(campaignUpdateSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await updateCampaign(getOrgId(req), req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/launch', requireActiveSubscription, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await setCampaignStatus(getOrgId(req), req.params.id, 'active'));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pause', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await setCampaignStatus(getOrgId(req), req.params.id, 'paused'));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/steps', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getSequenceSteps(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

router.put('/:id/steps', validate(sequenceStepsUpsertSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await upsertSequenceSteps(getOrgId(req), req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/assign-leads', requireActiveSubscription, validate(assignLeadsSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await assignLeadsToCampaign(getOrgId(req), req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteCampaign(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

// ── Generation, review, and approval ─────────────────────────────

/**
 * Generation progress. Drafts are written automatically once leads finish
 * enriching, so nobody pressed a button to start this - which makes it the
 * only place a customer can see whether it is still working or what failed.
 */
router.get('/:id/generation', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const progress = await getGenerationProgress(getOrgId(req), req.params.id);
    res.json(progress ?? { status: 'not_started', totalLeads: 0, generatedMessages: 0, failedLeads: 0 });
  } catch (error) { next(error); }
});

/** Retries only the leads that failed. Existing drafts are left untouched. */
router.post('/:id/generation/retry', requireActiveSubscription, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const campaignId = req.params.id;
    const progress = await getGenerationProgress(orgId, campaignId);

    const failedLeadIds = [...new Set(
      ((progress?.failures ?? []) as Array<{ leadId?: string }>)
        .map(failure => failure.leadId)
        .filter(Boolean),
    )] as string[];

    const job = await enqueueCampaignGeneration({
      organizationId: orgId,
      campaignId,
      trigger: 'manual_retry',
      leadIds: failedLeadIds.length > 0 ? failedLeadIds : undefined,
    }, 0);

    res.status(202).json({ jobId: job.id, retryingLeads: failedLeadIds.length });
  } catch (error) { next(error); }
});

router.get('/:id/messages', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as 'draft' | 'approved' | 'sent' | undefined;
    const stepNumber = req.query.step ? Number(req.query.step) : undefined;
    const [items, state] = await Promise.all([
      listCampaignMessages({ organizationId: getOrgId(req), campaignId: req.params.id, status, stepNumber }),
      getCampaignApprovalState(getOrgId(req), req.params.id),
    ]);
    res.json({ items, ...state });
  } catch (error) { next(error); }
});

/** Editing withdraws approval, unless autopilot is on for this campaign. */
router.patch('/:id/messages/:messageId', validate(messageEditSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const updated = await markMessageEdited({
      organizationId: getOrgId(req),
      campaignId: req.params.id,
      messageId: req.params.messageId,
      subject: req.body.subject,
      body: req.body.body,
    });
    res.json(updated);
  } catch (error) { next(error); }
});

router.post('/:id/messages/:messageId/regenerate', requireActiveSubscription, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { data: message, error } = await supabase
      .from('email_messages')
      .select('id,lead_id,status')
      .eq('organization_id', orgId)
      .eq('campaign_id', req.params.id)
      .eq('id', req.params.messageId)
      .maybeSingle();

    if (error) throw new AppError(500, 'Failed to load message', error);
    if (!message) throw new AppError(404, 'Message not found');
    // Regenerating a sent email would rewrite history against something the
    // prospect has already read.
    if (message.status === 'sent') throw new AppError(400, 'This email has already been sent and cannot be regenerated');

    // Cleared so the generator treats this step as missing; sent and approved
    // steps for other leads are untouched.
    await supabase
      .from('email_messages')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', req.params.messageId);

    const job = await enqueueCampaignGeneration({
      organizationId: orgId,
      campaignId: req.params.id,
      trigger: 'regenerate',
      leadIds: [message.lead_id],
    }, 0);

    res.status(202).json({ jobId: job.id });
  } catch (error) { next(error); }
});

/** With no ids, approves every draft in the campaign. */
router.post('/:id/messages/approve-batch', validate(approveMessagesSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await approveMessages({
      organizationId: getOrgId(req),
      campaignId: req.params.id,
      messageIds: req.body.messageIds,
      approvedBy: 'user',
    });
    res.json(result);
  } catch (error) { next(error); }
});

/** Turning autopilot on also approves the drafts already waiting. */
router.post('/:id/autopilot', validate(autopilotSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await setCampaignAutopilot({
      organizationId: getOrgId(req),
      campaignId: req.params.id,
      enabled: req.body.enabled === true,
    });
    res.json(result);
  } catch (error) { next(error); }
});

export default router;
