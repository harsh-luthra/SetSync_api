import { Router } from 'express';
import { ID, Query } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { z } from 'zod';
import { BUCKETS, storage } from '../config/appwrite';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { requireRole } from '../middleware/requireRole';
import {
  COL,
  createDoc,
  getDoc,
  teamReadPerms,
  updateDoc,
} from '../services/appwrite.service';
import {
  callsOfDay,
  crewOfProject,
  findShootDay,
  scenesOfDay,
  shapeDayForRole,
} from '../services/day.service';
import { notify } from '../services/notification.service';
import { generateCallSheetPdf, type CallSheetModel } from '../services/pdf.service';
import type { Project, ShootDay, UserProfile } from '../types';
import { DIRECTION_ROLES } from '../types';
import { dateLabel } from '../utils/time';

const router = Router();
router.use(...authenticate);

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const createSchema = z.object({
  date: z.string().datetime({ offset: true }),
  dayNumber: z.number().int().positive(),
  generalCallTime: timeString,
  locationName: z.string().min(1).max(256),
  locationMapUrl: z.string().url().max(1024).optional(),
  generalNotes: z.string().max(2000).optional(),
});

const patchSchema = createSchema.partial();

async function getOwnShootDay(id: string, projectId: string): Promise<ShootDay> {
  const day = await getDoc<ShootDay>(COL.SHOOT_DAYS, id);
  if (day.projectId !== projectId) throw new AppError(404, 'Shoot day not found');
  return day;
}

/** POST /shootdays — admin roles only. */
router.post(
  '/',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const day = await createDoc<ShootDay>(
      COL.SHOOT_DAYS,
      { ...body, projectId: req.user!.projectId, status: 'draft' },
      req.user!.projectId,
    );
    res.status(201).json({ shootDay: day });
  }),
);

/** GET /shootdays/today — role-shaped. */
router.get(
  '/today',
  asyncHandler(async (req, res) => {
    const day = await findShootDay(req.user!.projectId, 0);
    res.json(await shapeDayForRole(req.user!, day));
  }),
);

/** GET /shootdays/tomorrow — role-shaped. */
router.get(
  '/tomorrow',
  asyncHandler(async (req, res) => {
    const day = await findShootDay(req.user!.projectId, 1);
    res.json(await shapeDayForRole(req.user!, day));
  }),
);

/** PATCH /shootdays/:id — admin roles only. */
router.patch(
  '/:id',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    await getOwnShootDay(req.params.id, req.user!.projectId);
    const day = await updateDoc<ShootDay>(COL.SHOOT_DAYS, req.params.id, body);
    res.json({ shootDay: day });
  }),
);

/**
 * GET /shootdays/:id/callsheet-preview — direction only. Renders the SAME
 * call sheet PDF the publish step would generate, but changes nothing and
 * notifies no one — a dry run for "Preview → looks good → Publish".
 * Streams PDF bytes (JWT-authenticated, like /script/me). Also returns the
 * publish validation verdict in the X-Publish-Issues header so the app can
 * show the checklist alongside the preview.
 */
