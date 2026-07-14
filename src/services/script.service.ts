import { Query } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { BUCKETS, storage } from '../config/appwrite';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';
import type { Project, RequestUser, Scene } from '../types';
import { COL, getDoc, listAllDocs } from './appwrite.service';

/**
 * SECURITY-CRITICAL (spec §5 Script):
 * - The master script lives in the `scripts` bucket with NO client access.
 * - Actors only ever receive a server-generated slice of their own scenes,
 *   watermarked with their identity.
 * - The master fileId is never exposed to clients.
 * - Slices are cached per (actor, script version); a re-upload bumps the
 *   version, which naturally invalidates old cache entries.
 */

const cacheFileId = (actorId: string, version: number): string => `s-${actorId}-v${version}`;

export async function getActorScriptSlice(
  user: RequestUser,
): Promise<{ buffer: Buffer; filename: string }> {
  const project = await getDoc<Project>(COL.PROJECTS, user.projectId);
  if (!project.scriptFileId) {
    throw new AppError(404, 'No script has been uploaded for this project yet');
  }
  const version = project.scriptVersion ?? 1;
  const filename = `script-${user.name.replace(/[^a-zA-Z0-9]+/g, '_')}-v${version}.pdf`;

  // Cache hit?
  const cachedId = cacheFileId(user.userId, version);
  try {
    const cached = await storage.getFileDownload(BUCKETS.SCRIPTS, cachedId);
    return { buffer: Buffer.from(cached), filename };
  } catch {
    // cache miss — build the slice
  }

  // Actor's scenes → page ranges
  const scenes = await listAllDocs<Scene>(COL.SCENES, [
    Query.equal('projectId', user.projectId),
    Query.contains('actorIds', user.userId),
  ]);
  if (scenes.length === 0) {
    throw new AppError(404, 'You have no scenes assigned yet');
  }

  const master = await storage.getFileDownload(BUCKETS.SCRIPTS, project.scriptFileId);
  const masterPdf = await PDFDocument.load(Buffer.from(master));
  const pageCount = masterPdf.getPageCount();

  // Union of 1-based page numbers across the actor's scenes
  const pages = new Set<number>();
  for (const scene of scenes) {
    const start = Math.max(1, scene.scriptPageStart);
    const end = Math.min(pageCount, Math.max(start, scene.scriptPageEnd));
    for (let p = start; p <= end; p++) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new AppError(404, 'No valid script pages found for your scenes');
  }

  const sliced = await PDFDocument.create();
  const copied = await sliced.copyPages(masterPdf, sorted.map((p) => p - 1));
  copied.forEach((page) => sliced.addPage(page));

  // Diagonal watermark on every page: "{actorName} • {phone} • SetSync" @ 30% opacity
  const font = await sliced.embedFont(StandardFonts.HelveticaBold);
  const watermark = `${user.name} • ${user.phone} • SetSync`;
  for (const page of sliced.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(36, Math.max(18, (width * 1.15) / watermark.length));
    for (const yFactor of [0.25, 0.6]) {
      page.drawText(watermark, {
        x: width * 0.08,
        y: height * yFactor,
        size: fontSize,
        font,
        color: rgb(0.55, 0.55, 0.55),
        opacity: 0.3,
        rotate: degrees(45),
      });
    }
  }

  const buffer = Buffer.from(await sliced.save());

  // Cache in the server-only scripts bucket (no permissions → API key only)
  try {
    await storage.createFile(BUCKETS.SCRIPTS, cachedId, InputFile.fromBuffer(buffer, filename));
  } catch (err) {
    logger.warn({ err, cachedId }, 'Failed to cache sliced script (continuing)');
  }

  logger.info({ actorId: user.userId, pages: sorted.length, version }, 'Script slice generated');
  return { buffer, filename };
}
