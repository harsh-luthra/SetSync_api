import { Query } from 'node-appwrite';
import { getMessaging } from '../config/firebase';
import { logger } from '../config/logger';
import type { NotificationDoc, Role, UserProfile } from '../types';
import { ALL_ROLES } from '../types';
import { COL, createDoc, listAllDocs } from './appwrite.service';

export interface NotifyInput {
  projectId: string;
  targetRoles?: Role[];
  targetUserIds?: string[];
  title: string;
  body: string;
  type: string;
  deepLink: string;
  sound?: boolean;
}

/**
 * Fan-out per spec §6:
 *  1. Create a `notifications` document (Flutter realtime → in-app bell)
 *  2. Resolve FCM tokens of matching users
 *  3. Send FCM multicast; sound=false → data-only/silent priority
 *
 * When neither targetRoles nor targetUserIds is given, ALL project crew
 * are targeted.
 */
export async function notify(input: NotifyInput): Promise<NotificationDoc> {
  const { projectId, title, body, type, deepLink, sound = false } = input;
  let targetRoles = input.targetRoles ?? [];
  const targetUserIds = input.targetUserIds ?? [];

  if (targetRoles.length === 0 && targetUserIds.length === 0) {
    targetRoles = [...ALL_ROLES];
  }

  const doc = await createDoc<NotificationDoc>(
    COL.NOTIFICATIONS,
    { projectId, targetRoles, targetUserIds, title, body, type, deepLink, readBy: [] },
    projectId,
  );

  // Resolve matching users → FCM tokens
  const crew = await listAllDocs<UserProfile>(COL.USERS, [
    Query.equal('projectId', projectId),
    Query.equal('active', true),
  ]);
  const targets = crew.filter(
    (u) => targetRoles.includes(u.role) || targetUserIds.includes(u.$id),
  );
  const tokens = [...new Set(targets.map((u) => u.fcmToken).filter((t): t is string => !!t))];

  await sendPush(tokens, { title, body, type, deepLink, notificationId: doc.$id }, sound);
  return doc;
}

async function sendPush(
  tokens: string[],
  data: { title: string; body: string; type: string; deepLink: string; notificationId: string },
  sound: boolean,
): Promise<void> {
  const messaging = getMessaging();
  if (!messaging || tokens.length === 0) return;

  // FCM multicast max 500 tokens per call
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

  for (const chunk of chunks) {
    try {
      const message = sound
        ? {
            tokens: chunk,
            notification: { title: data.title, body: data.body },
            data: { ...data },
            android: {
              priority: 'high' as const,
              notification: { sound: 'default' },
            },
            apns: { payload: { aps: { sound: 'default' } } },
          }
        : {
            // silent / data-only — Flutter shows it in the in-app feed
            tokens: chunk,
            data: { ...data },
            android: { priority: 'high' as const },
            apns: {
              payload: { aps: { 'content-available': 1 } },
              headers: { 'apns-priority': '5' },
            },
          };
      const res = await messaging.sendEachForMulticast(message);
      if (res.failureCount > 0) {
        logger.warn({ failureCount: res.failureCount, total: chunk.length }, 'Some FCM sends failed');
      }
    } catch (err) {
      logger.error({ err }, 'FCM multicast failed');
    }
  }
}