router.get(
  '/:id/callsheet-preview',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const projectId = req.user!.projectId;
    const day = await getOwnShootDay(req.params.id, projectId);

    const scenes = await scenesOfDay(day.$id);
    const calls = await callsOfDay(day.$id);
    const crew = await crewOfProject(projectId);
    const project = await getDoc<Project>(COL.PROJECTS, projectId);

    const issues = validatePublish(scenes, calls, crew);

    const model = buildCallSheetModel(project, day, scenes, calls, crew);
    const pdf = await generateCallSheetPdf(model);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="callsheet-day-${day.dayNumber}-preview.pdf"`);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Publish-Issues', encodeURIComponent(JSON.stringify(issues)));
    res.send(pdf);
  }),
);

/** Shared publish validation — returns human-readable issues (empty = publishable). */
function validatePublish(
  scenes: Awaited<ReturnType<typeof scenesOfDay>>,
  calls: Awaited<ReturnType<typeof callsOfDay>>,
  crew: UserProfile[],
): string[] {
  const nameOf = new Map(crew.map((u) => [u.$id, u.name]));
  const issues: string[] = [];
  if (scenes.length === 0) issues.push('No scenes have been added to this day');
  for (const scene of scenes) {
    if (scene.actorIds.length === 0) {
      issues.push(`Scene ${scene.sceneNumber} has no actors assigned`);
    }
  }
  const calledActorIds = new Set(calls.map((c) => c.actorId));
  const dayActorIds = [...new Set(scenes.flatMap((s) => s.actorIds))];
  for (const actorId of dayActorIds) {
    if (!calledActorIds.has(actorId)) {
      issues.push(`${nameOf.get(actorId) ?? actorId} has no call time entry`);
    }
  }
  return issues;
}

/**
 * POST /shootdays/:id/publish — THE key workflow (spec §5):
 *  1. Validate: every scene has actors; every actor in scenes has an
 *     actor_call entry (else 422 with a human-readable missing list)
 *  2. Set status=published
 *  3. Generate call sheet PDF → upload to `callsheets` bucket → save fileId
 *  4. Notify ALL project crew (sound)
 */
router.post(
  '/:id/publish',
  requireRole(DIRECTION_ROLES),
  asyncHandler(async (req, res) => {
    const projectId = req.user!.projectId;
    const day = await getOwnShootDay(req.params.id, projectId);

    const scenes = await scenesOfDay(day.$id);
    const calls = await callsOfDay(day.$id);
    const crew = await crewOfProject(projectId);

    // --- 1. Validation ---
    const issues = validatePublish(scenes, calls, crew);
    if (issues.length > 0) {
      throw new AppError(422, 'Cannot publish — fix these first', { issues });
    }

    // --- 2. Publish ---
    await updateDoc<ShootDay>(COL.SHOOT_DAYS, day.$id, { status: 'published' });

    // --- 3. Call sheet PDF ---
    const project = await getDoc<Project>(COL.PROJECTS, projectId);
    const model = buildCallSheetModel(project, { ...day, status: 'published' }, scenes, calls, crew);
    const pdf = await generateCallSheetPdf(model);
    const file = await storage.createFile(
      BUCKETS.CALLSHEETS,
      ID.unique(),
      InputFile.fromBuffer(pdf, `callsheet-day-${day.dayNumber}.pdf`),
      teamReadPerms(projectId),
    );
    const updated = await updateDoc<ShootDay>(COL.SHOOT_DAYS, day.$id, {
      callSheetFileId: file.$id,
    });

    // --- 4. Notify ALL crew ---
    await notify({
      projectId,
      title: '📋 Call sheet is out',
      body: `Call sheet for Day ${day.dayNumber} (${dateLabel(day.date)}) is out — Call time ${day.generalCallTime}`,
      type: 'callsheet_published',
      deepLink: `setsync://shootday/${day.$id}`,
      sound: true,
    });

    res.json({ shootDay: updated, callSheetFileId: file.$id });
  }),
);

function buildCallSheetModel(
  project: Project,
  day: ShootDay,
  scenes: Awaited<ReturnType<typeof scenesOfDay>>,
  calls: Awaited<ReturnType<typeof callsOfDay>>,
  crew: UserProfile[],
): CallSheetModel {
  const nameOf = new Map(crew.map((u) => [u.$id, u.name]));
  const sceneNumberOf = new Map(scenes.map((s) => [s.$id, s.sceneNumber]));

  return {
    projectTitle: project.title,
    productionHouse: project.productionHouse || '',
    dayNumber: day.dayNumber,
    dateLabel: dateLabel(day.date),
    generalCallTime: day.generalCallTime,
    locationName: day.locationName,
    locationMapUrl: day.locationMapUrl,
    generalNotes: day.generalNotes,
    scenes: scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      intExt: s.intExt,
      dayNight: s.dayNight,
      locationName: s.locationName,
      synopsis: s.synopsis || '',
      castNames: s.actorIds.map((id) => nameOf.get(id) ?? '?').join(', '),
    })),
    actorCalls: calls.map((c) => ({
      actorName: nameOf.get(c.actorId) ?? c.actorId,
      pickupTime: c.pickupTime || '—',
      callTime: c.callTime || '—',
      makeupTime: c.makeupTime || '—',
      hairTime: c.hairTime || '—',
      onSetTime: c.onSetTime || '—',
      scenes: c.sceneIds.map((id) => sceneNumberOf.get(id) ?? '?').join(', '),
    })),
    emergencyContacts: crew
      .filter((u) => DIRECTION_ROLES.includes(u.role) && u.active)
      .slice(0, 4)
      .map((u) => ({ name: u.name, role: u.role.replace(/_/g, ' '), phone: u.phone })),
  };
}

export default router;
