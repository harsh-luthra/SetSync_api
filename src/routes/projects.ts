import { Router } from 'express';
import { ID, Query } from 'node-appwrite';
import { z } from 'zod';
import { teams } from '../config/appwrite';
import { logger } from '../config/logger';
import { authenticate, verifyJwt } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import {
  COL,
  createDoc,
  getDoc,
  listDocs,
  teamIdFor,
  updateDoc,
} from '../services/appwrite.service';
import type { Project, UserProfile } from '../types';
import { ALL_ROLES, DIRECTION_ROLES } from '../types';

const router = Router();

const normalizePhone = (phone: string): string => phone.replace(/[^\d+]/g, '');

/**
 * POST /projects — in-app replacement for the SEED_* env vars.
 * A freshly registered director (valid JWT, NO SetSync profile yet)
 * creates their project here: project document + Appwrite team +
 * their own director profile, all in one call.
 */
router.post(
  '/',
  verifyJwt,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1).max(256),
        productionHouse: z.string().max(256).optional(),
        directorName: z.string().min(1).max(128),
        directorPhone: z.string().min(8).max(20),
        startDate: z.string().datetime({ offset: true }).optional(),
        endDate: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.body);

    const authUser = req.authUser!;

    const existing = await listDocs<UserProfile>(COL.USERS, [
      Query.equal('authUserId', authUser.$id),
      Query.limit(1),
    ]);
    if (existing.documents[0]) {
      throw new AppError(409, 'You already belong to a project', {
        projectId: existing.documents[0].projectId,
      });
    }

    const projectId = ID.unique();
    const teamId = teamIdFor(projectId);
    await teams.create(teamId, `${body.title} crew`, [...ALL_ROLES]);

    const project = await createDoc<Project>(
      COL.PROJECTS,
      {
        title: body.title,
        productionHouse: body.productionHouse || '',
        startDate: body.startDate,
        endDate: body.endDate,
        status: 'prep',
        createdBy: authUser.$id,
        scriptVersion: 0,
      },
      projectId,
      projectId,
    );

    const profile = await createDoc<UserProfile>(
      COL.USERS,
      {
        authUserId: authUser.$id,
        name: body.directorName,
        phone: normalizePhone(body.directorPhone),
        role: 'director',
        projectId,
        active: true,
      },
      projectId,
    );

    try {
      await teams.createMembership(
        teamId,
        ['director'],
        undefined,
        authUser.$id,
        undefined,
        undefined,
        body.directorName,
      );
    } catch (err) {
      logger.warn({ err, projectId }, 'Team membership create failed (non-fatal)');
    }

    res.status(201).json({ project, profile });
  }),
);

/** GET /projects/me — the caller's project (any role). */
router.get(
  '/me',
  ...authenticate,
  asyncHandler(async (req, res) => {
    const project = await getDoc<Project>(COL.PROJECTS, req.user!.projectId);
    res.json({ project });
  }),
);

/** PATCH /projects/me — direction roles; edit title/house/status/dates. */
router.patch(
  '/me',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1).max(256).optional(),
        productionHouse: z.string().max(256).optional(),
        status: z.enum(['prep', 'shooting', 'wrapped']).optional(),
        startDate: z.string().datetime({ offset: true }).optional(),
        endDate: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.body);
    const project = await updateDoc<Project>(COL.PROJECTS, req.user!.projectId, body);
    res.json({ project });
  }),
);

export default router;
