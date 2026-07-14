import cron from 'node-cron';
import { Query } from 'node-appwrite';
import { APP_TIMEZONE } from '../config/env';
import { logger } from '../config/logger';
import { COL, createDoc, listAllDocs, updateDoc } from '../services/appwrite.service';
import type { Scene, ShootDay } from '../types';
import { dayWindowUtc } from '../utils/time';

/**
 * Midnight (IST): mark yesterday's published shoot days `completed` and
 * snapshot simple DPR data (scenes completed vs planned) into the `dpr`
 * collection (spec §7 — structure only; full DPR UI is Phase 2).
 */
export async function runMidnightWrap(): Promise<{ daysCompleted: number }> {
  const { startIso, endIso } = dayWindowUtc(-1);
  const days = await listAllDocs<ShootDay>(COL.SHOOT_DAYS, [
    Query.equal('status', 'published'),
    Query.greaterThanEqual('date', startIso),
    Query.lessThan('date', endIso),
  ]);

  let daysCompleted = 0;
  for (const day of days) {
    try {
      await updateDoc<ShootDay>(COL.SHOOT_DAYS, day.$id, { status: 'completed' });

      const scenes = await listAllDocs<Scene>(COL.SCENES, [Query.equal('shootDayId', day.$id)]);
      await createDoc(
        COL.DPR,
        {
          projectId: day.projectId,
          shootDayId: day.$id,
          date: day.date,
          scenesPlanned: scenes.length,
          scenesCompleted: scenes.filter((s) => s.status === 'completed').length,
        },
        day.projectId,
      );
      daysCompleted++;
      logger.info({ shootDayId: day.$id }, 'Day completed + DPR snapshot written');
    } catch (err) {
      logger.error({ err, shootDayId: day.$id }, 'midnightWrap failed for day');
    }
  }
  return { daysCompleted };
}

export function scheduleMidnightWrap(): void {
  cron.schedule('0 0 * * *', () => void runMidnightWrap(), { timezone: APP_TIMEZONE });
  logger.info('Scheduled: midnightWrap (00:00 IST daily)');
}
