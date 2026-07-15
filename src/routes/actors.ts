import { Router } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import { COL, createDoc, getDoc, listAllDocs, listDocs, updateDoc } from '../services/appwrite.service';
import { findShootDay, shapeDayForRole } from '../services/day.service';
import { notify } from '../services/notification.service';
import type { PrintRequest } from '../types';
import { DIRECTION_ROLES } from '../types';

// NOTE: this router is mounted at the /api/v1 root (it spans /actors and
// /print-requests), so auth is applied per-route — a router-level
// `router.use(authenticate)` here would swallow every /api/v1 request,
// including the signature-authenticated call sheet download.
const router = Router();

/**
 * GET /actors/me/today — call times, scenes, costume numbers, timeline.
 * Same shaping as GET /shootdays/today for the actor role, plus a sorted
 * timeline of the actor's day.
 */
router.get(
  '/actors/me/today',
  ...authenticate,
  requireRole(['actor']),
  asyncHandler(async (req, res) => {
    const day = await findShootDay(req.user!.projectId, 0);
    const shaped = (await shapeDayForRole(req.user!, day)) as {
      shootDay: unknown;
      call: Record<string, string | undefined> | null;
      scenes: unknown[];
      costumes: unknown[];
    };

    const timeline: { label: string; time: string }[] = [];
    const call = shaped.call;
    if (call) {
      const entries: [string, string | undefined][] = [
        ['Pickup', call.pickupTime],
        ['Call', call.callTime],
        ['Makeup', call.makeupTime],
        ['Hair', call.hairTime],
        ['On set', call.onSetTime],
        ['Lunch', call.lunchTime],
      ];
      for (const [label, time] of entries) {
        if (time) timeline.push({ label, time });
      }
      timeline.sort((a, b) => a.time.localeCompare(b.time));
    }

    res.json({ ...shaped, timeline });
  }),
);

/**
 * POST /actors/me/print-request — idempotent per day (also satisfies the
 * 1/day rate limit from spec §8). Notifies direction roles.
 */
router.post(
  '/actors/me/print-request',
  ...authenticate,
  requireRole(['actor']),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const day = await findShootDay(user.projectId, 0);
    if (!day || day.status === 'draft') {
      throw new AppError(404, 'No published shoot day today');
    }

    const existing = await listDocs<PrintRequest>(COL.PRINT_REQUESTS, [
      Query.equal('shootDayId', day.$id),
      Query.equal('actorId', user.userId),
      Query.limit(1),
    ]);
    if (existing.documents[0]) {
      res.json({ printRequest: existing.documents[0], created: false });
      return;
    }

    const printRequest = await createDoc<PrintRequest>(
      COL.PRINT_REQUESTS,
      {
        projectId: user.projectId,
        shootDayId: day.$id,
        actorId: user.userId,
        actorName: user.name,
        status: 'requested',
      },
      user.projectId,
    );

    await notify({
      projectId: user.projectId,
      targetRoles: DIRECTION_ROLES,
      title: '🖨️ Print request',
      body: `${user.name} needs printed script`,
      type: 'print_request',
      deepLink: `setsync://print-request/${printRequest.$id}`,
      sound: false,
    });

    res.status(201).json({ printRequest, created: true });
  }),
);

/**
 * GET /print-requests — direction: the print queue. Defaults to pending
 * (`status=requested`); pass ?status=done or ?status=all for history,
 * and ?shootDayId= to scope to one day.
 */
router.get(
  '/print-requests',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        status: z.enum(['requested', 'done', 'all']).default('requested'),
        shootDayId: z.string().optional(),
      })
      .parse(req.query);

    const filters = [
      Query.equal('projectId', req.user!.projectId),
      Query.orderDesc('$createdAt'),
    ];
    if (query.status !== 'all') filters.push(Query.equal('status', query.status));
    if (query.shootDayId) filters.push(Query.equal('shootDayId', query.shootDayId));

    const printRequests = await listAllDocs<PrintRequest>(COL.PRINT_REQUESTS, filters);
    res.json({ printRequests, pendingCount: printRequests.filter((p) => p.status === 'requested').length });
  }),
);

/** PATCH /print-requests/:id/done — admin. */
router.patch(
  '/print-requests/:id/done',
  ...authenticate,
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const pr = await getDoc<PrintRequest>(COL.PRINT_REQUESTS, req.params.id);
    if (pr.projectId !== req.user!.projectId) throw new AppError(404, 'Print request not found');
    const updated = await updateDoc<PrintRequest>(COL.PRINT_REQUESTS, req.params.id, {
      status: 'done',
    });
    res.json({ printRequest: updated });
  }),
);

export default router;
