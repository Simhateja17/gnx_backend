import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest, requireAdmin } from '../middleware/auth.middleware';
import * as supportService from '../services/support.service';
import { AppError } from '../types';

const router = Router();

router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/tickets', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await supportService.listTickets(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/tickets', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await supportService.createTicket(getOrgId(req), req.user.id, {
      subject: String(req.body?.subject ?? ''),
      body: String(req.body?.body ?? ''),
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/tickets/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await supportService.getTicket(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

router.get('/tickets/:id/messages', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const ticket = await supportService.getTicket(getOrgId(req), req.params.id);
    res.json({ items: ticket.messages });
  } catch (err) {
    next(err);
  }
});

router.post('/tickets/:id/messages', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await supportService.addUserMessage(getOrgId(req), req.user.id, req.params.id, String(req.body?.body ?? '')));
  } catch (err) {
    next(err);
  }
});

router.patch('/tickets/:id/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const status = String(req.body?.status ?? '');
    if (!['open', 'resolved', 'closed'].includes(status)) throw new AppError(400, 'Invalid ticket status');
    res.json(await supportService.updateTicketStatus(getOrgId(req), req.params.id, status as 'open' | 'resolved' | 'closed'));
  } catch (err) {
    next(err);
  }
});

router.get('/admin/tickets', requireAdmin, async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await supportService.listAdminTickets());
  } catch (err) {
    next(err);
  }
});

router.get('/admin/tickets/:id', requireAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await supportService.getAdminTicket(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/admin/tickets/:id/messages', requireAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await supportService.addAdminMessage(req.user.id, req.params.id, String(req.body?.body ?? '')));
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/tickets/:id/status', requireAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const status = String(req.body?.status ?? '');
    if (!['open', 'resolved', 'closed'].includes(status)) throw new AppError(400, 'Invalid ticket status');
    res.json(await supportService.updateTicketStatus(undefined, req.params.id, status as 'open' | 'resolved' | 'closed'));
  } catch (err) {
    next(err);
  }
});

export default router;
