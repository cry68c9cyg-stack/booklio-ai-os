/** Local-time helpers. Business dates are plain YYYY-MM-DD strings in the venue's time zone. */

export type LocalTime = {date: string; hour: number; minute: number};

export function localTime(at: Date, timeZone: string): LocalTime {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute)};
}

export function addDays(date: string, days: number): string {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(date + 'T12:00:00Z').getUTCDay();
}

/** The business day that is running at `at`; it starts at `cutoffHour` local time. */
export function businessDate(at: Date, timeZone: string, cutoffHour: number): string {
  const local = localTime(at, timeZone);
  return local.hour < cutoffHour ? addDays(local.date, -1) : local.date;
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
