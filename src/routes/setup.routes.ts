import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  copilotCampaignSchema,
  copilotDraftSchema,
  copilotPreviewSchema,
  setupStepActionSchema,
  tourPatchSchema,
} from '../schemas/setup.schema';
import {
  getCopilotDraft,
  getIntegrationStates,
  getSetupState,
  saveCopilotDraft,
  setStepAcknowledgement,
  updateTourState,
} from '../services/setup.service';
import {
  checkCampaignReadiness,
  createCampaignFromCopilot,
  generateCopilotPreview,
} from '../services/setup-copilot.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

/**
 * Setup state is readable without an active subscription so the checklist and
 * tour still work for an account sitting on the billing screen — billing is
 * itself one of the things the checklist explains.
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const [state, draft] = await Promise.all([getSetupState(orgId), getCopilotDraft(orgId)]);
    res.json({ ...state, copilotDraft: draft });
  } catch (err) {
    next(err);
  }
});

router.get('/integrations', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getIntegrationStates(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.patch('/tour', validate(tourPatchSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await updateTourState(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/steps', validate(setupStepActionSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await setStepAcknowledgement(getOrgId(req), req.body.stepId, req.body.action));
  } catch (err) {
    next(err);
  }
});

// ── Setup Copilot ─────────────────────────────────────────────────

router.put('/copilot/draft', validate(copilotDraftSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await saveCopilotDraft(getOrgId(req), req.body.draft));
  } catch (err) {
    next(err);
  }
});

router.post('/copilot/readiness', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const channel = req.body?.channel;
    if (channel !== 'email' && channel !== 'voice' && channel !== 'both') {
      throw new AppError(400, 'A channel of email, voice, or both is required');
    }
    const leadIds = Array.isArray(req.body?.leadIds)
      ? req.body.leadIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 500)
      : [];
    res.json(await checkCampaignReadiness(getOrgId(req), channel, leadIds));
  } catch (err) {
    next(err);
  }
});

// Generation costs AI budget, so it sits behind the same subscription guard as
// the other generation endpoints. It never sends or dials anything.
router.post(
  '/copilot/preview',
  requireActiveSubscription,
  validate(copilotPreviewSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await generateCopilotPreview(getOrgId(req), req.body));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/copilot/campaign',
  requireActiveSubscription,
  validate(copilotCampaignSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.status(201).json(await createCampaignFromCopilot(getOrgId(req), req.body));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
