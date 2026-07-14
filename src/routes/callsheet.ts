import { Router } from 'express';
import { BUCKETS, storage } from '../config/appwrite';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { COL, getDoc } from '../services/appwrite.service';
import type { ShootDay } from '../types';
import { signPath, verifySignedPath } from '../utils/signedUrl';

const router = Router();

const CALLSHEET_URL_TTL_SECONDS = 24 * 60 * 60; // spec §8: ≤ 24h

/**
 * GET /callsheet/:shootDayId/pdf — team members only. Returns an
 * HMAC-signed, 24h download URL for the generated call sheet.
 */
router.get(
  '/:shootDayId/pdf',
  ...authenticate,
  asyncHandler(async (req, res) => {
    const day = await getDoc<ShootDay>(COL.SHOOT_DAYS, req.params.shootDayId);
    if (day.projectId !== req.user!.projectId) throw new AppError(404, 'Shoot day not found');
    if (!day.callSheetFileId) throw new AppError(404, 'Call sheet not generated yet');

    const path = `/api/v1/callsheet/${day.$id}/download`;
    const signed = signPath(req, path, CALLSHEET_URL_TTL_SECONDS);
    res.json({ ...signed, dayNumber: day.dayNumber });
  }),
);

/**
 * GET /callsheet/:shootDayId/download?exp=&sig= — signature-authenticated
 * (no JWT: the signed URL is the credential; it expires per spec §8).
 */
router.get(
  '/:shootDayId/download',
  asyncHandler(async (req, res) => {
    const path = `/api/v1/callsheet/${req.params.shootDayId}/download`;
    if (!verifySignedPath(path, req.query.exp as string, req.query.sig as string)) {
      throw new AppError(403, 'Invalid or expired download link');
    }

    const day = await getDoc<ShootDay>(COL.SHOOT_DAYS, req.params.shootDayId);
    if (!day.callSheetFileId) throw new AppError(404, 'Call sheet not generated yet');

    const bytes = await storage.getFileDownload(BUCKETS.CALLSHEETS, day.callSheetFileId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="callsheet-day-${day.dayNumber}.pdf"`,
    );
    res.send(Buffer.from(bytes));
  }),
);

export default router;
