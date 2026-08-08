import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { apolloImportSchema } from '../schemas/leads.schema';
import { enqueueApolloImport } from '../jobs/apollo-import.job';
import { getImportRun, toImportProgress } from '../services/lead-import-run.service';
import { ensureAgentConfig } from '../services/agent-config.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.user?.organizationId;
  if (!orgId) throw new AppError(401, 'Organization not found on session');
  return orgId;
}

/**
 * Starts an asynchronous Apollo import and returns a run id immediately.
 *
 * Search plus batched enrichment for ten leads is minutes of work. Holding the
 * HTTP request open for it is what forced the onboarding call to carry a two
 * minute client timeout, and it gives the browser nothing to show meanwhile.
 */
router.post(
  '/import',
  requireActiveSubscription,
  validate(apolloImportSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = getOrgId(req);
      const input = req.body as import('../schemas/leads.schema').ApolloImportInput;

      // Blank targeting fields inherit the workspace ICP rather than being
      // hard-coded, so each business searches its own market.
      const agentConfig = await ensureAgentConfig(orgId);
      const titles = input.titles?.length ? input.titles : (agentConfig.icp_titles ?? []);
      const locations = input.locations?.length ? input.locations : (agentConfig.icp_geos ?? []);
      const companySizes = input.companySizes?.length
        ? input.companySizes
        : (agentConfig.icp_company_sizes ?? []);
      const industries = input.industries?.length
        ? input.industries
        : (agentConfig.icp_target_industries ?? []);

      if (titles.length === 0 && locations.length === 0 && companySizes.length === 0 && industries.length === 0) {
        throw new AppError(
          400,
          'No targeting criteria available. Set your ideal customer profile in Settings, or supply titles, locations, company sizes, or industries with this request.',
        );
      }

      const job = await enqueueApolloImport({
        organizationId: orgId,
        campaignId: input.campaignId ?? null,
        titles,
        locations,
        companySizes,
        industries,
        keywords: input.keywords ?? '',
        limit: input.limit,
        candidateCap: input.candidateCap,
      });

      res.status(202).json({ jobId: job.id, status: 'queued' });
    } catch (error) {
      next(error);
    }
  },
);

/** Import progress. Always resolves to a terminal state - never polls forever. */
router.get('/import/:runId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const run = await getImportRun(orgId, req.params.runId);
    if (!run) throw new AppError(404, 'Import run not found');
    res.json(toImportProgress(run));
  } catch (error) {
    next(error);
  }
});

export default router;
