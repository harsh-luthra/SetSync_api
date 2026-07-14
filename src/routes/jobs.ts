import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { env } from '../config/env';
import { runMidnightWrap } from '../jobs/midnightWrap';
import { runTomorrowReminder } from '../jobs/tomorrowReminder';
import { verifyJwt } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireMaster } from '../middleware/requireMaster';

/**
 * Manual trigger for scheduled jobs. Two auth paths:
 *  - X-Cron-Secret header matching CRON_TRIGGER_SECRET — for external cron
 *    services (cron-job.org): the ping wakes a sleeping free-tier host AND
 *    runs the job, so schedules hold even when in-process cron can't fire.
 *  - Master admin JWT — for manual testing.
 */
const router = Router();

function cronAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = req.header('x-cron-secret');
  if (env.CRON_TRIGGER_SECRET && secret === env.CRON_TRIGGER_SECRET) {
    next();
    return;
  }
  // Fall back to master JWT
  (verifyJwt as (req: Request, res: Response, next: NextFunction) => void)(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    requireMaster(req, res, next);
  });
}

router.post(
  '/run/:job',
  cronAuth,
  asyncHandler(async (req, res) => {
    switch (req.params.job) {
      case 'tomorrowReminder': {
        const result = await runTomorrowReminder();
        res.json({ job: 'tomorrowReminder', ...result });
        return;
      }
      case 'midnightWrap': {
        const result = await runMidnightWrap();
        res.json({ job: 'midnightWrap', ...result });
        return;
      }
      default:
        throw new AppError(404, 'Unknown job. Available: tomorrowReminder, midnightWrap');
    }
  }),
);

export default router;
