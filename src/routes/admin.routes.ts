import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest, requireAdmin } from '../middleware/auth.middleware';
import * as adminService from '../services/admin.service';
import { setImpersonationCookie } from '../lib/cookies';

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/overview', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.getAdminOverview());
  } catch (err) {
    next(err);
  }
});

router.get('/organizations', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listOrganizations());
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listUsers());
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listCampaigns());
  } catch (err) {
    next(err);
  }
});

router.get('/metrics', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.getMetrics());
  } catch (err) {
    next(err);
  }
});

router.post('/organizations/:id/suspend', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.suspendOrganization(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/organizations/:id/impersonate', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = await adminService.createImpersonationToken(req.params.id, req.user.id);
    setImpersonationCookie(res, token);
    res.json(token);
  } catch (err) {
    next(err);
  }
});

export default router;
