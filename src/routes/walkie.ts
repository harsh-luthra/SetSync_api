import { Router } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { COL, createDoc, listAllDocs } from '../services/appwrite.service';
import { findShootDay } from '../services/day.service';
import { notify } from '../services/notification.service';
import type { AttendanceDoc, Role, WalkieEvent, WalkieType } from '../types';
import { DIRECTION_ROLES } from '../types';
import { hitRateLimit } from '../utils/rateLimiter';

const router = Router();
router.use(...authenticate);

const ALL_TYPES: WalkieType[] = [
  'scene_ready',
  'artist_ready',
  'camera_ready',
  'lunch_break',
  'pack_up',
  'custom',
];

/** Sender-role permission matrix (spec §5): actor is forbidden entirely. */
const ROLE_MATRIX: Partial<Record<Role, WalkieType[]>> = {
  director: ALL_TYPES,
  associate_director: ALL_TYPES,
  assistant_director: ALL_TYPES,
  costume: ['scene_ready', 'custom'],
  art: ['custom'],
};

const SOUND_TYPES: WalkieType[] = ['lunch_break', 'pack_up'];

const TITLES: Record<WalkieType, string> = {
  scene_ready: '🎬 Scene ready',
  artist_ready: '🧑‍🎤 Artist ready',
  camera_ready: '🎥 Camera ready',
  lunch_break: '🍽️ Lunch break',
  pack_up: '📦 Pack up',
  custom: '📢 Walkie',
};

/** POST /walkie — rate-limited 1 event / 5s per user (spec §8). */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!;

    const allowed = ROLE_MATRIX[user.role];
    if (!allowed) throw new AppError(403, 'Actors cannot send walkie events');

    const body = z
      .object({
        type: z.enum(ALL_TYPES as [WalkieType, ...WalkieType[]]),
        message: z.string().max(1000).optional(),
      })
      .parse(req.body);

    if (!allowed.includes(body.type)) {
      throw new AppError(403, `Role ${user.role} may only send: ${allowed.join(', ')}`);
    }

    const waitMs = hitRateLimit(`walkie:${user.userId}`, 5000);
    if (waitMs > 0) {
      throw new AppError(429, `Slow down — try again in ${Math.ceil(waitMs / 1000)}s`);
    }

    const day = await findShootDay(user.projectId, 0);
    if (!day || day.status === 'draft') {
      throw new AppError(409, 'No published shoot day today — walkie is offline');
    }

    const event = await createDoc<WalkieEvent>(
      COL.WALKIE_EVENTS,
      {
        projectId: user.projectId,
        shootDayId: day.$id,
        type: body.type,
        message: body.message,
        senderId: user.userId,
        senderRole: user.role,
        senderName: user.name,
      },
      user.projectId,
    );

    // Push to all crew checked in today (silent, except lunch_break & pack_up)
    const attendance = await listAllDocs<AttendanceDoc>(COL.ATTENDANCE, [
      Query.equal('shootDayId', day.$id),
    ]);
    const checkedInUserIds = [...new Set(attendance.map((a) => a.userId))];

    if (checkedInUserIds.length > 0) {
      await notify({
        projectId: user.projectId,
        targetUserIds: checkedInUserIds,
        title: TITLES[body.type],
        body: body.message || `${TITLES[body.type]} — ${user.name}`,
        type: `walkie_${body.type}`,
        deepLink: `setsync://walkie/${event.$id}`,
        sound: SOUND_TYPES.includes(body.type),
      });
    }

    res.status(201).json({ event });
  }),
);

/** GET /walkie/today — today's walkie feed, newest first. */
router.get(
  '/today',
  asyncHandler(async (req, res) => {
    const day = await findShootDay(req.user!.projectId, 0);
    if (!day) {
      res.json({ shootDay: null, events: [] });
      return;
    }
    const events = await listAllDocs<WalkieEvent>(COL.WALKIE_EVENTS, [
      Query.equal('shootDayId', day.$id),
      Query.orderDesc('$createdAt'),
    ]);
    res.json({ shootDay: day, events });
  }),
);

export default router;
