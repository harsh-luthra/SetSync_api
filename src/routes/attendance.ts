import { Router } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import { COL, createDoc, getDoc, listAllDocs, listDocs } from '../services/appwrite.service';
import { crewOfProject, findShootDay } from '../services/day.service';
import { notify } from '../services/notification.service';
import { issueToken, verifyToken } from '../services/qr.service';
import type { AttendanceDoc, UserProfile } from '../types';
import { DIRECTION_ROLES } from '../types';

const router = Router();
router.use(...authenticate);

/**
 * GET /attendance/qr-token — admin. Returns the rotating (60s) HMAC-signed
 * token for today's shoot day; render it as a QR on the AD's device.
 */
router.get(
  '/qr-token',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const day = await findShootDay(req.user!.projectId, 0);
    if (!day) throw new AppError(404, 'No shoot day today');
    res.json(issueToken(req.user!.projectId, day.$id));
  }),
);

async function recordCheckin(
  user: { userId: string; projectId: string; name: string },
  shootDayId: string,
  subjectUserId: string,
  method: 'qr' | 'manual',
): Promise<{ attendance: AttendanceDoc; created: boolean }> {
  const existing = await listDocs<AttendanceDoc>(COL.ATTENDANCE, [
    Query.equal('shootDayId', shootDayId),
    Query.equal('userId', subjectUserId),
    Query.limit(1),
  ]);
  if (existing.documents[0]) {
    return { attendance: existing.documents[0], created: false };
  }

  try {
    const attendance = await createDoc<AttendanceDoc>(
      COL.ATTENDANCE,
      {
        projectId: user.projectId,
        shootDayId,
        userId: subjectUserId,
        checkInTime: new Date().toISOString(),
        method,
      },
      user.projectId,
    );
    return { attendance, created: true };
  } catch (err) {
    // unique index (shootDayId, userId) race — return the winner
    const retry = await listDocs<AttendanceDoc>(COL.ATTENDANCE, [
      Query.equal('shootDayId', shootDayId),
      Query.equal('userId', subjectUserId),
      Query.limit(1),
    ]);
    if (retry.documents[0]) return { attendance: retry.documents[0], created: false };
    throw err;
  }
}

/** POST /attendance/checkin — body {token}; verifies HMAC + ±90s window. */
router.post(
  '/checkin',
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(10) }).parse(req.body);
    const user = req.user!;

    const verified = verifyToken(body.token);
    if (verified.projectId !== user.projectId) {
      throw new AppError(403, 'This QR belongs to a different project');
    }
    const day = await getDoc<{ $id: string; projectId: string }>(
      COL.SHOOT_DAYS,
      verified.shootDayId,
    );
    if (day.projectId !== user.projectId) throw new AppError(403, 'Invalid shoot day');

    const { attendance, created } = await recordCheckin(user, day.$id, user.userId, 'qr');

    if (created) {
      await notify({
        projectId: user.projectId,
        targetRoles: DIRECTION_ROLES,
        title: '✅ Arrival',
        body: `${user.name} arrived`,
        type: 'attendance_checkin',
        deepLink: `setsync://attendance/${day.$id}`,
        sound: false,
      });
    }

    res.status(created ? 201 : 200).json({ attendance, alreadyCheckedIn: !created });
  }),
);

/** POST /attendance/checkin/manual — admin fallback (method=manual). */
router.post(
  '/checkin/manual',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = z.object({ userId: z.string().min(1) }).parse(req.body);
    const admin = req.user!;

    const day = await findShootDay(admin.projectId, 0);
    if (!day) throw new AppError(404, 'No shoot day today');

    const subject = await getDoc<UserProfile>(COL.USERS, body.userId);
    if (subject.projectId !== admin.projectId) throw new AppError(404, 'Crew member not found');

    const { attendance, created } = await recordCheckin(admin, day.$id, subject.$id, 'manual');
    res.status(created ? 201 : 200).json({ attendance, alreadyCheckedIn: !created });
  }),
);

/** GET /attendance/today — admin summary. */
router.get(
  '/today',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const projectId = req.user!.projectId;
    const day = await findShootDay(projectId, 0);
    if (!day) throw new AppError(404, 'No shoot day today');

    const [attendance, crew] = await Promise.all([
      listAllDocs<AttendanceDoc>(COL.ATTENDANCE, [Query.equal('shootDayId', day.$id)]),
      crewOfProject(projectId),
    ]);
    const byUser = new Map(attendance.map((a) => [a.userId, a]));

    res.json({
      shootDay: day,
      checkedInCount: byUser.size,
      totalCrew: crew.filter((c) => c.active).length,
      crew: crew.map((u) => ({
        id: u.$id,
        name: u.name,
        role: u.role,
        checkedIn: byUser.has(u.$id),
        checkInTime: byUser.get(u.$id)?.checkInTime ?? null,
        method: byUser.get(u.$id)?.method ?? null,
      })),
    });
  }),
);

export default router;
