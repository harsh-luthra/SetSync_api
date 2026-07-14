import { Router } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { teams } from '../config/appwrite';
import { logger } from '../config/logger';
import { authenticate, verifyJwt } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import {
  COL,
  createDoc,
  listAllDocs,
  listDocs,
  teamIdFor,
  updateDoc,
} from '../services/appwrite.service';
import { findShootDay } from '../services/day.service';
import type { AttendanceDoc, UserProfile } from '../types';
import { ALL_ROLES, DIRECTION_ROLES } from '../types';

const router = Router();

const normalizePhone = (phone: string): string => phone.replace(/[^\d+]/g, '');

/** Best-effort: join the auth user to the project team so team-read perms apply. */
async function joinProjectTeam(projectId: string, authUserId: string, role: string, name: string) {
  try {
    await teams.createMembership(
      teamIdFor(projectId),
      [role],
      undefined, // email
      authUserId,
      undefined, // phone
      undefined, // url (not needed for server-side confirmed membership)
      name,
    );
  } catch (err) {
    // 409 = already a member; anything else is logged but non-fatal
    logger.warn({ err, projectId, authUserId }, 'Team membership create skipped/failed');
  }
}

/**
 * POST /auth/bootstrap — after first login.
 * Links the Appwrite auth account to a pre-registered crew invite (matched
 * by phone) or returns the existing profile. Role assignment only happens
 * via /crew/invite (admin), never here.
 */
router.post(
  '/auth/bootstrap',
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;

    // Existing profile?
    const existing = await listDocs<UserProfile>(COL.USERS, [
      Query.equal('authUserId', authUser.$id),
      Query.limit(1),
    ]);
    if (existing.documents[0]) {
      res.json({ profile: existing.documents[0], created: false });
      return;
    }

    // Pre-registered invite matched by phone
    if (!authUser.phone) {
      throw new AppError(403, 'Your account has no phone number and no invite could be matched');
    }
    const invites = await listDocs<UserProfile>(COL.USERS, [
      Query.equal('phone', normalizePhone(authUser.phone)),
      Query.isNull('authUserId'),
      Query.limit(1),
    ]);
    const invite = invites.documents[0];
    if (!invite) {
      throw new AppError(403, 'You are not invited to any project. Ask your AD to invite you.');
    }

    const profile = await updateDoc<UserProfile>(COL.USERS, invite.$id, {
      authUserId: authUser.$id,
      name: invite.name || authUser.name || 'Crew member',
    });
    await joinProjectTeam(profile.projectId, authUser.$id, profile.role, profile.name);

    res.status(201).json({ profile, created: true });
  }),
);

/** POST /users/fcm-token — save the caller's FCM device token. */
router.post(
  '/users/fcm-token',
  ...authenticate,
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(10).max(2048) }).parse(req.body);
    const profile = await updateDoc<UserProfile>(COL.USERS, req.user!.userId, {
      fcmToken: body.token,
    });
    res.json({ ok: true, userId: profile.$id });
  }),
);

/**
 * POST /crew/invite — admin only. Pre-registers {phone, name, role} so the
 * person's first login auto-links via /auth/bootstrap.
 */
router.post(
  '/crew/invite',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        phone: z.string().min(8).max(20),
        name: z.string().min(1).max(128),
        role: z.enum(ALL_ROLES as [string, ...string[]]),
      })
      .parse(req.body);

    const phone = normalizePhone(body.phone);
    const projectId = req.user!.projectId;

    const dup = await listDocs<UserProfile>(COL.USERS, [
      Query.equal('projectId', projectId),
      Query.equal('phone', phone),
      Query.limit(1),
    ]);
    if (dup.documents[0]) {
      throw new AppError(409, `${phone} is already invited to this project`);
    }

    const profile = await createDoc<UserProfile>(
      COL.USERS,
      { phone, name: body.name, role: body.role, projectId, active: true },
      projectId,
    );
    res.status(201).json({ profile });
  }),
);

/** GET /crew — admin: crew list with roles + today's attendance flag. */
router.get(
  '/crew',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const projectId = req.user!.projectId;
    const crew = await listAllDocs<UserProfile>(COL.USERS, [Query.equal('projectId', projectId)]);

    const checkedIn = new Set<string>();
    const today = await findShootDay(projectId, 0);
    if (today) {
      const attendance = await listAllDocs<AttendanceDoc>(COL.ATTENDANCE, [
        Query.equal('shootDayId', today.$id),
      ]);
      for (const a of attendance) checkedIn.add(a.userId);
    }

    res.json({
      crew: crew.map((u) => ({
        id: u.$id,
        name: u.name,
        phone: u.phone,
        role: u.role,
        active: u.active,
        linked: !!u.authUserId,
        avatarFileId: u.avatarFileId ?? null,
        checkedInToday: checkedIn.has(u.$id),
      })),
      shootDayId: today?.$id ?? null,
    });
  }),
);

export default router;
