import { Query } from 'node-appwrite';
import { AppError } from '../middleware/errorHandler';
import type {
  ActorCall,
  Costume,
  Prop,
  RequestUser,
  Scene,
  ShootDay,
  UserProfile,
} from '../types';
import { DIRECTION_ROLES } from '../types';
import { dayWindowUtc } from '../utils/time';
import { COL, listAllDocs, listDocs } from './appwrite.service';

/** Find the project's shoot day for today (offset 0) or tomorrow (offset 1). */
export async function findShootDay(projectId: string, offsetDays: 0 | 1 | -1): Promise<ShootDay | null> {
  const { startIso, endIso } = dayWindowUtc(offsetDays);
  const res = await listDocs<ShootDay>(COL.SHOOT_DAYS, [
    Query.equal('projectId', projectId),
    Query.greaterThanEqual('date', startIso),
    Query.lessThan('date', endIso),
    Query.limit(1),
  ]);
  return res.documents[0] ?? null;
}

export async function scenesOfDay(shootDayId: string): Promise<Scene[]> {
  const scenes = await listAllDocs<Scene>(COL.SCENES, [Query.equal('shootDayId', shootDayId)]);
  return scenes.sort((a, b) => a.order - b.order);
}

export async function callsOfDay(shootDayId: string): Promise<ActorCall[]> {
  return listAllDocs<ActorCall>(COL.ACTOR_CALLS, [Query.equal('shootDayId', shootDayId)]);
}

export async function costumesForScenes(projectId: string, sceneIds: string[]): Promise<Costume[]> {
  if (sceneIds.length === 0) return [];
  return listAllDocs<Costume>(COL.COSTUMES, [
    Query.equal('projectId', projectId),
    Query.contains('sceneIds', sceneIds),
  ]);
}

export async function propsForScenes(projectId: string, sceneIds: string[]): Promise<Prop[]> {
  if (sceneIds.length === 0) return [];
  return listAllDocs<Prop>(COL.PROPS, [
    Query.equal('projectId', projectId),
    Query.contains('sceneIds', sceneIds),
  ]);
}

export async function crewOfProject(projectId: string): Promise<UserProfile[]> {
  return listAllDocs<UserProfile>(COL.USERS, [Query.equal('projectId', projectId)]);
}

/**
 * Role-shaped shoot-day payload (spec §5 GET /shootdays/today|tomorrow):
 * - direction roles: full picture (all scenes, all actor calls)
 * - actor: only own call + own scenes (+ own costumes)
 * - costume: costume-relevant slice
 * - art: props-relevant slice
 * Draft days are only visible to direction roles.
 */
export async function shapeDayForRole(user: RequestUser, day: ShootDay | null): Promise<unknown> {
  const isDirection = DIRECTION_ROLES.includes(user.role);

  if (!day || (!isDirection && day.status === 'draft')) {
    throw new AppError(404, 'No published shoot day found');
  }

  const scenes = await scenesOfDay(day.$id);
  const sceneIds = scenes.map((s) => s.$id);

  if (isDirection) {
    const calls = await callsOfDay(day.$id);
    return { shootDay: day, scenes, actorCalls: calls };
  }

  if (user.role === 'actor') {
    const myScenes = scenes.filter((s) => s.actorIds.includes(user.userId));
    const calls = await callsOfDay(day.$id);
    const myCall = calls.find((c) => c.actorId === user.userId) ?? null;
    const myCostumes = (await costumesForScenes(user.projectId, sceneIds)).filter(
      (c) => c.actorId === user.userId,
    );
    return { shootDay: day, call: myCall, scenes: myScenes, costumes: myCostumes };
  }

  if (user.role === 'costume') {
    const costumes = await costumesForScenes(user.projectId, sceneIds);
    return { shootDay: day, scenes, costumes };
  }

  // art
  const props = await propsForScenes(user.projectId, sceneIds);
  return { shootDay: day, scenes, props };
}
