/**
 * Batch „Pondělní zpráva v kostce“ (MC „jo“ 18. 10. 2026): the morning message grew past what an SMS (612 characters) and the
 * WhatsApp template (1 024) carry, so its end was cut off. A message that fits still goes out whole; a longer one as a digest: the day and its revenue, on Monday
 * the week's money in one line, then the warnings (most important first, as many as fit), and the link to the dashboard,
 * where the whole message and the to-do list are. The whole message is still stored and readable through Claude.
 */
import type {Briefing} from './briefing.ts';
import type {TodoItem} from './todo.ts';
import {weekday} from './time.ts';
import {weekResultFigures, renderWeekResult} from './weekresult.ts';
import {dayNightFigures, renderDayNight} from './dayparts.ts';
import {purchaseShares} from './purchaseshare.ts';

/** Kept under the SMS limit with room for the link, after the text is folded to ASCII. */
export const DIGEST_CHARS = 600;
const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const cut = (line: string, chars: number) => line.length > chars ? line.slice(0, chars - 1).trimEnd() + '…' : line;

/** Monday: "Týden: výsledek 400 000 Kč (obvykle 500 000 Kč) · po výplatách den 200 000 Kč, noc 1 000 000 Kč · jídlo 12 %, nápoje 15 % tržby · vklad JD asi 210 000 Kč" */
export function weekMoneyLine(briefing: Briefing): string | null {
  if (weekday(briefing.businessDate) !== 0) return null;
  const parts: string[] = [];
  if (briefing.weekResult && renderWeekResult(briefing.weekResult).length) {
    const figures = weekResultFigures(briefing.weekResult);
    parts.push(`výsledek ${kc(figures.resultCents)}${figures.beforeCents !== null ? ` (obvykle ${kc(figures.beforeCents)})` : ''}`);
  }
  if (briefing.dayNight && renderDayNight(briefing.dayNight).length) {
    const figures = dayNightFigures(briefing.dayNight);
    parts.push(`po výplatách den ${kc(figures.day.leftCents)}, noc ${kc(figures.night.leftCents)}`);
  }
  const shares = briefing.purchaseShares && briefing.purchaseShares.weekRevenueDays >= 5 ? purchaseShares(briefing.purchaseShares).filter(row => row.cents > 0 && row.sharePermille !== null) : [];
  if (shares.length) parts.push(`${shares.map(row => `${row.name} ${percent(row.sharePermille!)}`).join(', ')} tržby`);
  if (briefing.cashForecast?.depositCents) parts.push(`vklad JD asi ${kc(briefing.cashForecast.depositCents)}`);
  return parts.length ? `Týden: ${parts.join(' · ')}` : null;
}

/**
 * The digest of the whole message `text`: header, revenue, Monday's money, warnings that fit, the link.
 * Batch „Priorita podle peněz“ (MC „jo“ 18. 10. 2026): the warnings come from `todos` (the order of "K vyřízení": a missing report first,
 * then by the money at stake), the first three numbered with who handles them; without `todos` they keep the order of the message.
 */
export function renderDigest(text: string, briefing: Briefing, link: string | null, todos?: TodoItem[]): string {
  // A message that fits goes out whole.
  if (text.length <= DIGEST_CHARS) return text;
  const lines = text.split('\n');
  const head = [lines[0]];
  const revenue = lines.find(line => line.startsWith('Tržba:'));
  if (revenue) head.push(cut(revenue, 160));
  const money = weekMoneyLine(briefing);
  if (money) head.push(cut(money, 200));
  const warnings = todos
    ? todos.filter(item => item.level === 'warn').map((item, i) => i < 3 ? `${i + 1}. ${cut(item.text, 100)}${item.owner ? ` – ${item.owner}` : ''}` : `⚠ ${item.text}`)
    : lines.slice(1).filter(line => line.startsWith('⚠'));
  const tail = link ? `Celá zpráva a K vyřízení: ${link}` : '';
  const out = [...head];
  let length = out.join('\n').length + (tail ? tail.length + 1 : 0), shown = 0;
  for (const warning of warnings) {
    const line = cut(warning, 120);
    // Room for the "+ N dalších upozornění" line if some are left out.
    if (length + line.length + 1 + (shown + 1 < warnings.length ? 30 : 0) > DIGEST_CHARS) break;
    out.push(line); length += line.length + 1; shown++;
  }
  if (shown < warnings.length) out.push(`+ ${warnings.length - shown} dalších upozornění`);
  if (!warnings.length) out.push('Bez upozornění.');
  if (tail) out.push(tail);
  return out.join('\n');
}
