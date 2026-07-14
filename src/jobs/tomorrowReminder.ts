import cron from 'node-cron';
import { Query } from 'node-appwrite';
import { APP_TIMEZONE } from '../config/env';
import { logger } from '../config/logger';
import { COL, listAllDocs } from '../services/appwrite.service';
import { findShootDay } from '../services/day.service';
import { notify } from '../services/notification.service';
import type { Project } from '../types';
import { DIRECTION_ROLES } from '../types';

/**
 * 8:00 PM daily (IST): if tomorrow's shoot_day exists and is still draft,
 * remind the admin roles to publish (spec §7).
 */
async function run(): Promise<void> {
  const projects = await listAllDocs<Project>(COL.PROJECTS, [
    Query.notEqual('status', 'wrapped'),
  ]);
  for (const project of projects) {
    try {
      const tomorrow = await findShootDay(project.$id, 1);
      if (tomorrow && tomorrow.status === 'draft') {
        await notify({
          projectId: project.$id,
          targetRoles: DIRECTION_ROLES,
          title: '⏰ Call sheet reminder',
          body: "Tomorrow's call sheet is not published yet",
          type: 'publish_reminder',
          deepLink: `setsync://shootday/${tomorrow.$id}`,
          sound: true,
        });
        logger.info({ projectId: project.$id, shootDayId: tomorrow.$id }, 'Publish reminder sent');
      }
    } catch (err) {
      logger.error({ err, projectId: project.$id }, 'tomorrowReminder failed for project');
    }
  }
}

export function scheduleTomorrowReminder(): void {
  cron.schedule('0 20 * * *', () => void run(), { timezone: APP_TIMEZONE });
  logger.info('Scheduled: tomorrowReminder (20:00 IST daily)');
}
