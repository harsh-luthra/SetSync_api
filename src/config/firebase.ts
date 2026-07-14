import fs from 'node:fs';
import admin from 'firebase-admin';
import { env } from './env';
import { logger } from './logger';

let messagingInstance: admin.messaging.Messaging | null = null;

function init(): void {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    logger.warn('FCM_SERVICE_ACCOUNT_JSON not set — push notifications disabled (in-app notifications still work)');
    return;
  }
  try {
    const json = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    messagingInstance = admin.messaging();
    logger.info('Firebase Admin initialized — FCM push enabled');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Firebase Admin — push notifications disabled');
  }
}

init();

/** Returns FCM messaging, or null when push is not configured. */
export function getMessaging(): admin.messaging.Messaging | null {
  return messagingInstance;
}
