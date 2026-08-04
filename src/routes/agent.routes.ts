import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { agentChatSchema } from '../schemas/agent.schema';
import { handleAgentMessage, listAgentMessages } from '../services/agent-chat.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/messages', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await listAgentMessages(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

// requireActiveSubscription because agent tool calls can trigger real, billed
// Apollo searches - same guard already applied to /leads/apollo-search.
router.post('/chat', requireActiveSubscription, validate(agentChatSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await handleAgentMessage(getOrgId(req), req.body.message));
  } catch (err) {
    next(err);
  }
});

export default router;
