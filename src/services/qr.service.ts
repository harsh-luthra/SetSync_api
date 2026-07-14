import crypto from 'node:crypto';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';

const WINDOW_MS = 60_000; // token rotates every 60s
const GRACE_MS = 90_000; // ±90s acceptance grace

function hmac(projectId: string, shootDayId: string, timeWindow: number): string {
  return crypto
    .createHmac('sha256', env.QR_HMAC_SECRET)
    .update(`${projectId}|${shootDayId}|${timeWindow}`)
    .digest('hex');
}

export interface QrToken {
  token: string;
  expiresAt: string;
}

/** Issue the rotating attendance token for the current 60s window. */
export function issueToken(projectId: string, shootDayId: string): QrToken {
  const timeWindow = Math.floor(Date.now() / WINDOW_MS);
  const sig = hmac(projectId, shootDayId, timeWindow);
  const payload = `${projectId}.${shootDayId}.${timeWindow}.${sig}`;
  return {
    token: Buffer.from(payload, 'utf8').toString('base64url'),
    expiresAt: new Date((timeWindow + 1) * WINDOW_MS + GRACE_MS).toISOString(),
  };
}

export interface VerifiedQr {
  projectId: string;
  shootDayId: string;
}

/** Verify HMAC + time window (±90s grace). Throws 400/401 AppError on failure. */
export function verifyToken(token: string): VerifiedQr {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new AppError(400, 'Malformed QR token');
  }
  const parts = decoded.split('.');
  if (parts.length !== 4) throw new AppError(400, 'Malformed QR token');
  const [projectId, shootDayId, windowStr, sig] = parts;
  const timeWindow = Number(windowStr);
  if (!Number.isInteger(timeWindow)) throw new AppError(400, 'Malformed QR token');

  const expected = hmac(projectId, shootDayId, timeWindow);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError(401, 'Invalid QR token');
  }

  const windowStart = timeWindow * WINDOW_MS;
  const windowEnd = windowStart + WINDOW_MS;
  const now = Date.now();
  if (now < windowStart - GRACE_MS || now > windowEnd + GRACE_MS) {
    throw new AppError(401, 'QR token expired — scan the current code');
  }

  return { projectId, shootDayId };
}
