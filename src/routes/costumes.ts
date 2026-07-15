import { Router, type Request } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import {
  COL,
  createDoc,
  deleteDoc,
  getDoc,
  listAllDocs,
  updateDoc,
} from '../services/appwrite.service';
import { costumesForScenes, findShootDay, scenesOfDay } from '../services/day.service';
import { notify } from '../services/notification.service';
import type { Costume, Scene } from '../types';
import { DIRECTION_ROLES, type Role } from '../types';

const router = Router();
router.use(...authenticate);

const COSTUME_ROLES: Role[] = ['costume', ...DIRECTION_ROLES];

async function dayCostumes(req: Request, offset: 0 | 1) {
  const user = req.user!;
  const day = await findShootDay(user.projectId, offset);
  if (!day) throw new AppError(404, offset === 0 ? 'No shoot day today' : 'No shoot day tomorrow');
  // Tomorrow is only visible once published (spec §5); today needs to be
  // at least published for non-direction roles.
  if (day.status === 'draft' && (offset === 1 || !DIRECTION_ROLES.includes(user.role))) {
    throw new AppError(404, 'Call sheet not published yet');
  }
  const scenes = await scenesOfDay(day.$id);
  const costumes = await costumesForScenes(user.projectId, scenes.map((s) => s.$id));
  return { shootDay: day, scenes, costumes };
}

/** GET /costumes/today */
router.get(
  '/today',
  requireRole(COSTUME_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await dayCostumes(req, 0));
  }),
);

/** GET /costumes/tomorrow — only if published. */
router.get(
  '/tomorrow',
  requireRole(COSTUME_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await dayCostumes(req, 1));
  }),
);

const createSchema = z.object({
  actorId: z.string().min(1),
  sceneIds: z.array(z.string()).default([]),
  costumeNumber: z.string().min(1).max(32),
  lookDescription: z.string().max(2000).optional(),
  accessories: z.array(z.string().max(128)).default([]),
  tomorrowReady: z.boolean().default(false),
});

/** POST /costumes — costume + admin roles (needed so inventory can exist; not enumerated in spec §5 but required by the data model). */
router.post(
  '/',
  requireRole(COSTUME_ROLES),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const costume = await createDoc<Costume>(
      COL.COSTUMES,
      { ...body, projectId: req.user!.projectId, status: 'pending' },
      req.user!.projectId,
    );
    res.status(201).json({ costume });
  }),
);

/** PATCH /costumes/:id — general edits. */
router.patch(
  '/:id',
  requireRole(COSTUME_ROLES),
  asyncHandler(async (req, res) => {
    const body = createSchema.partial().parse(req.body);
    const existing = await getDoc<Costume>(COL.COSTUMES, req.params.id);
    if (existing.projectId !== req.user!.projectId) throw new AppError(404, 'Costume not found');
    const costume = await updateDoc<Costume>(COL.COSTUMES, req.params.id, body);
    res.json({ costume });
  }),
);

/**
 * PATCH /costumes/:id/status — costume+admin roles.
 * When ALL costumes of a scene become `ready`:
 *   - notify direction: "👗 Costumes ready — Scene {n}" (silent, spec §6)
 *   - if body.broadcast === true, auto-create a scene_ready walkie_event
 */
router.patch(
  '/:id/status',
  requireRole(COSTUME_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum(['pending', 'ready', 'on_actor', 'laundry', 'repair']),
        broadcast: z.boolean().default(false),
      })
      .parse(req.body);

    const user = req.user!;
    const existing = await getDoc<Costume>(COL.COSTUMES, req.params.id);
    if (existing.projectId !== user.projectId) throw new AppError(404, 'Costume not found');

    const costume = await updateDoc<Costume>(COL.COSTUMES, req.params.id, {
      status: body.status,
    });

    const readyScenes: Scene[] = [];
    if (body.status === 'ready' && costume.sceneIds.length > 0) {
      for (const sceneId of costume.sceneIds) {
        const sceneCostumes = await listAllDocs<Costume>(COL.COSTUMES, [
          Query.equal('projectId', user.projectId),
          Query.contains('sceneIds', sceneId),
        ]);
        if (sceneCostumes.length > 0 && sceneCostumes.every((c) => c.status === 'ready')) {
          try {
            const scene = await getDoc<Scene>(COL.SCENES, sceneId);
            readyScenes.push(scene);
          } catch {
            // stale sceneId reference — skip
          }
        }
      }
    }

    for (const scene of readyScenes) {
      await notify({
        projectId: user.projectId,
        targetRoles: DIRECTION_ROLES,
        title: '👗 Costumes ready',
        body: `Costumes ready — Scene ${scene.sceneNumber}`,
        type: 'costume_ready',
        deepLink: `setsync://scene/${scene.$id}`,
        sound: false,
      });

      if (body.broadcast) {
        await createDoc(
          COL.WALKIE_EVENTS,
          {
            projectId: user.projectId,
            shootDayId: scene.shootDayId,
            type: 'scene_ready',
            message: `Costumes ready — Scene ${scene.sceneNumber}`,
            senderId: user.userId,
            senderRole: user.role,
            senderName: user.name,
          },
          user.projectId,
        );
      }
    }

    res.json({ costume, scenesFullyReady: readyScenes.map((s) => s.sceneNumber) });
  }),
);

/** DELETE /costumes/:id */
router.delete(
  '/:id',
  requireRole(COSTUME_ROLES),
  asyncHandler(async (req, res) => {
    const existing = await getDoc<Costume>(COL.COSTUMES, req.params.id);
    if (existing.projectId !== req.user!.projectId) throw new AppError(404, 'Costume not found');
    await deleteDoc(COL.COSTUMES, req.params.id);
    res.json({ ok: true });
  }),
);

export default router;
