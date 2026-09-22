import { Shop } from '@/types/printos';

export const DEFAULT_SHOP_TIMEZONE = 'Asia/Kolkata';

/**
 * Returns the configured shop timezone or falls back to product default (Asia/Kolkata)
 */
export function getShopTimezone(shop?: Shop | { timezone?: string | null } | null): string {
  return shop?.timezone?.trim() || DEFAULT_SHOP_TIMEZONE;
}

/**
 * Checks if a given timestamp falls on the same calendar day as the reference date
 * in the specified timezone (default: Asia/Kolkata).
 */
export function isSameDayInTimezone(
  date: string | number | Date | null | undefined,
  referenceDate: Date = new Date(),
  timezone: string = DEFAULT_SHOP_TIMEZONE
): boolean {
  if (!date) return false;
  const d = new Date(date);
  if (isNaN(d.getTime())) return false;

  const tz = timezone || DEFAULT_SHOP_TIMEZONE;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return formatter.format(d) === formatter.format(referenceDate);
}

/**
 * Helper to compute the exact UTC Date corresponding to 00:00:00 local time in a given timezone
 */
function getZonedMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  let utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  // Iteratively converge to target timezone midnight
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs));

    const y = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
    const m = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
    const d = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
    let h = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
    if (h === 24) h = 0;
    const min = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
    const s = parseInt(parts.find((p) => p.type === 'second')!.value, 10);

    const targetMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const currentMs = Date.UTC(y, m - 1, d, h, min, s, 0);
    const diff = targetMs - currentMs;
    if (diff === 0) break;
    utcMs += diff;
  }

  return new Date(utcMs);
}

/**
 * Computes the UTC start and end ISO timestamps for "Today" in the specified shop timezone.
 * Suitable for Supabase / SQL range queries (e.g. created_at >= startIso AND created_at < endIso).
 */
export function getTodayTimeRangeUtc(
  timezone: string = DEFAULT_SHOP_TIMEZONE,
  referenceDate: Date = new Date()
): { startIso: string; endIso: string } {
  const tz = timezone || DEFAULT_SHOP_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);

  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);

  const startUtc = getZonedMidnightUtc(year, month, day, tz);

  // Compute start of next calendar day in the target timezone
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const nextParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(nextDate);

  const nextYear = parseInt(nextParts.find((p) => p.type === 'year')!.value, 10);
  const nextMonth = parseInt(nextParts.find((p) => p.type === 'month')!.value, 10);
  const nextDay = parseInt(nextParts.find((p) => p.type === 'day')!.value, 10);

  const endUtc = getZonedMidnightUtc(nextYear, nextMonth, nextDay, tz);

  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
  };
}
