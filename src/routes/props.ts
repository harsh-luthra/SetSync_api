import { Router, type Request } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import { COL, createDoc, deleteDoc, getDoc, listAllDocs, updateDoc } from '../services/appwrite.service';
import { findShootDay, propsForScenes, scenesOfDay } from '../services/day.service';
import type { Prop, PropStatus } from '../types';
import { DIRECTION_ROLES, PROP_STAGE_ORDER, type Role } from '../types';
import { dayWindowUtc } from '../utils/time';

const router = Router();
router.use(...authenticate);

const ART_ROLES: Role[] = ['art', ...DIRECTION_ROLES];

async function dayProps(req: Request, offset: 0 | 1) {
  const user = req.user!;
  const day = await findShootDay(user.projectId, offset);
  if (!day) throw new AppError(404, offset === 0 ? 'No shoot day today' : 'No shoot day tomorrow');
  if (day.status === 'draft' && (offset === 1 || !DIRECTION_ROLES.includes(user.role))) {
    throw new AppError(404, 'Call sheet not published yet');
  }
  const scenes = await scenesOfDay(day.$id);
  const sceneProps = await propsForScenes(user.projectId, scenes.map((s) => s.$id));

  // Also include props whose neededDate falls on that day
  const { startIso, endIso } = dayWindowUtc(offset);
  const dated = await listAllDocs<Prop>(COL.PROPS, [
    Query.equal('projectId', user.projectId),
    Query.greaterThanEqual('neededDate', startIso),
    Query.lessThan('neededDate', endIso),
  ]);
  const merged = new Map<string, Prop>();
  for (const p of [...sceneProps, ...dated]) merged.set(p.$id, p);

  return { shootDay: day, scenes, props: [...merged.values()] };
}

/** GET /props/today */
router.get(
  '/today',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await dayProps(req, 0));
  }),
);

/** GET /props/tomorrow */
router.get(
  '/tomorrow',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await dayProps(req, 1));
  }),
);

/** GET /props — full inventory, filterable by ?status= and ?q= (name substring). */
router.get(
  '/',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        status: z.enum(PROP_STAGE_ORDER as [PropStatus, ...PropStatus[]]).optional(),
        q: z.string().max(128).optional(),
      })
      .parse(req.query);

    const filters = [Query.equal('projectId', req.user!.projectId)];
    if (query.status) filters.push(Query.equal('status', query.status));

    let props = await listAllDocs<Prop>(COL.PROPS, filters);
    if (query.q) {
      const needle = query.q.toLowerCase();
      props = props.filter((p) => p.name.toLowerCase().includes(needle));
    }
    res.json({ props });
  }),
);

/** POST /props — art + admin roles. */
router.post(
  '/',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(256),
        quantity: z.number().int().positive().default(1),
        sceneIds: z.array(z.string()).default([]),
        notes: z.string().max(2000).optional(),
        neededDate: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.body);

    const prop = await createDoc<Prop>(
      COL.PROPS,
      { ...body, projectId: req.user!.projectId, status: 'to_purchase' },
      req.user!.projectId,
    );
    res.status(201).json({ prop });
  }),
);

/** PATCH /props/:id — general edits (status changes go through /:id/status). */
router.patch(
  '/:id',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(256).optional(),
        quantity: z.number().int().positive().optional(),
        sceneIds: z.array(z.string()).optional(),
        notes: z.string().max(2000).optional(),
        neededDate: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .parse(req.body);

    const prop = await getDoc<Prop>(COL.PROPS, req.params.id);
    if (prop.projectId !== req.user!.projectId) throw new AppError(404, 'Prop not found');
    const updated = await updateDoc<Prop>(COL.PROPS, req.params.id, body);
    res.json({ prop: updated });
  }),
);

/** DELETE /props/:id */
router.delete(
  '/:id',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    const prop = await getDoc<Prop>(COL.PROPS, req.params.id);
    if (prop.projectId !== req.user!.projectId) throw new AppError(404, 'Prop not found');
    await deleteDoc(COL.PROPS, req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * PATCH /props/:id/status — enforce stage order
 * to_purchase → purchased → packed → on_set → returned (one step back allowed).
 */
router.patch(
  '/:id/status',
  requireRole(ART_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ status: z.enum(PROP_STAGE_ORDER as [PropStatus, ...PropStatus[]]) })
      .parse(req.body);

    const prop = await getDoc<Prop>(COL.PROPS, req.params.id);
    if (prop.projectId !== req.user!.projectId) throw new AppError(404, 'Prop not found');

    const from = PROP_STAGE_ORDER.indexOf(prop.status);
    const to = PROP_STAGE_ORDER.indexOf(body.status);
    const delta = to - from;
    if (delta !== 1 && delta !== -1) {
      throw new AppError(
        422,
        `Invalid transition ${prop.status} → ${body.status}. Stages move one step forward (${PROP_STAGE_ORDER.join(' → ')}) or one step back.`,
      );
    }

    const updated = await updateDoc<Prop>(COL.PROPS, req.params.id, { status: body.status });
    res.json({ prop: updated });
  }),
);

export default router;
