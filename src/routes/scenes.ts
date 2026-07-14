import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import { COL, createDoc, getDoc, listDocs, updateDoc } from '../services/appwrite.service';
import { notify } from '../services/notification.service';
import type { Scene, ShootDay } from '../types';
import { DIRECTION_ROLES } from '../types';
import { Query } from 'node-appwrite';

const router = Router();
router.use(...authenticate);
router.use(requireRole(DIRECTION_ROLES)); // all scene writes are admin-only (spec §5)

const createSchema = z.object({
  shootDayId: z.string().min(1),
  sceneNumber: z.string().min(1).max(16),
  intExt: z.enum(['INT', 'EXT']),
  dayNight: z.enum(['DAY', 'NIGHT']),
  locationName: z.string().min(1).max(256),
  synopsis: z.string().max(2000).optional(),
  actorIds: z.array(z.string()).default([]),
  scriptPageStart: z.number().int().positive(),
  scriptPageEnd: z.number().int().positive(),
  order: z.number().int().nonnegative().optional(),
});

const patchSchema = createSchema.omit({ shootDayId: true }).partial();

/** Fields whose change means "scene/location/time changed" → sound notification. */
const NOTIFY_FIELDS = ['locationName', 'dayNight', 'intExt', 'sceneNumber'] as const;

async function getOwnScene(id: string, projectId: string): Promise<Scene> {
  const scene = await getDoc<Scene>(COL.SCENES, id);
  if (scene.projectId !== projectId) throw new AppError(404, 'Scene not found');
  return scene;
}

async function notifySceneLinked(
  scene: Scene,
  title: string,
  body: string,
  type: string,
  sound: boolean,
): Promise<void> {
  // "roles + actors linked to that scene": the actors in the scene plus the
  // costume & art departments that prep it.
  await notify({
    projectId: scene.projectId,
    targetRoles: ['costume', 'art'],
    targetUserIds: scene.actorIds,
    title,
    body,
    type,
    deepLink: `setsync://scene/${scene.$id}`,
    sound,
  });
}

/** POST /scenes */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    if (body.scriptPageEnd < body.scriptPageStart) {
      throw new AppError(422, 'scriptPageEnd must be >= scriptPageStart');
    }
    const projectId = req.user!.projectId;

    const day = await getDoc<ShootDay>(COL.SHOOT_DAYS, body.shootDayId);
    if (day.projectId !== projectId) throw new AppError(404, 'Shoot day not found');

    let order = body.order;
    if (order === undefined) {
      const existing = await listDocs<Scene>(COL.SCENES, [
        Query.equal('shootDayId', body.shootDayId),
        Query.limit(1),
      ]);
      order = existing.total + 1;
    }

    const scene = await createDoc<Scene>(
      COL.SCENES,
      { ...body, order, projectId, status: 'pending' },
      projectId,
    );
    res.status(201).json({ scene });
  }),
);

/** PATCH /scenes/reorder — must be declared before /:id routes. */
router.patch(
  '/reorder',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        items: z.array(z.object({ sceneId: z.string(), order: z.number().int().nonnegative() })).min(1),
      })
      .parse(req.body);

    const updated: Scene[] = [];
    for (const item of body.items) {
      await getOwnScene(item.sceneId, req.user!.projectId);
      updated.push(await updateDoc<Scene>(COL.SCENES, item.sceneId, { order: item.order }));
    }
    res.json({ scenes: updated });
  }),
);

/** PATCH /scenes/:id — notifies scene-linked people when location/time facts change. */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    if (
      body.scriptPageStart !== undefined &&
      body.scriptPageEnd !== undefined &&
      body.scriptPageEnd < body.scriptPageStart
    ) {
      throw new AppError(422, 'scriptPageEnd must be >= scriptPageStart');
    }
    const before = await getOwnScene(req.params.id, req.user!.projectId);
    const scene = await updateDoc<Scene>(COL.SCENES, req.params.id, body);

    const changed = NOTIFY_FIELDS.filter(
      (f) => body[f] !== undefined && body[f] !== before[f],
    );
    if (changed.length > 0) {
      await notifySceneLinked(
        scene,
        '🎬 Scene updated',
        `Scene ${scene.sceneNumber}: ${changed.join(', ')} changed`,
        'scene_changed',
        true,
      );
    }
    res.json({ scene });
  }),
);

/** PATCH /scenes/:id/status — notify roles linked to that scene only. */
router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const body = z
      .object({ status: z.enum(['pending', 'ready', 'shooting', 'completed']) })
      .parse(req.body);

    const before = await getOwnScene(req.params.id, req.user!.projectId);
    if (before.status === body.status) {
      res.json({ scene: before });
      return;
    }
    const scene = await updateDoc<Scene>(COL.SCENES, req.params.id, { status: body.status });

    await notifySceneLinked(
      scene,
      '🎬 Scene status',
      `Scene ${scene.sceneNumber} is now ${body.status}`,
      'scene_status',
      true,
    );
    res.json({ scene });
  }),
);

export default router;
