import { Router } from 'express';
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
  listDocs,
  updateDoc,
} from '../services/appwrite.service';
import type { ActorCall, ShootDay, UserProfile } from '../types';
import { DIRECTION_ROLES } from '../types';

/**
 * Actor call-time management (direction roles only). Not enumerated in
 * spec §5, but required by it: the publish workflow validates that every
 * actor in a day's scenes has an actor_calls entry — so the entries need
 * an API to be created through.
 */
const router = Router();
router.use(...authenticate);
router.use(requireRole(DIRECTION_ROLES));

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const upsertSchema = z.object({
  shootDayId: z.string().min(1),
  actorId: z.string().min(1),
  pickupTime: timeString.optional(),
  callTime: timeString.optional(),
  makeupTime: timeString.optional(),
  hairTime: timeString.optional(),
  onSetTime: timeString.optional(),
  lunchTime: timeString.optional(),
  sceneIds: z.array(z.string()).optional(),
});

const patchSchema = upsertSchema.omit({ shootDayId: true, actorId: true }).partial();

async function assertOwnDay(shootDayId: string, projectId: string): Promise<ShootDay> {
  const day = await getDoc<ShootDay>(COL.SHOOT_DAYS, shootDayId);
  if (day.projectId !== projectId) throw new AppError(404, 'Shoot day not found');
  return day;
}

/** GET /actor-calls?shootDayId= — all call entries of a day. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = z.object({ shootDayId: z.string().min(1) }).parse(req.query);
    await assertOwnDay(query.shootDayId, req.user!.projectId);
    const calls = await listAllDocs<ActorCall>(COL.ACTOR_CALLS, [
      Query.equal('shootDayId', query.shootDayId),
    ]);
    res.json({ actorCalls: calls });
  }),
);

/**
 * POST /actor-calls — upsert by (shootDayId, actorId): creates the entry
 * or updates the existing one, so the day editor can just save.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = upsertSchema.parse(req.body);
    const projectId = req.user!.projectId;

    await assertOwnDay(body.shootDayId, projectId);
    const actor = await getDoc<UserProfile>(COL.USERS, body.actorId);
    if (actor.projectId !== projectId) throw new AppError(404, 'Crew member not found');

    const { shootDayId, actorId, ...times } = body;
    const existing = await listDocs<ActorCall>(COL.ACTOR_CALLS, [
      Query.equal('shootDayId', shootDayId),
      Query.equal('actorId', actorId),
      Query.limit(1),
    ]);

    if (existing.documents[0]) {
      const updated = await updateDoc<ActorCall>(COL.ACTOR_CALLS, existing.documents[0].$id, times);
      res.json({ actorCall: updated, created: false });
      return;
    }

    const created = await createDoc<ActorCall>(
      COL.ACTOR_CALLS,
      { projectId, shootDayId, actorId, sceneIds: [], ...times },
      projectId,
    );
    res.status(201).json({ actorCall: created, created: true });
  }),
);

/** PATCH /actor-calls/:id */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const call = await getDoc<ActorCall>(COL.ACTOR_CALLS, req.params.id);
    if (call.projectId !== req.user!.projectId) throw new AppError(404, 'Actor call not found');
    const updated = await updateDoc<ActorCall>(COL.ACTOR_CALLS, req.params.id, body);
    res.json({ actorCall: updated });
  }),
);

/** DELETE /actor-calls/:id */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const call = await getDoc<ActorCall>(COL.ACTOR_CALLS, req.params.id);
    if (call.projectId !== req.user!.projectId) throw new AppError(404, 'Actor call not found');
    await deleteDoc(COL.ACTOR_CALLS, req.params.id);
    res.json({ ok: true });
  }),
);

export default router;
