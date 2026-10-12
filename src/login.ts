/**
 * Clock of the login by SMS code (dashboard and connecting Claude to MCP): a code lives 10 minutes, the next one for
 * the same number at the earliest 60 seconds after the last one, at most 5 an hour and 10 a day; 10 wrong codes an
 * hour close the venue's login for the rest of the hour.
 */
export const CODE_MS = 600000, RESEND_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000;
export const CODES_PER_HOUR = 5, CODES_PER_DAY = 10, WRONG_PER_HOUR = 10;
export type Wait = {error: 'TOO_SOON' | 'TOO_MANY'; until: number};

/**
 * When the next login code may go out after earlier ones at `times` (sorted, the last 24 hours): 60 s after the last
 * one, no more than 5 an hour and 10 a day. Null = now. A limit wins over the 60 seconds (TOO_MANY).
 */
export function nextCode(times: number[], now: number): Wait | null {
  const waits: Wait[] = [];
  const last = times.at(-1);
  if (last !== undefined && now - last < RESEND_MS) waits.push({error: 'TOO_SOON', until: last + RESEND_MS});
  const hour = times.filter(at => at >= now - HOUR_MS);
  if (hour.length >= CODES_PER_HOUR) waits.push({error: 'TOO_MANY', until: hour[hour.length - CODES_PER_HOUR] + HOUR_MS});
  const day = times.filter(at => at >= now - DAY_MS);
  if (day.length >= CODES_PER_DAY) waits.push({error: 'TOO_MANY', until: day[day.length - CODES_PER_DAY] + DAY_MS});
  if (!waits.length) return null;
  return {error: waits.some(wait => wait.error === 'TOO_MANY') ? 'TOO_MANY' : 'TOO_SOON', until: Math.max(...waits.map(wait => wait.until))};
}

/** Whole seconds until a moment, never negative (what the forms count down). */
export const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
