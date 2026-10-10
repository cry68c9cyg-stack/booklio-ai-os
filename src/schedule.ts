import {addDays, businessDate, localTime} from './time.ts';

export type Decision = 'wait' | 'send' | 'send-incomplete' | 'skip';

/**
 * Morning briefing rule agreed with the venue owner (10. 10. 2026):
 * first attempt at the first send hour (7:00); if the report is not in yet, try again at the
 * next send hour (8:00); at the last send hour (9:00) send anyway, marked as incomplete.
 * Nothing is sent outside the send hours, and a briefing already sent for the day is never sent twice.
 */
export function briefingDecision(input: {localHour: number; sendHours: number[]; alreadySent: boolean; ready: boolean}): Decision {
  if (input.alreadySent) return 'skip';
  const first = Math.min(...input.sendHours), last = Math.max(...input.sendHours);
  if (input.localHour < first) return 'wait';
  if (input.localHour > last) return 'skip';
  if (input.ready) return 'send';
  return input.localHour >= last ? 'send-incomplete' : 'wait';
}

/** The business day the morning briefing reports on: the one that ended at the cutoff this morning. */
export function reportDate(at: Date, timeZone: string, cutoffHour: number): string {
  return addDays(businessDate(at, timeZone, cutoffHour), -1);
}

export function localHour(at: Date, timeZone: string): number {
  return localTime(at, timeZone).hour;
}
