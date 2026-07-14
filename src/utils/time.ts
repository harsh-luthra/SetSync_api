import { APP_TIMEZONE } from '../config/env';

const IST_OFFSET = '+05:30'; // Asia/Kolkata has no DST

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date (YYYY-MM-DD) in project timezone (IST). */
export function ymdInTz(date: Date = new Date()): string {
  return ymdFormatter.format(date);
}

/**
 * UTC ISO window [start, end) covering the IST calendar day `offsetDays`
 * from today (0 = today, 1 = tomorrow, -1 = yesterday).
 */
export function dayWindowUtc(offsetDays = 0): { ymd: string; startIso: string; endIso: string } {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000);
  const ymd = ymdInTz(shifted);
  const start = new Date(`${ymd}T00:00:00.000${IST_OFFSET}`);
  const end = new Date(start.getTime() + 86_400_000);
  return { ymd, startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Human date label, e.g. "Tuesday, 14 July 2026" (IST). */
export function dateLabel(dateIso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: APP_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(dateIso));
}
