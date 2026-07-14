import { Router } from 'express';
import { ID, Query } from 'node-appwrite';
import { z } from 'zod';
import { awUsers } from '../config/appwrite';
import { verifyJwt } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireMaster } from '../middleware/requireMaster';
import { COL, listAllDocs } from '../services/appwrite.service';
import type { UserProfile } from '../types';

/**
 * Master-admin endpoints — account management only (no project data).
 * The master registers director ACCOUNTS (email+password in Appwrite
 * Auth); each director then creates their own project in the app via
 * POST /projects. Masters are configured via MASTER_ADMIN_EMAILS.
 */
const router = Router();
router.use(verifyJwt, requireMaster);

const DIRECTOR_LABEL = 'director';

const normalizePhone = (phone: string): string => phone.replace(/[^\d+]/g, '');

/** POST /master/directors — register a director sign-in account. */
router.post(
  '/directors',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(128),
        email: z.string().email().max(256),
        phone: z.string().min(8).max(20),
        password: z.string().min(8).max(128),
      })
      .parse(req.body);

    let created;
    try {
      created = await awUsers.create(
        ID.unique(),
        body.email.toLowerCase(),
        normalizePhone(body.phone),
        body.password,
        body.name,
      );
    } catch (err) {
      throw new AppError(409, 'An account with this email or phone already exists', {
        cause: (err as Error).message,
      });
    }

    // Pre-verified (no email/SMS delivery in MVP) + labeled for listing
    await awUsers.updateEmailVerification(created.$id, true);
    await awUsers.updatePhoneVerification(created.$id, true);
    await awUsers.updateLabels(created.$id, [DIRECTOR_LABEL]);

    res.status(201).json({
      director: {
        authUserId: created.$id,
        name: created.name,
        email: created.email,
        phone: created.phone,
      },
    });
  }),
);

/** GET /master/directors — registered directors + whether each has a project. */
router.get(
  '/directors',
  asyncHandler(async (_req, res) => {
    const accounts = await awUsers.list([Query.limit(100)]);
    const directors = accounts.users.filter((u) => u.labels?.includes(DIRECTOR_LABEL));

    const authIds = directors.map((d) => d.$id);
    const profiles =
      authIds.length > 0
        ? await listAllDocs<UserProfile>(COL.USERS, [Query.equal('authUserId', authIds)])
        : [];
    const projectOf = new Map(profiles.map((p) => [p.authUserId, p.projectId]));

    res.json({
      directors: directors.map((d) => ({
        authUserId: d.$id,
        name: d.name,
        email: d.email,
        phone: d.phone,
        hasProject: projectOf.has(d.$id),
        projectId: projectOf.get(d.$id) ?? null,
      })),
    });
  }),
);

/** PATCH /master/directors/:authUserId/password — reset a director's password. */
router.patch(
  '/directors/:authUserId/password',
  asyncHandler(async (req, res) => {
    const body = z.object({ password: z.string().min(8).max(128) }).parse(req.body);

    const target = await awUsers.get(req.params.authUserId).catch(() => null);
    if (!target || !target.labels?.includes(DIRECTOR_LABEL)) {
      throw new AppError(404, 'Director account not found');
    }

    await awUsers.updatePassword(target.$id, body.password);
    // Force re-login everywhere with the new password
    await awUsers.deleteSessions(target.$id).catch(() => undefined);

    res.json({ ok: true, email: target.email });
  }),
);

export default router;
