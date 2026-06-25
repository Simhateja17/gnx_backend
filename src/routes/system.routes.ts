import net from 'net';
import { Router, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

function checkTcpConnection(url: string, timeoutMs = 700) {
  return new Promise<boolean>((resolve) => {
    const parsed = new URL(url);
    const socket = net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
    });

    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

router.get('/status', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const redisUrl = new URL(env.REDIS_URL);
    const redisConnected = await checkTcpConnection(env.REDIS_URL);

    res.json({
      backend: {
        running: true,
        port: env.PORT,
      },
      redis: {
        connected: redisConnected,
        host: redisUrl.hostname,
        port: Number(redisUrl.port) || 6379,
      },
      workers: {
        required: true,
        queues: ['send-email', 'poll-inbox'],
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
