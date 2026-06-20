import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { apolloSearchSchema, csvUploadSchema, leadCreateSchema } from '../schemas/leads.schema';
import { createLead, deleteLead, listLeads, searchApollo, uploadCsvLeads } from '../services/leads.service';
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
    res.json(await listLeads(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(leadCreateSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await createLead(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/apollo-search', validate(apolloSearchSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await searchApollo(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/csv-upload', validate(csvUploadSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await uploadCsvLeads(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteLead(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
