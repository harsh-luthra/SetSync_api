import { ID, Permission, Query, Role as AwRole } from 'node-appwrite';
import { databases, DB_ID } from '../config/appwrite';

/** Collection IDs (created by scripts/provision.ts). */
export const COL = {
  USERS: 'users',
  PROJECTS: 'projects',
  SHOOT_DAYS: 'shoot_days',
  SCENES: 'scenes',
  ACTOR_CALLS: 'actor_calls',
  COSTUMES: 'costumes',
  PROPS: 'props',
  WALKIE_EVENTS: 'walkie_events',
  ATTENDANCE: 'attendance',
  PRINT_REQUESTS: 'print_requests',
  NOTIFICATIONS: 'notifications',
  DPR: 'dpr',
} as const;

export type CollectionId = (typeof COL)[keyof typeof COL];

export const teamIdFor = (projectId: string): string => `team_${projectId}`;

/**
 * Per-document permission: team members can READ. No client write
 * permissions anywhere — all writes go through this server's API key.
 */
export const teamReadPerms = (projectId: string): string[] => [
  Permission.read(AwRole.team(teamIdFor(projectId))),
];

export async function createDoc<T>(
  collection: CollectionId,
  data: Record<string, unknown>,
  projectId?: string,
  id: string = ID.unique(),
): Promise<T> {
  const perms = projectId ? teamReadPerms(projectId) : undefined;
  return (await databases.createDocument(DB_ID, collection, id, data, perms)) as T;
}

export async function getDoc<T>(collection: CollectionId, id: string): Promise<T> {
  return (await databases.getDocument(DB_ID, collection, id)) as T;
}

export async function updateDoc<T>(
  collection: CollectionId,
  id: string,
  data: Record<string, unknown>,
): Promise<T> {
  return (await databases.updateDocument(DB_ID, collection, id, data)) as T;
}

export async function deleteDoc(collection: CollectionId, id: string): Promise<void> {
  await databases.deleteDocument(DB_ID, collection, id);
}

export async function listDocs<T>(
  collection: CollectionId,
  queries: string[] = [],
): Promise<{ total: number; documents: T[] }> {
  const res = await databases.listDocuments(DB_ID, collection, queries);
  return { total: res.total, documents: res.documents as T[] };
}

/** Paginates through all matching documents (100 per page). */
export async function listAllDocs<T extends { $id: string }>(
  collection: CollectionId,
  queries: string[] = [],
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = [...queries, Query.limit(100)];
    if (cursor) page.push(Query.cursorAfter(cursor));
    const res = await databases.listDocuments(DB_ID, collection, page);
    const docs = res.documents as unknown as T[];
    all.push(...docs);
    if (docs.length < 100) break;
    cursor = docs[docs.length - 1].$id;
  }
  return all;
}
