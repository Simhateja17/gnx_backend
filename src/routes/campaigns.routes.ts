import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { campaignCreateSchema, campaignUpdateSchema } from '../schemas/campaigns.schema';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  setCampaignStatus,
  updateCampaign,
} from '../services/campaigns.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);

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

router.post('/', validate(campaignCreateSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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

router.post('/:id/launch', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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

router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteCampaign(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
