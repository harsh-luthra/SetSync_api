import { Router } from 'express';
import multer from 'multer';
import { ID, Permission, Query, Role as AwRole } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { z } from 'zod';
import { awUsers, BUCKETS, storage, teams } from '../config/appwrite';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { authenticate, verifyJwt } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { isMasterEmail } from '../middleware/requireMaster';
import { requireRole } from '../middleware/requireRole';
import {
  COL,
  createDoc,
  getDoc,
  listAllDocs,
  listDocs,
  teamIdFor,
  updateDoc,
} from '../services/appwrite.service';
import { findShootDay } from '../services/day.service';
import type { AttendanceDoc, Project, UserProfile } from '../types';
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
 * POST /auth/bootstrap — after every login. Resolves the caller's state:
 *  - existing profile → returns it
 *  - phone matches a crew invite → links it (role comes from the invite)
 *  - otherwise → 200 with needsSetup:true (a master-registered director
 *    who must create their project via POST /projects)
 * `isMaster` tells the app to show the master dashboard.
 */
router.post(
  '/auth/bootstrap',
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const isMaster = isMasterEmail(authUser.email);

    // Existing profile?
    const existing = await listDocs<UserProfile>(COL.USERS, [
      Query.equal('authUserId', authUser.$id),
      Query.limit(1),
    ]);
    if (existing.documents[0]) {
      res.json({ profile: existing.documents[0], created: false, needsSetup: false, isMaster });
      return;
    }

    // Pre-registered invite matched by phone
    if (authUser.phone) {
      const invites = await listDocs<UserProfile>(COL.USERS, [
        Query.equal('phone', normalizePhone(authUser.phone)),
        Query.isNull('authUserId'),
        Query.limit(1),
      ]);
      const invite = invites.documents[0];
      if (invite) {
        const profile = await updateDoc<UserProfile>(COL.USERS, invite.$id, {
          authUserId: authUser.$id,
          name: invite.name || authUser.name || 'Crew member',
        });
        await joinProjectTeam(profile.projectId, authUser.$id, profile.role, profile.name);
        res.status(201).json({ profile, created: true, needsSetup: false, isMaster });
        return;
      }
    }

    // No profile, no invite: signed in but projectless → app shows the
    // "create your project" form (or master dashboard for masters).
    res.json({ profile: null, created: false, needsSetup: true, isMaster });
  }),
);

/**
 * GET /users/me — "who am I": full profile + project summary + avatar URL.
 * Backs the account/profile screen and the app header identity chip.
 */
router.get(
  '/users/me',
  ...authenticate,
  asyncHandler(async (req, res) => {
    const profile = await getDoc<UserProfile>(COL.USERS, req.user!.userId);
    const project = await getDoc<Project>(COL.PROJECTS, req.user!.projectId).catch(() => null);
    res.json({
      profile,
      project: project
        ? { id: project.$id, title: project.title, productionHouse: project.productionHouse ?? '', status: project.status }
        : null,
      avatarUrl: profile.avatarFileId ? avatarUrl(profile.avatarFileId) : null,
      isMaster: isMasterEmail(req.authUser?.email),
    });
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
 * POST /crew/invite — admin only.
 * With email+password (current login method): creates the Appwrite auth
 * account (pre-verified), the profile, and the team membership in one go —
 * the crew member can sign in with email+password immediately.
 * Without email: legacy pre-registration by phone; the profile auto-links
 * on first phone-OTP login via /auth/bootstrap (future update).
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
        email: z.string().email().max(256).optional(),
        password: z.string().min(8).max(128).optional(),
      })
      .refine((b) => !b.email === !b.password, {
        message: 'email and password must be provided together',
        path: ['password'],
      })
      .parse(req.body);

    const phone = normalizePhone(body.phone);
    const projectId = req.user!.projectId;

    const dup = await listDocs<UserProfile>(COL.USERS, [
      Query.equal('projectId', projectId),
      Query.equal('phone', phone),
      Query.limit(1),
    ]);
    const existingProfile = dup.documents[0];
    if (existingProfile?.authUserId) {
      throw new AppError(409, `${phone} is already registered in this project`);
    }

    // Legacy phone-only invite (kept for the future phone-OTP update)
    if (!body.email || !body.password) {
      if (existingProfile) {
        throw new AppError(409, `${phone} is already invited to this project`);
      }
      const profile = await createDoc<UserProfile>(
        COL.USERS,
        { phone, name: body.name, role: body.role, projectId, active: true },
        projectId,
      );
      res.status(201).json({ profile, accountCreated: false });
      return;
    }

    // Email+password invite: create the sign-in account now
    const email = body.email.toLowerCase();
    let authUserId: string;
    try {
      const account = await awUsers.create(ID.unique(), email, phone, body.password, body.name);
      authUserId = account.$id;
    } catch (err) {
      throw new AppError(409, 'An account with this email or phone already exists', {
        cause: (err as Error).message,
      });
    }
    await awUsers.updateEmailVerification(authUserId, true);
    await awUsers.updatePhoneVerification(authUserId, true);

    // Attach to the existing unlinked invite if there is one
    const profile = existingProfile
      ? await updateDoc<UserProfile>(COL.USERS, existingProfile.$id, {
          authUserId,
          name: body.name,
          role: body.role,
          email,
        })
      : await createDoc<UserProfile>(
          COL.USERS,
          { authUserId, phone, email, name: body.name, role: body.role, projectId, active: true },
          projectId,
        );
    await joinProjectTeam(projectId, authUserId, body.role, body.name);

    res.status(201).json({ profile, accountCreated: true, credentials: { email } });
  }),
);

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new AppError(422, 'Avatar must be a JPG, PNG or WebP image (max 5 MB)'));
  },
});

