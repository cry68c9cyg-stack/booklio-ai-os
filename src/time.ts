/** Local-time helpers. Business dates are plain YYYY-MM-DD strings in the venue's time zone. */

export type LocalTime = {date: string; hour: number; minute: number};

// One formatter per time zone: building one is slow, and a briefing reads thousands of times.
const formats = new Map<string, Intl.DateTimeFormat>();

export function localTime(at: Date, timeZone: string): LocalTime {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    formats.set(timeZone, format);
  }
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

/** The moment `days` days before `at` at the same local clock time (across a change of summer time too). */
export function sameClockDaysBefore(at: Date, days: number, timeZone: string): number {
  const offset = (ms: number) => { const local = localTime(new Date(ms), timeZone); return Date.parse(`${local.date}T${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:00Z`) - Math.floor(ms / 60000) * 60000; };
  const guess = at.getTime() - days * 86400000;
  return guess + offset(at.getTime()) - offset(guess);
}

/** The instant (ISO) local midnight starts `date` in `timeZone`. */
export function zonedMidnight(date: string, timeZone: string): string {
  const noon = new Date(date + 'T12:00:00Z'), local = localTime(noon, timeZone);
  const offsetMinutes = (local.date === date ? 0 : local.date > date ? 1440 : -1440) + local.hour * 60 + local.minute - 720;
  return new Date(Date.parse(date + 'T00:00:00Z') - offsetMinutes * 60000).toISOString();
}
