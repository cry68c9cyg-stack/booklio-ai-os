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

/**
 * Each kind of sender (the website, a POS) with the newest moment any of its installations sent data; re-pairing leaves
 * the old installation behind, so only the newest counts. The website pushes every hour (silent after 3 h),
 * a POS at least once a business day (silent after 26 h). Installations that never sent anything are left out.
 */
export function sendersFrom(rows: {installation_id: string; last_seen_at: string | null}[], now: Date): {name: string; at: Date; silent: boolean}[] {
  const newest = new Map<string, Date>();
  for (const row of rows) {
    if (!row.last_seen_at) continue;
    const name = row.installation_id.startsWith('booklio-web') ? 'Web' : 'Pokladna', at = new Date(row.last_seen_at);
    if (!newest.has(name) || newest.get(name)! < at) newest.set(name, at);
  }
  return [...newest].sort(([a], [b]) => a.localeCompare(b, 'cs'))
    .map(([name, at]) => ({name, at, silent: now.getTime() - at.getTime() > (name === 'Web' ? 3 : 26) * 3_600_000}));
}
