/**
 * Minimal in-memory per-key rate limiter (single-instance MVP).
 * Returns the remaining wait in ms, or 0 when the action is allowed
 * (in which case the key is stamped).
 */
const lastHit = new Map<string, number>();

export function hitRateLimit(key: string, intervalMs: number): number {
  const now = Date.now();
  const prev = lastHit.get(key);
  if (prev !== undefined && now - prev < intervalMs) {
    return intervalMs - (now - prev);
  }
  lastHit.set(key, now);
  // opportunistic pruning so the map does not grow unbounded
  if (lastHit.size > 10_000) {
    for (const [k, ts] of lastHit) {
      if (now - ts > 3_600_000) lastHit.delete(k);
    }
  }
  return 0;
}
