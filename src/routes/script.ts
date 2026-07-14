import { Router } from 'express';
import multer from 'multer';
import { ID } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { BUCKETS, storage } from '../config/appwrite';
import { logger } from '../config/logger';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import { COL, getDoc, updateDoc } from '../services/appwrite.service';
import { getActorScriptSlice } from '../services/script.service';
import type { Project } from '../types';
import { DIRECTION_ROLES } from '../types';

const router = Router();
router.use(...authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new AppError(422, 'Only PDF files are accepted'));
  },
});

/**
 * POST /script/upload — admin. Full script PDF → `scripts` bucket
 * (server-only access, NO permissions on the file). Bumps scriptVersion,
 * which invalidates all cached per-actor slices.
 */
router.post(
  '/upload',
  requireRole(DIRECTION_ROLES),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(422, 'Multipart field "file" (PDF) is required');
    const projectId = req.user!.projectId;

    const file = await storage.createFile(
      BUCKETS.SCRIPTS,
      ID.unique(),
      InputFile.fromBuffer(req.file.buffer, req.file.originalname || 'script.pdf'),
      // no permissions — only the server API key can touch this bucket
    );

    const project = await getDoc<Project>(COL.PROJECTS, projectId);
    const previousFileId = project.scriptFileId;
    const version = (project.scriptVersion ?? 0) + 1;
    await updateDoc<Project>(COL.PROJECTS, projectId, {
      scriptFileId: file.$id,
      scriptVersion: version,
    });

    if (previousFileId) {
      storage.deleteFile(BUCKETS.SCRIPTS, previousFileId).catch((err) => {
        logger.warn({ err, previousFileId }, 'Could not delete previous master script');
      });
    }

    // Never expose the master fileId to clients
    res.status(201).json({ ok: true, scriptVersion: version });
  }),
);

/**
 * GET /script/me — actor only. Streams a per-actor slice of the master
 * script (only the actor's scene pages), watermarked with their identity.
 */
router.get(
  '/me',
  requireRole(['actor']),
  asyncHandler(async (req, res) => {
    const { buffer, filename } = await getActorScriptSlice(req.user!);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(buffer);
  }),
);

export default router;