/** Public view URL for an avatar file (per-file read:any permission). */
const avatarUrl = (fileId: string): string =>
  `${env.APPWRITE_ENDPOINT}/storage/buckets/${BUCKETS.AVATARS}/files/${fileId}/view?project=${env.APPWRITE_PROJECT}`;

/** POST /users/me/avatar — multipart field "file"; replaces the old avatar. */
router.post(
  '/users/me/avatar',
  ...authenticate,
  avatarUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(422, 'Multipart field "file" (image) is required');
    const user = req.user!;

    const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const file = await storage.createFile(
      BUCKETS.AVATARS,
      ID.unique(),
      InputFile.fromBuffer(req.file.buffer, `avatar-${user.userId}.${ext}`),
      [Permission.read(AwRole.any())],
    );

    const current = await getDoc<UserProfile>(COL.USERS, user.userId);
    const profile = await updateDoc<UserProfile>(COL.USERS, user.userId, {
      avatarFileId: file.$id,
    });
    if (current.avatarFileId) {
      storage.deleteFile(BUCKETS.AVATARS, current.avatarFileId).catch(() => undefined);
    }

    res.status(201).json({ profile, avatarUrl: avatarUrl(file.$id) });
  }),
);

/**
 * PATCH /crew/:id — direction roles manage a crew member: deactivate/
 * reactivate (active), rename, or change role. Deactivation revokes the
 * member's sessions and blocks all API access (auth middleware checks
 * `active`). Guards: you cannot deactivate yourself; only the director
 * may modify direction-role members or promote someone into one.
 */
router.patch(
  '/crew/:id',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        active: z.boolean().optional(),
        name: z.string().min(1).max(128).optional(),
        role: z.enum(ALL_ROLES as [string, ...string[]]).optional(),
      })
      .parse(req.body);
    const caller = req.user!;

    const target = await getDoc<UserProfile>(COL.USERS, req.params.id);
    if (target.projectId !== caller.projectId) throw new AppError(404, 'Crew member not found');
    if (target.$id === caller.userId && body.active === false) {
      throw new AppError(422, 'You cannot deactivate yourself');
    }
    const touchesDirection =
      DIRECTION_ROLES.includes(target.role) ||
      (body.role !== undefined && DIRECTION_ROLES.includes(body.role as (typeof DIRECTION_ROLES)[number]));
    if (touchesDirection && caller.role !== 'director') {
      throw new AppError(403, 'Only the director can modify direction-role members');
    }

    const profile = await updateDoc<UserProfile>(COL.USERS, req.params.id, body);
    if (body.active === false && target.authUserId) {
      await awUsers.deleteSessions(target.authUserId).catch(() => undefined);
    }
    res.json({ profile });
  }),
);

/**
 * POST /crew/:id/reset-password — direction roles reset a crew member's
 * password (no email recovery in MVP). Privilege rule: only the director
 * may reset another direction-role account (prevents an AD from taking
 * over the director's login). Directors' own passwords are reset by the
 * master admin. Active sessions of the target are revoked.
 */
router.post(
  '/crew/:id/reset-password',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = z.object({ password: z.string().min(8).max(128) }).parse(req.body);
    const caller = req.user!;

    const target = await getDoc<UserProfile>(COL.USERS, req.params.id);
    if (target.projectId !== caller.projectId) throw new AppError(404, 'Crew member not found');
    if (!target.authUserId) {
      throw new AppError(409, 'This crew member has no sign-in account yet (re-invite with email + password)');
    }
    if (target.$id === caller.userId) {
      throw new AppError(422, 'Use your own account settings to change your password');
    }
    if (DIRECTION_ROLES.includes(target.role) && caller.role !== 'director') {
      throw new AppError(403, 'Only the director can reset a direction-role password');
    }

    await awUsers.updatePassword(target.authUserId, body.password);
    await awUsers.deleteSessions(target.authUserId).catch(() => undefined);

    res.json({ ok: true, name: target.name, email: target.email ?? null });
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
        email: u.email ?? null,
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
