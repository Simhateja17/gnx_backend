import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/billing.middleware';
import { AppError } from '../types';
import {
  cancelGoogleCalendarMeeting,
  connectGoogleCalendar,
  createGoogleCalendarMeeting,
  getGoogleCalendarAuthUrl,
  getGoogleCalendarFreeBusy,
  getGoogleCalendarStatus,
  listGoogleCalendars,
  selectGoogleCalendar,
} from '../services/calendar.service';

const router = Router();
router.use(authenticate);
router.use(requireActiveSubscription);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/auth-url', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ url: getGoogleCalendarAuthUrl(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined) });
  } catch (err) {
    next(err);
  }
});

router.post('/callback', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await connectGoogleCalendar(getOrgId(req), String(req.body?.code ?? '')));
  } catch (err) {
    next(err);
  }
});

router.get('/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getGoogleCalendarStatus(getOrgId(req)));
  } catch (err) {
    next(err);
  }
});

router.get('/calendars', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ calendars: await listGoogleCalendars(getOrgId(req)) });
  } catch (err) {
    next(err);
  }
});

router.patch('/selection', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await selectGoogleCalendar(getOrgId(req), String(req.body?.calendarId ?? '')));
  } catch (err) {
    next(err);
  }
});

router.post('/freebusy', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getGoogleCalendarFreeBusy(getOrgId(req), {
      timeMin: String(req.body?.timeMin ?? ''),
      timeMax: String(req.body?.timeMax ?? ''),
      calendarId: typeof req.body?.calendarId === 'string' ? req.body.calendarId : undefined,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/events', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await createGoogleCalendarMeeting({
      organizationId: getOrgId(req),
      leadId: typeof req.body?.leadId === 'string' ? req.body.leadId : null,
      campaignId: typeof req.body?.campaignId === 'string' ? req.body.campaignId : null,
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description : null,
      startAt: String(req.body?.startAt ?? ''),
      durationMinutes: req.body?.durationMinutes,
      timezone: typeof req.body?.timezone === 'string' ? req.body.timezone : undefined,
      calendarId: typeof req.body?.calendarId === 'string' ? req.body.calendarId : undefined,
      createConference: req.body?.createConference,
      idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
    }));
  } catch (err) {
    next(err);
  }
});

router.delete('/events/:meetingId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await cancelGoogleCalendarMeeting(getOrgId(req), req.params.meetingId));
  } catch (err) {
    next(err);
  }
});

export default router;
