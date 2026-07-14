import { Router } from 'express';
import { Query } from 'node-appwrite';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { COL, getDoc, listDocs, updateDoc } from '../services/appwrite.service';
import type { NotificationDoc } from '../types';

const router = Router();
router.use(...authenticate);

/** GET /notifications — targeted to the caller (role or userId match), paginated. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const user = req.user!;
    const result = await listDocs<NotificationDoc>(COL.NOTIFICATIONS, [
      Query.equal('projectId', user.projectId),
      Query.or([
        Query.contains('targetRoles', user.role),
        Query.contains('targetUserIds', user.userId),
      ]),
      Query.orderDesc('$createdAt'),
      Query.limit(query.limit),
      Query.offset(query.offset),
    ]);

    res.json({
      total: result.total,
      limit: query.limit,
      offset: query.offset,
      notifications: result.documents.map((n) => ({
        ...n,
        read: n.readBy.includes(user.userId),
      })),
    });
  }),
);

/** PATCH /notifications/:id/read */
router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const doc = await getDoc<NotificationDoc>(COL.NOTIFICATIONS, req.params.id);
    if (doc.projectId !== user.projectId) throw new AppError(404, 'Notification not found');

    if (!doc.readBy.includes(user.userId)) {
      await updateDoc<NotificationDoc>(COL.NOTIFICATIONS, req.params.id, {
        readBy: [...doc.readBy, user.userId],
      });
    }
    res.json({ ok: true });
  }),
);

export default router;
