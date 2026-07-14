import crypto from 'node:crypto';
import type { Request } from 'express';
import { env, urlSignSecret } from '../config/env';

function signature(path: string, exp: number): string {
  return crypto.createHmac('sha256', urlSignSecret).update(`${path}|${exp}`).digest('hex');
}

/** Build an HMAC-signed URL for `path` valid for `ttlSeconds`. */
export function signPath(req: Request, path: string, ttlSeconds: number): { url: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signature(path, exp);
  const base = env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return {
    url: `${base}${path}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Verify exp/sig query params for `path`. */
export function verifySignedPath(path: string, exp: string | undefined, sig: string | undefined): boolean {
  const expNum = Number(exp);
  if (!expNum || !sig || expNum * 1000 < Date.now()) return false;
  const expected = signature(path, expNum);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(sig), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
