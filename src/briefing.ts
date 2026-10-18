import {DEFAULT_BOTTLE_LOSS_CENTS, type Bill, type BottleCheck, type CashClosing, type Reservation, type ReviewSummary, type TenantConfig, type WebMenuInterest, type WebTraffic} from './validate.ts';
import {addDays, localTime, weekday} from './time.ts';
import {line, total, type DailyReport} from './daily-report.ts';
import type {NotePoint, NotesAnalysis} from './notes.ts';
import {weatherText, type WeatherDay} from './weather.ts';
import type {TableCheck} from './checks.ts';
import {renderThemes, THEMES, type DjRank, type ThemeSummary} from './themes.ts';
import {cashNeedText, payoutAlarmText, renderNights, renderTill, type CashNeed, type NightSummary, type PayoutAlarm, type Till} from './cash.ts';
import {cashDiffRepeatText, renderVoidWeek, voidAndDiffText, voidMonthText, type VoidAndDiff, type VoidSum} from './voids.ts';
import {promoMonthText, promoStreakText, renderPromoWeek, type PromoStreak, type PromoSum, type PromoWeek} from './promo.ts';
import {nightShareText, renderNightShares, renderStaffGaps, renderWageDay, staffGapToday, wageSumText, type NightShare, type StaffGaps, type WageDay, type WageSum} from './wages.ts';
import {renderForeignWeek, renderIncidents, staffMealsText, type ForeignWeek, type Incident, type StaffMeals} from './incidents.ts';
import {gapsText, hasGaps, shiftSignals, shiftText, type DataGaps, type MonthTarget} from './goals.ts';
import {renderSupplies, type SupplyBrief} from './supplies.ts';
import {renderMail, type MailBrief} from './mail-insights.ts';
import {pricesOfText, type CompetitorRow, type CompetitorSection, type MenuGap, type PriceExperiment, type PriceFinding, type PriceMismatch} from './menu.ts';

export type Briefing = {
  businessDate: string;
  revenueCents: number;
  bills: number;
  guests: number;
  averageBillCents: number | null;
  bySection: {section: string; label: string; revenueCents: number; bills: number}[];
  payments: {method: string; amountCents: number}[];
  discountsCents: number;
  cancelledBills: number;
  voids: {count: number; amountCents: number; afterPaymentCount: number; afterPaymentCents: number};
  cash: {registerId: string; differenceCents: number}[];
  missingClosings: string[];
  plan: {revenueCents: number; days: number} | null;
  topItems: {name: string; quantity: number; revenueCents: number}[];
  /** Morning bottle check: only meaningful losses, largest in CZK first. `null` = no check for this day. */
  bottles: {countedAt: string; checked: number; minLossCents: number; lossCents: number; losses: BottleLoss[]} | null;
  bottleCheckMissing: boolean;
  /** Where the revenue comes from: POS bills, the managers' daily report (interim), or nothing yet. */
  source: 'pos' | 'report' | 'none';
  /** Figures only the managers' report has today: cash expenses, cash payouts, safe, discount detail. */
  report: {expensesCents: number; payoutsCents: number; safeCents: number | null; cashDifferenceCents: number | null; discounts: {label: string; count: number | null; amountCents: number}[];
    /** Sections whose revenue in the daily report differs from the cash book's (both written by the managers). */
    journalMismatches: {section: string; label: string; reportCents: number; journalCents: number}[];
    /** Payment methods (cash, cards, customer cards) whose amount in the daily report differs from the cash book's. */
    paymentMismatches: {section: string; label: string; reportCents: number; journalCents: number}[]} | null;
  /** "Report dne": points from the analysis, or the raw text while it is not analysed. */
  notes: {points: NotePoint[]; summary: string | null; raw: string | null} | null;
  /** Bookings of the reported day and of the day that is starting. `null` = the reservation system sent nothing for either day. */
  reservations: {
    day: {confirmed: number; guests: number; arrived: number; noShows: number; noShowGuests: number; cancelled: number};
    today: {confirmed: number; guests: number; pending: number; bySection: {section: string; label: string; confirmed: number; guests: number}[];
      /** Confirmed guests by the local hour they come (only hours with guests), for the staff plan. */
      byHour: {hour: number; guests: number}[];
      /** Confirmed bookings of `GROUP_MIN_GUESTS` and more: when, where, how many (no names). */
      groups: {time: string; label: string; partySize: number}[]};
  } | null;
  /** Bookings for the next 7 days (from tomorrow) still waiting for the staff to confirm them. */
  pendingAhead: {count: number; guests: number; first: {date: string; time: string}} | null;
  /** Public events of the venue on the day that is starting (from the website): time, place, name and confirmed guests booked there that day. */
  events: {time: string; label: string; title: string; guests: number}[];
  /** Guests to expect from bookings over the 7 days from the starting one, by part of the day; `null` = not for this day or no bookings yet. */
  guestOutlook: GuestOutlook | null;
  /** The website on the reported calendar day, against the same weekday a week before. `null` = the website sent nothing. */
  web: {visits: number; withAction: number; lastWeekVisits: number | null; reservationsSent: number; reviewScans: number; topOrigins: {name: string; visits: number}[];
    /** Visits that opened the menu that day (`menu` of the web traffic); missing in briefings stored before 14. 10. 2026, `null` = not sent. */
    menuVisits?: number | null} | null;
  /** The website far below its usual day (same weekday, 4 weeks): too few visits or no booking form sent. `null` = fine or unknown. */
  webDrop: {visits: number; usualVisits: number; sent: number; usualSent: number; lowVisits: boolean; noSent: boolean;
    /** Visits that opened the menu far below the usual while the website itself is not (the menu or its link may be broken). */
    lowMenu?: {visits: number; usualVisits: number}} | null;
  /** Events of half a year ranked (for weak days and the message about a month's last day); `null` = not asked for. */
  eventRanking: EventRank[] | null;
  /** Changes of the menu over the week (Monday message); `null` = not asked for. */
  menuWeek: MenuWeek | null;
  /** Changes of the menu on the reported day (every message but Monday's, which has the week); a briefing stored before has none. */
  menuDay?: MenuWeek | null;
  /** The menu over the month, in the message about its last day; a briefing stored before has none. */
  menuMonth?: MenuMonth | null;
  /** Menu items that barely sold over the month (message about its last day); `null` = not asked for or too few days of bills. */
  slowSellers?: SlowSellers | null;
  /** Price changes evaluated after 28 days in the week (Monday message). */
  priceResults?: PriceExperiment[];
  /** A held menu or refused menu batches (src/worker.ts `menuProblems`); a briefing stored before has none. */
  menuProblems?: string[];
  /** Products the POS charged that day at a price the menu did not have (src/menu.ts); a briefing stored before has none. */
  priceMismatches?: PriceMismatch[];
  /** Prices of the menu to look at (Monday message); `null` = not asked for. */
  priceCheck?: {total: number; top: PriceFinding[]} | null;
  /** Monday: what to fix in the menu on the website (`menuGaps`), by kind with the first names. */
  menuGaps?: {total: number; kinds: {kind: MenuGap['kind']; count: number; names: string[]}[]} | null;
  /** Monday: interest in the menu on the website, the week against the one before; `null` = not asked for. */
  menuInterest?: {current: MenuInterest; previous: MenuInterest} | null;
  /** Monday: the 4 weeks up to the reported day, for how often visits that opened the menu sent a reservation, by the website's language. */
  menuByLanguage?: MenuInterest | null;
  /** Monday after the prices nearby were read: ours far above or below their median (src/menu.ts competitorComparison). */
  competitors?: {checkedOn: string; venues: number; compared: number; sections?: CompetitorSection[]; above: CompetitorRow[]; below: CompetitorRow[]} | null;
  /** Reviews that reached the website's admin on the reported calendar day, and how many wait there. `null` = nothing sent. */
  reviews: {newCount: number; averageTenths: number | null; low: number; bySource: {name: string; newCount: number}[]; waiting: number; forManagement: number; failed: number} | null;
  /** The 7 days up to the reported day against the 7 before: sums only. `null` = not asked for. */
  week: Week | null;
  /** The month so far (in the Monday message and on the dashboard), or the whole month on its last day. `null` = not asked for. */
  month: Month | null;
  /** The day that is starting: revenue plan and booked guests against the usual for this weekday (4 weeks before). */
  outlook: {planCents: number | null; guests: number; usualGuests: number | null};
  /** Revenue forecast from the day that is starting: tomorrow, 7 days, this month in total and the next month. `null` = not asked for. */
  forecast: Forecast | null;
  /** No-shows of the reported day against the 28 days before, in guests; per mille. `null` = too few bookings to say. */
  noShows: {guests: number; confirmedGuests: number; ratePermille: number; usualPermille: number | null} | null;
  /** Revenue of the same weekday a week before. `null` = no data for that day. */
  lastWeekRevenueCents: number | null;
  /** Discount types (staff, promo, write-offs…) far above their usual amount on this weekday. */
  unusualDiscounts: UnusualDiscount[];
  /** Sources that sent data before but have been silent too long (e.g. the website's hourly push). */
  silent: {name: string; since: string}[];
  /** What the managers' tables do not add up in (src/checks.ts); a briefing stored before has none. */
  tableChecks?: TableCheck[];
  /** Revenue of the same weekday 52 weeks before (364 days), `null` = no data; a briefing stored before has none. */
  lastYearRevenueCents?: number | null;
  /** Cash counted last night against what today usually pays out of the till, a day of unusual payouts, on Monday the nights (src/cash.ts). */
  cashNeed?: CashNeed | null;
  payoutAlarm?: PayoutAlarm | null;
  nights?: NightSummary | null;
  /** IOUs, Vklad JD and negative cash in the revenue rows of the cash book (src/cash.ts). */
  till?: Till | null;
  /** On a month's last day the incidents of the month, on Monday the foreign cash of the week (src/incidents.ts). */
  incidents?: Incident[] | null;
  foreignWeek?: ForeignWeek | null;
  /** The day's cash payouts by kind, a night whose staff took an unusual share of the club, missing staff by weekday (src/wages.ts). */
  wageDay?: WageDay | null;
  nightShare?: NightShare | null;
  staffGaps?: StaffGaps | null;
  /** Promo and write-offs by place: on Monday the week against the 4 before, every day a place over its usual 3 days in a row (src/promo.ts). */
  promoWeek?: PromoWeek | null;
  promoStreaks?: PromoStreak[];
  /** Voids and cash differences: on Monday the week, every day a repeated cash difference and voids with a cash difference (src/voids.ts). */
  voidWeek?: {week: VoidSum; before: VoidSum} | null;
  cashDiffRepeat?: {date: string; cents: number}[] | null;
  voidAndDiff?: VoidAndDiff | null;
  /** The target of the month the starting day is in (src/goals.ts). */
  target?: MonthTarget | null;
  /** Days of the 14 before without revenue or with the cash book only; only for this morning's message. */
  dataGaps?: DataGaps | null;
  /** Topics of the day's "Report dne" text (src/themes.ts) and, on Monday, how often each came up over 4 weeks. */
  noteThemes?: string[];
  themes?: ThemeSummary | null;
  /** Monday: club revenue by the DJ of the night over 12 weeks. */
  djRanking?: DjRank[] | null;
  /** Posted costs from accounting (iÚčto) against OKO1's revenue: this month so far, and the month before in its first half. */
  costs: MonthResult | null;
  costsPrevious: MonthResult | null;
  /** Supplier invoices (Dishboard, later Pexeso): the month so far with food cost, price rises of the week, overdue invoices. `null` = none. */
  supplies: SupplyBrief | null;
  /** The venue's mailbox (info@): messages waiting for an answer, what is not under control; on Monday the week. */
  mail?: MailBrief | null;
  incomplete: boolean;
};
export type WeekPart = {revenueCents: number; revenueDays: number; reservations: number; guests: number; noShows: number; noShowGuests: number;
  /** Bookings for these days that were cancelled (by the guest or the staff); a week stored before this field has none. */
  cancelled?: number;
  /** Of these, cancelled less than 24 hours before the booking's start (time of the last change of the booking), and their guests. */
  lateCancelled?: number; lateCancelledGuests?: number;
  /** Confirmed bookings by how long before their day they were made (only those sent with `createdAt`). */
  lead?: {sameDay: number; upTo2: number; upTo7: number; more: number};
  /** Confirmed bookings and guests by where they came from (`web`, `obsluha`, `mcp`…), most first. */
  sources?: {source: string; reservations: number; guests: number; noShowGuests: number}[];
  visits: number | null; visitDays: number; webSent: number; webConfirmed: number; reviews: number; rated: number; starsTenths: number | null;
  /** Website visits by where they came from, with the visits that booked, called or navigated; most visits first. */
  origins: {key: string; name: string; visits: number; withAction: number}[]};
/** New reviews over a stretch of days: all, those with stars, and their average in tenths. */
export type ReviewStats = {reviews: number; rated: number; starsTenths: number | null};
export type MonthPart = {revenueCents: number; revenueDays: number; bySection: {section: string; label: string; revenueCents: number}[] | null};
/** Revenue of one month up to a day against the same days of the month before, and the cash the cash book paid out. */
export type Month = {
  month: string; through: string; complete: boolean; current: MonthPart; previous: MonthPart & {month: string; through: string};
  /** The same days of the month a year before; a month stored before has none. */
  lastYear?: MonthPart & {month: string; through: string};
  payouts: {label: string; amountCents: number}[]; payoutsCents: number;
  expenses: {label: string; amountCents: number}[]; expensesCents: number;
  discounts: {label: string; amountCents: number}[]; discountsCents: number;
  /** "Personál" discounts of the month; a month stored before has none. */
  staffMeals?: StaffMeals;
  wages?: WageSum;
  promo?: PromoSum;
  voids?: VoidSum;
  reviews?: ReviewStats;
};
/** Discounts by type summed over the same weekday of the previous weeks that have a managers' report (`days` of them). */
export type DiscountHistory = {days: number; totals: Record<string, number>};
export type UnusualDiscount = {key: string; label: string; amountCents: number; usualCents: number};
/** One of the next 7 days: forecast (with the bookings boost), confirmed guests against the weekday's usual, weather. */
export type ForecastDay = {date: string; cents: number | null; guests: number; usualGuests: number | null; boost: number; weather: WeatherDay | null; weatherText: string | null;
  /** Public events of the venue that day (names) and how much an event raises the day (1 = not known or no event). */
  events?: string[]; eventBoost?: number;
  /** A public holiday that day and how it usually changes the day (1 = no holiday or not known); rain that changes it (1 = none). */
  holiday?: string | null; holidayFactor?: number; rainFactor?: number;
  /** The day's forecast split by section with the shares of the same weekday over 8 weeks (at least 2 days with sections). */
  bySection?: {section: string; label: string; cents: number}[]};
/** Revenue forecast; a part is `null` when a weekday it needs has under two weeks of revenue. */
export type Forecast = {
  today: string;
  /** The day that is starting and the 6 after it. */
  days: ForecastDay[];
  /** How far the actual revenue was from the forecast made the morning before, on average over the last 28 days (at least 7 of them). */
  accuracy: {days: number; errorPermille: number} | null;
  tomorrow: {date: string; cents: number | null};
  week: {from: string; to: string; cents: number | null};
  /** The month the starting day is in: revenue so far (days with data of the elapsed ones), the forecast for the rest and elapsed days without data, both together. */
  month: {month: string; actualCents: number; actualDays: number; elapsedDays: number; restCents: number | null; totalCents: number | null};
  nextMonth: {month: string; cents: number | null};
  /** Last year's seasonality applied per month (1 = none); only months with enough data from last year. */
  seasonal: Record<string, number>;
  /** How much an event day usually makes against its weekday's average (median of past event days, at least 4); `null` = not enough of them yet. */
  eventFactor?: {factor: number; days: number} | null;
  /** How much a rainy day (at least 5 mm) usually makes against its weekday's average (median, at least 6 rainy days); `null` = not enough yet. */
  rainFactor?: {factor: number; days: number} | null;
};
export type Week = {from: string; to: string; current: WeekPart; previous: WeekPart; reviewsUsual?: ReviewStats | null; reviewDrop?: boolean;
  /** The week's events looked back on: guests booked that day (in the event's place) and revenue, against the same weekday without an event. */
  events?: EventReview[]};
export type EventReview = {date: string; title: string; guests: number; usualGuests: number | null; revenueCents: number | null; usualRevenueCents: number | null};
/**
 * Events of half a year by name: how often, on which weekdays (0 = Sunday), guests booked in their place on average, and how much the
 * guests and the day's revenue were against usual same weekdays without an event (1.5 = +50 %; `null` = nothing to compare with).
 */
export type EventRank = {title: string; count: number; weekdays: number[]; guests: number; usualGuests: number | null; guestLift: number | null; revenueLift: number | null; last: string;
  /** The guests' lift on each weekday the event ran on (for the weak-day tip). */
  byWeekday: {weekday: number; count: number; guestLift: number | null}[]};
export function rankEvents(reviews: EventReview[]): EventRank[] {
  const groups = new Map<string, EventReview[]>();
  for (const review of reviews) {
    const key = review.title.trim().toLocaleLowerCase('cs');
    groups.set(key, [...(groups.get(key) ?? []), review]);
  }
  const ratio = (pairs: [number, number][]) => {
    const base = pairs.reduce((sum, [, usual]) => sum + usual, 0);
    return pairs.length && base > 0 ? Math.round(pairs.reduce((sum, [value]) => sum + value, 0) / base * 100) / 100 : null;
  };
  const guestRatio = (list: EventReview[]) => ratio(list.filter(review => review.usualGuests).map(review => [review.guests, review.usualGuests!]));
  const average = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return [...groups.values()].map(list => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date)), latest = sorted.at(-1)!;
    const withUsual = list.filter(review => review.usualGuests);
    const weekdays = [...new Set(list.map(review => weekday(review.date)))].sort((a, b) => a - b);
    // Guests against usual over the same events, so the two numbers side by side compare like with like.
    return {title: latest.title.trim(), count: list.length, weekdays,
      guests: average((withUsual.length ? withUsual : list).map(review => review.guests)),
      usualGuests: withUsual.length ? average(withUsual.map(review => review.usualGuests!)) : null,
      guestLift: guestRatio(list),
      revenueLift: ratio(list.filter(review => review.revenueCents !== null && review.usualRevenueCents).map(review => [review.revenueCents!, review.usualRevenueCents!])),
      last: latest.date,
      byWeekday: weekdays.map(day => {
        const same = list.filter(review => weekday(review.date) === day);
        return {weekday: day, count: same.length, guestLift: guestRatio(same)};
      })};
  }).sort((a, b) => (b.guestLift ?? -1) - (a.guestLift ?? -1) || (b.revenueLift ?? -1) - (a.revenueLift ?? -1) || b.count - a.count || a.title.localeCompare(b.title));
}
const lift = (value: number) => {
  const percent = Math.round((value - 1) * 100);
  return percent === 0 ? '±0 %' : `${percent > 0 ? '+' : '−'}${Math.abs(percent)} %`;
};
const rankValue = (rank: EventRank) => rank.guestLift ?? rank.revenueLift ?? 1;
/** "Rock Night (4×, hosté +50 %, tržba +30 %)" */
const rankText = (rank: EventRank) => `${rank.title} (${[`${rank.count}×`, rank.guestLift !== null ? `hosté ${lift(rank.guestLift)}` : '', rank.revenueLift !== null ? `tržba ${lift(rank.revenueLift)}` : ''].filter(Boolean).join(', ')})`;
/** "Akce za půl roku: nejvíc táhne Rock Night (…) · Koncert (…) · nejméně Quiz (…)"; only events with something to compare (guests, else revenue). */
export function renderEventRanking(ranking: EventRank[] | null | undefined): string[] {
  const known = (ranking ?? []).filter(rank => rank.guestLift !== null || rank.revenueLift !== null);
  const top = known.filter(rank => rankValue(rank) > 1).slice(0, 3);
  const worst = known.filter(rank => rankValue(rank) < 1).sort((a, b) => rankValue(a) - rankValue(b))[0];
  if (!top.length && !worst) return [];
  return [`Akce za půl roku: ${[top.length ? `nejvíc táhne ${top.map(rankText).join(' · ')}` : 'žádná nepřivedla víc než obvyklý den', worst ? `nejméně ${rankText(worst)}` : ''].filter(Boolean).join(' · ')}`];
}
const weekdayIn = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];
/** The event that brought the most guests on the day's weekday (at least twice there, at least +10 % against usual), as a tip for a weak day. */
export function eventTip(ranking: EventRank[] | null | undefined, date: string): string {
  const day = weekday(date);
  const best = (ranking ?? []).map(rank => ({rank, there: rank.byWeekday.find(entry => entry.weekday === day)}))
    .filter(({there}) => there && there.count >= 2 && there.guestLift !== null && there.guestLift >= 1.1)
    .sort((a, b) => b.there!.guestLift! - a.there!.guestLift!)[0];
  return best ? `, ${weekdayIn[day]} nejvíc táhla akce ${best.rank.title} (hosté ${lift(best.there!.guestLift!)})` : '';
}

/** Sections of a forecast day in whole thousands of crowns that add up to the day's rounded amount; sections under 1 000 Kč left out. */
export function sectionThousands(cents: number, rows: {label: string; cents: number}[]): {label: string; cents: number}[] {
  const step = 100000, rounded = rows.map(row => ({label: row.label, cents: Math.round(row.cents / step) * step}));
  if (!rounded.length) return [];
  const largest = rounded.reduce((top, row) => row.cents > top.cents ? row : top, rounded[0]);
  largest.cents += Math.round(cents / step) * step - rounded.reduce((sum, row) => sum + row.cents, 0);
  return rounded.filter(row => row.cents > 0);
}

/** Changes of the menu over the week (Monday message): new prices, new items and removed items. */
export type MenuWeek = {prices: {name: string; oldText: string | null; newText: string | null}[]; added: string[]; removed: string[]};
/** Changes of the menu over a month (counts) and the categories whose average base price moved against the month before. */
export type MenuMonth = {month: string; up: number; down: number; added: number; removed: number;
  categories: {name: string; beforeCents: number; afterCents: number; changePermille: number}[]};
export type SlowSellers = {month: string; items: {name: string; quantity: number}[]};
export function renderSlowSellers(slow: SlowSellers | null | undefined): string[] {
  if (!slow?.items.length) return [];
  const where = MONTH_LOCATIVE[monthName(slow.month)] ?? monthName(slow.month);
  return [`Skoro neprodané ${where} (kandidáti na vyřazení z lístku): ${slow.items.slice(0, 5).map(item => `${item.name} ${String(item.quantity).replace('.', ',')}×`).join(', ')}${slow.items.length > 5 ? ` a další ${slow.items.length - 5}` : ''}`];
}
/** A price change after 28 days: pieces and revenue per day against the 28 days before, and whether the revenue rose. */
export function renderPriceResults(results: PriceExperiment[] | undefined): string[] {
  if (!results?.length) return [];
  const percent = (permille: number) => { const value = Math.sign(permille) * Math.round(Math.abs(permille) / 10); return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)} %`; };
  // A rise (the base price, or another size when the base stayed) that brings more revenue a day paid off: each piece earns
  // more than before. Less revenue may still be more profit (fewer pieces cost less food), which needs the food cost to judge.
  const sum = (text: string | null) => pricesOfText(text).reduce((total, cents) => total + cents, 0);
  const rise = (row: PriceExperiment) => { const [now, before] = [pricesOfText(row.newText)[0] ?? 0, pricesOfText(row.oldText)[0] ?? 0]; return now > before || (now === before && sum(row.newText) > sum(row.oldText)); };
  const verdict = (row: PriceExperiment) => !rise(row) ? '' : (row.revenuePermille ?? 0) >= 5 ? ' (zdražení se vyplatilo)' : (row.revenuePermille ?? 0) <= -5 ? ' (tržba klesla, vyplatilo se jen při velkém food costu)' : '';
  return [`Změny cen po 4 týdnech: ${results.slice(0, 3).map(row => `${row.name} ${row.oldText ?? '?'} → ${row.newText ?? '?'}: kusů ${percent(row.quantityPermille ?? 0)}, tržba ${percent(row.revenuePermille ?? 0)} denně${verdict(row)}`).join('; ')}${results.length > 3 ? `; další ${results.length - 3}` : ''}`];
}
export function renderMenuMonth(month: MenuMonth | null | undefined): string[] {
  if (!month) return [];
  const changes = [month.up ? `zdraženo ${month.up}` : '', month.down ? `zlevněno ${month.down}` : '', month.added ? `přidáno ${month.added}` : '', month.removed ? `zrušeno ${month.removed}` : ''].filter(Boolean);
  const [year, number] = month.month.split('-').map(Number), before = monthName(number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`);
  const percent = (permille: number) => `${permille > 0 ? '+' : '−'}${Math.round(Math.abs(permille) / 10)} %`;
  const moved = month.categories.filter(row => Math.abs(row.changePermille) >= 10);
  const averages = moved.length ? `průměrná cena proti ${MONTH_DATIVE[before] ?? before}: ${moved.slice(0, 3).map(row => `${row.name} ${percent(row.changePermille)}`).join(', ')}${moved.length > 3 ? ` a další ${moved.length - 3}` : ''}` : '';
  const parts = [changes.length ? changes.join(', ') : '', averages].filter(Boolean);
  return parts.length ? [`Lístek ${MONTH_LOCATIVE[monthName(month.month)] ?? monthName(month.month)}: ${parts.join(' · ')}`] : [];
}
const MONTH_LOCATIVE: Record<string, string> = {leden: 'v lednu', únor: 'v únoru', březen: 'v březnu', duben: 'v dubnu', květen: 'v květnu', červen: 'v červnu',
  červenec: 'v červenci', srpen: 'v srpnu', září: 'v září', říjen: 'v říjnu', listopad: 'v listopadu', prosinec: 'v prosinci'};
const MONTH_DATIVE: Record<string, string> = {leden: 'lednu', únor: 'únoru', březen: 'březnu', duben: 'dubnu', květen: 'květnu', červen: 'červnu',
  červenec: 'červenci', srpen: 'srpnu', září: 'září', říjen: 'říjnu', listopad: 'listopadu', prosinec: 'prosinci'};
/** One product charged at another price than the menu has, e.g. "Classic Burger 225 Kč (lístek 250 Kč, 4×)". */
export const mismatchText = (row: PriceMismatch) => `${row.posName} ${crowns(row.posCents)} (lístek ${row.menuText}, ${row.quantity}×)`;
export function renderPriceMismatches(rows: PriceMismatch[] | undefined): string[] {
  if (!rows?.length) return [];
  return [`⚠ Pokladna účtuje jinou cenu než lístek: ${rows.slice(0, 3).map(mismatchText).join(', ')}${rows.length > 3 ? ` a další ${rows.length - 3}` : ''}`];
}
/** Monday: how many prices of the menu are worth a look, the first two with the suggested price. */
export function renderPriceCheck(check: Briefing['priceCheck']): string[] {
  if (!check?.total) return [];
  return [`Ceny k prověření: ${check.total} (${check.top.slice(0, 2).map(row => `${row.name ?? row.category} ${row.priceText} → návrh ${crowns(row.suggestedCents)}`).join(', ')}${check.total > 2 ? ', další na dashboardu' : ''})`];
}
/** Monday: e.g. "chybí popis nebo složení 8× (Virgin Mule, Virgin Cosmopolitan …), chybí objem 1× (Džus)". */
export const menuGapsText = (gaps: NonNullable<Briefing['menuGaps']>) => gaps.kinds.map(row =>
  `${GAP_WORDS[row.kind]} ${row.count}× (${row.names.slice(0, 2).join(', ')}${row.count > 2 ? ' …' : ''})`).join(', ');
const GAP_WORDS: Record<MenuGap['kind'], string> = {price: 'rozdílná cena', description: 'chybí popis nebo složení', volume: 'chybí objem'};
export function renderMenuGaps(gaps: Briefing['menuGaps']): string[] {
  return gaps?.total ? [`Na webu opravit v lístku: ${menuGapsText(gaps)}`] : [];
}
/**
 * Interest in the menu on the website over some days: sums of the days whose web traffic carries `menu` (sent by the
 * website since 13. 10. 2026). `days` = how many days had it; one record per day (the first one, as everywhere).
 */
export type MenuInterest = {
  from: string; to: string; days: number; visits: number; abroad: number; reserved: number; food: number; drinks: number;
  languages: {key: string; visits: number; reserved: number}[];
};
export function sumMenuInterest(records: {businessDate: string; menu?: WebMenuInterest}[], from: string, to: string): MenuInterest {
  const sum: MenuInterest = {from, to, days: 0, visits: 0, abroad: 0, reserved: 0, food: 0, drinks: 0, languages: []};
  const seen = new Set<string>(), languages = new Map<string, {key: string; visits: number; reserved: number}>();
  for (const {businessDate, menu} of records) {
    if (businessDate < from || businessDate > to || seen.has(businessDate)) continue;
    seen.add(businessDate);
    if (!menu) continue;
    sum.days++; sum.visits += menu.visits; sum.abroad += menu.abroad; sum.reserved += menu.reserved; sum.food += menu.views.food; sum.drinks += menu.views.drinks;
    for (const language of menu.languages) {
      const row = languages.get(language.key) ?? {key: language.key, visits: 0, reserved: 0};
      row.visits += language.visits; row.reserved += language.reserved;
      languages.set(language.key, row);
    }
  }
  sum.languages = [...languages.values()].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key));
  return sum;
}
export const LANGUAGE_NAMES: Record<string, string> = {cs: 'česky', en: 'anglicky', de: 'německy'};
const verb = (n: number, stem: string) => stem + (n === 1 ? 'a' : n >= 2 && n <= 4 ? 'y' : 'o');
const percentOf = (part: number, whole: number) => `${Math.round(part / whole * 100)} %`;
/** The Monday line: visits that opened the menu, from abroad, the website's languages and how many sent a reservation in that visit. */
export function renderMenuInterest(interest: Briefing['menuInterest']): string[] {
  const now = interest?.current, before = interest?.previous;
  if (!now?.days || !now.visits) return [];
  const days = now.days < 7 ? ` (${now.days} ${now.days === 1 ? 'den' : now.days <= 4 ? 'dny' : 'dní'} s daty)` : '';
  const change = now.days === 7 && before?.days === 7 && before.visits ? Math.round((now.visits / before.visits - 1) * 100) : null;
  const languages = now.languages.filter(row => row.visits && row.key !== 'neznamy').slice(0, 3).map(row => `${LANGUAGE_NAMES[row.key] ?? row.key} ${percentOf(row.visits, now.visits)}`);
  const rate = (Math.round(now.reserved / now.visits * 1000) / 10).toFixed(1).replace('.', ',');
  return [`Lístek na webu za týden${days}: ${verb(now.visits, 'otevřel')} si ho ${now.visits} ${visitsWord(now.visits)}` +
    (change === null ? '' : ` (${change === 0 ? '±0' : (change > 0 ? '+' : '−') + Math.abs(change)} % proti minulému týdnu)`) +
    `, ${percentOf(now.abroad, now.visits)} ze zahraničí` + (languages.length ? `; jazyk webu ${languages.join(', ')}` : '') +
    `; z nich rezervaci ${verb(now.reserved, 'poslal')} ${now.reserved} (${rate} %)`];
}
/** Days with menu data (of the 28) the comparison by language needs, so a day the website missed does not hide it, and visits a language needs to be shown in it. */
export const MENU_LANGUAGE_DAYS = 21, MENU_LANGUAGE_MIN_VISITS = 30;
/** The Monday line once 4 weeks of data are in: how often visits that opened the menu sent a reservation, by the website's language. */
export function renderMenuByLanguage(interest: Briefing['menuByLanguage']): string[] {
  if (!interest || interest.days < MENU_LANGUAGE_DAYS) return [];
  const rows = interest.languages.filter(row => row.key !== 'neznamy' && row.visits >= MENU_LANGUAGE_MIN_VISITS);
  if (rows.length < 2) return [];
  const rate = (row: {visits: number; reserved: number}) => (Math.round(row.reserved / row.visits * 1000) / 10).toFixed(1).replace('.', ',');
  return [`Rezervace po otevření lístku za 4 týdny podle jazyka webu: ${rows.map(row => `${LANGUAGE_NAMES[row.key] ?? row.key} ${rate(row)} % (${group(row.reserved)} z ${group(row.visits)})`).join(', ')}`];
}
/** Short names of the parts of the menu in the Monday line. */
const SECTION_SHORT: Record<CompetitorSection['section'], string> = {food: 'jídlo', alcohol: 'alkohol', soft: 'nealko'};
/** How many items far from the median the Monday line names on each side; the dashboard has all of them. */
const COMPETITOR_NAMED = 3;
/**
 * The Monday line after the prices nearby were read: each part of the menu against the venues (the median of our
 * differences) and the items furthest above or below the median of at least 3 venues (from 15 %).
 */
export function renderCompetitors(competitors: Briefing['competitors']): string[] {
  if (!competitors?.compared) return [];
  const signed = (pct: number) => pct === 0 ? '±0 %' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`;
  const row = (entry: CompetitorRow) => `${entry.label} ${crowns(entry.ourCents!)} (${signed(entry.diffPct!)}, okolí ${crowns(entry.medianCents!)})`;
  const date = `${Number(competitors.checkedOn.slice(8))}. ${Number(competitors.checkedOn.slice(5, 7))}.`;
  const word = (n: number, one: string, few: string, many: string) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
  const named = (rows: CompetitorRow[]) => rows.slice(0, COMPETITOR_NAMED).map(row).join(', ') + (rows.length > COMPETITOR_NAMED ? ` a další ${rows.length - COMPETITOR_NAMED}` : '');
  const sections = (competitors.sections ?? []).filter(section => section.medianDiffPct !== null).map(section => `${SECTION_SHORT[section.section]} ${signed(section.medianDiffPct!)}`);
  const parts = [competitors.above.length ? `dráže ${named(competitors.above)}` : '', competitors.below.length ? `levněji ${named(competitors.below)}` : ''].filter(Boolean);
  return [`Ceny proti okolí (${word(competitors.compared, 'položka', 'položky', 'položek')} proti ${competitors.venues} ${competitors.venues === 1 ? 'podniku' : 'podnikům'} s cenami online, ${date}): ` +
    (sections.length ? `celkově ${sections.join(', ')}; ` : '') +
    (parts.length ? parts.join('; ') : 'všechno do ±15 % od mediánu')];
}
export function renderMenuWeek(week: MenuWeek | null | undefined, title = 'Lístek za týden'): string[] {
  if (!week || !(week.prices.length + week.added.length + week.removed.length)) return [];
  const names = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ` a další ${list.length - 3}` : '');
  const parts = [week.prices.length ? `nová cena ${week.prices.length}× (${names(week.prices.map(row => `${row.name} ${row.oldText ?? '?'} → ${row.newText ?? '?'}`))})` : '',
    week.added.length ? `nově ${names(week.added)}` : '', week.removed.length ? `zrušeno ${names(week.removed)}` : ''].filter(Boolean);
  return [`${title}: ${parts.join(' · ')}`];
}
/** Parts of the day for the shifts: day 6–17 h, evening 17–22 h, night 22–6 h (local time of the booking's start). */
export const DAY_PARTS = [{key: 'day', name: 'přes den'}, {key: 'evening', name: 'večer'}, {key: 'night', name: 'noc'}] as const;
export type DayPart = typeof DAY_PARTS[number]['key'];
export const dayPart = (hour: number): DayPart => hour >= 6 && hour < 17 ? 'day' : hour >= 17 && hour < 22 ? 'evening' : 'night';
/**
 * Confirmed guests booked now per day and part of the day, and what to expect: booked now + the usual later bookings (median over
 * the same weekday of the 8 weeks before, how many guests were booked after the same moment; at least 2 such days, else unknown).
 */
/** `usual` = guests the same weekday usually had booked by the same moment (median of the past days), for spotting a weak day early. */
export type GuestOutlookDay = {date: string; booked: number; expected: number | null; usual: number | null; weak: boolean; parts: {key: DayPart; booked: number; expected: number | null; usual?: number | null}[]};
export type GuestOutlook = {days: GuestOutlookDay[]; noShowGuests: number | null};
/** The median of whole numbers, rounded. */
export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};
/** One day of the outlook from guests booked now and past days' {final, booked by the same moment}, per part of the day. */
export function guestOutlookDay(date: string, now: Record<DayPart, number>, past: {final: Record<DayPart, number>; early: Record<DayPart, number>}[]): GuestOutlookDay {
  // Bookings cancelled after the moment count as booked then, so late cancellations can take guests away again (never below zero).
  // `usual` = guests the same weekday finally had booked in this part of the day (median), for the shifts.
  const parts = DAY_PARTS.map(({key}) => ({key, booked: now[key],
    expected: past.length >= 2 ? Math.max(0, now[key] + median(past.map(day => day.final[key] - day.early[key]))) : null,
    usual: past.length >= 2 ? median(past.map(day => day.final[key])) : null}));
  const booked = parts.reduce((sum, part) => sum + part.booked, 0);
  const total = (parts: Record<DayPart, number>) => DAY_PARTS.reduce((sum, {key}) => sum + parts[key], 0);
  const usual = past.length >= 2 ? median(past.map(day => total(day.early))) : null;
  return {date, booked, expected: past.length >= 2 ? parts.reduce((sum, part) => sum + part.expected!, 0) : null,
    usual, weak: usual !== null && usual >= WEAK_MIN_USUAL && booked <= usual * WEAK_SHARE, parts};
}

/** A day ahead is weak when its weekday usually has at least 10 guests booked by now and it has 40 % fewer or less. */
export const WEAK_MIN_USUAL = 10;
export const WEAK_SHARE = 0.6;
export function weakDays(outlook: Briefing['guestOutlook'] | undefined): GuestOutlookDay[] {
  return (outlook?.days ?? []).filter(day => day.weak);
}
/** "so 18. 10. zatím 12 hostů (obvykle touhle dobou 30, −60 %)" */
export const weakDaysText = (days: GuestOutlookDay[], ranking?: EventRank[] | null) => days.map(day =>
  `${weekdayShort[weekday(day.date)]} ${shortDate(day.date)} zatím ${day.booked} ${guestsWord(day.booked)} (obvykle touhle dobou ${day.usual}, ${change(day.booked, day.usual!).slice(2, -1)})${eventTip(ranking, day.date)}`).join(' · ');

/** The website broke down: visits under half of the usual (at least 30 usually), or no booking form sent when at least 3 usually are. */
export const WEB_DROP_MIN_VISITS = 30;
export const WEB_DROP_SHARE = 0.5;
export const WEB_DROP_MIN_SENT = 3;
export function webDrop(day: WebTraffic | undefined, usual: {visits: number; sent: number; menuVisits?: number}[] | undefined): Briefing['webDrop'] {
  if (!day || !usual || usual.length < 3) return null;
  const usualVisits = median(usual.map(row => row.visits)), usualSent = median(usual.map(row => row.sent)), sent = day.actions['rezervace-odeslana'] ?? 0;
  const lowVisits = usualVisits >= WEB_DROP_MIN_VISITS && day.visits < usualVisits * WEB_DROP_SHARE, noSent = usualSent >= WEB_DROP_MIN_SENT && sent === 0;
  // The menu is watched only on days that send it, against at least 3 usual days that sent it too; a website that dropped as a whole says it already.
  const menuDays = usual.flatMap(row => row.menuVisits === undefined ? [] : [row.menuVisits]), usualMenu = menuDays.length >= 3 ? median(menuDays) : 0;
  const lowMenu = !lowVisits && day.menu && usualMenu >= WEB_DROP_MIN_VISITS && day.menu.visits < usualMenu * WEB_DROP_SHARE ? {visits: day.menu.visits, usualVisits: usualMenu} : undefined;
  return lowVisits || noSent || lowMenu ? {visits: day.visits, usualVisits, sent, usualSent, lowVisits, noSent, ...(lowMenu ? {lowMenu} : {})} : null;
}
/** "40 návštěv (obvykle 150) a žádný odeslaný rezervační formulář (obvykle 6), zkontroluj, že web a rezervace běží" */
export const webDropText = (drop: NonNullable<Briefing['webDrop']>) =>
  [drop.lowVisits ? `${group(drop.visits)} ${visitsWord(drop.visits)} (obvykle ${group(drop.usualVisits)})` : '', drop.noSent ? `žádný odeslaný rezervační formulář (obvykle ${drop.usualSent})` : '',
    drop.lowMenu ? `lístek si ${verb(drop.lowMenu.visits, 'otevřel')} jen ${group(drop.lowMenu.visits)} ${visitsWord(drop.lowMenu.visits)} (obvykle ${group(drop.lowMenu.usualVisits)})` : '']
    .filter(Boolean).join(' a ') + ', zkontroluj, ' + [drop.lowVisits || drop.noSent ? 'že web a rezervace běží' : '', drop.lowMenu ? 'že jde lístek na webu otevřít' : ''].filter(Boolean).join(' a ');
export type MonthResult = {
  month: string; through: string; rows: {account: string; name: string; amountCents: number}[];
  revenueCents: number; revenueDays: number; error: string | null;
};
const positive = (report: DailyReport, kind: 'expense' | 'payout') => report.lines.filter(entry => entry.kind === kind && entry.amountCents > 0).reduce((sum, entry) => sum + entry.amountCents, 0);

/** The daily report and the cash book should say the same revenue per section; any difference of a crown or more is shown. */
export const JOURNAL_MISMATCH_CENTS = 100;
function journalMismatches(report: DailyReport, names: Record<string, string>, reportKind: 'revenue_section' | 'payment' = 'revenue_section',
  journalKind: 'journal_revenue' | 'journal_payment' = 'journal_revenue', only: string[] | null = null, onBothSides = false): NonNullable<Briefing['report']>['journalMismatches'] {
  const wanted = (key: string) => !only || only.includes(key);
  const journal = report.lines.filter(entry => entry.kind === journalKind && wanted(entry.key));
  if (!journal.length) return [];
  const sum = (kind: string, key: string) => report.lines.filter(entry => entry.kind === kind && entry.key === key).reduce((total, entry) => total + entry.amountCents, 0);
  const reported = report.lines.filter(entry => entry.kind === reportKind && wanted(entry.key)).map(entry => entry.key);
  // Payments: a method only one of the two files has a row for (the report has no customer cards row) is not compared.
  const keys = onBothSides ? [...new Set(reported)].filter(key => journal.some(entry => entry.key === key)) : [...new Set([...reported, ...journal.map(entry => entry.key)])];
  const order = Object.keys(names);
  return keys.map(section => ({section, label: names[section] ?? section, reportCents: sum(reportKind, section), journalCents: sum(journalKind, section)}))
    .filter(row => Math.abs(row.reportCents - row.journalCents) >= JOURNAL_MISMATCH_CENTS)
    .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section));
}

/** Counts bookings: the reported day (who came, who did not) and today's outlook (confirmed and still waiting). */
/** A booking of this many guests or more is a group worth knowing in the morning. */
export const GROUP_MIN_GUESTS = 8;
export function summarizeReservations(config: TenantConfig, day: Reservation[], today: Reservation[]): Briefing['reservations'] {
  if (!day.length && !today.length) return null;
  const confirmedDay = day.filter(row => row.status === 'confirmed');
  const noShows = confirmedDay.filter(row => row.arrival === 'no_show');
  const confirmedToday = today.filter(row => row.status === 'confirmed');
  const sections = new Map<string, {confirmed: number; guests: number}>();
  for (const row of confirmedToday) {
    const section = sections.get(row.section) ?? {confirmed: 0, guests: 0};
    section.confirmed++; section.guests += row.partySize; sections.set(row.section, section);
  }
  const order = Object.keys(config.sections);
  const guests = (rows: Reservation[]) => rows.reduce((sum, row) => sum + row.partySize, 0);
  const local = (row: Reservation) => localTime(new Date(row.startsAt), config.timeZone);
  const hours = new Map<number, number>();
  for (const row of confirmedToday) hours.set(local(row).hour, (hours.get(local(row).hour) ?? 0) + row.partySize);
  const clock = (row: Reservation) => { const time = local(row); return `${time.hour}:${String(time.minute).padStart(2, '0')}`; };
  return {
    day: {
      confirmed: confirmedDay.length, guests: guests(confirmedDay), arrived: confirmedDay.filter(row => row.arrival === 'arrived').length,
      noShows: noShows.length, noShowGuests: guests(noShows), cancelled: day.filter(row => row.status === 'cancelled').length,
    },
    today: {
      confirmed: confirmedToday.length, guests: guests(confirmedToday), pending: today.filter(row => row.status === 'pending').length,
      bySection: [...sections].map(([section, row]) => ({section, label: config.sections[section] ?? section, ...row}))
        .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section)),
      // Club hours after midnight (0–5) belong to the night before: they sort after the evening.
      byHour: [...hours].map(([hour, count]) => ({hour, guests: count})).sort((a, b) => (a.hour + 18) % 24 - (b.hour + 18) % 24),
      groups: confirmedToday.filter(row => row.partySize >= GROUP_MIN_GUESTS)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || b.partySize - a.partySize)
        .map(row => ({time: clock(row), label: config.sections[row.section] ?? row.section, partySize: row.partySize})),
    },
  };
}
/** The website's day in a few numbers; reservations sent = visits that sent the booking form. */
export function summarizeWeb(day: WebTraffic | undefined, lastWeek: WebTraffic | undefined): Briefing['web'] {
  if (!day) return null;
  return {
    visits: day.visits, withAction: day.visitsWithAction, lastWeekVisits: lastWeek?.visits ?? null,
    reservationsSent: day.actions['rezervace-odeslana'] ?? 0, reviewScans: day.reviewScans,
    topOrigins: [...day.origins].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key)).filter(row => row.visits > 0).slice(0, 3).map(({name, visits}) => ({name, visits})),
    menuVisits: day.menu?.visits ?? null,
  };
}
/** New reviews of the day: count, average stars (tenths), how many have 3 ★ or less, per source; and what waits in the admin. */
export function summarizeReviews(day: ReviewSummary | undefined): Briefing['reviews'] {
  if (!day) return null;
  let rated = 0, starSum = 0, low = 0, unrated = 0;
  for (const source of day.sources) {
    source.stars.forEach((count, i) => { rated += count; starSum += count * (i + 1); if (i < 3) low += count; });
    unrated += source.unrated;
  }
  return {
    newCount: rated + unrated, averageTenths: rated ? Math.round(starSum / rated * 10) : null, low,
    bySource: day.sources.map(source => ({name: source.name, newCount: source.stars.reduce((sum, count) => sum + count, 0) + source.unrated})).filter(row => row.newCount > 0),
    waiting: day.waiting, forManagement: day.forManagement, failed: day.failed,
  };
}
export type BottleLoss = {name: string; lossMl: number; lossCents: number};

/**
 * Loss per bottle = expected − counted (surpluses are not netted against losses). CZK at purchase
 * price per litre. Only losses from the venue's threshold (default 100 Kč) are listed.
 */
export function bottleLosses(check: BottleCheck, minLossCents: number) {
  const all = check.items.map(item => {
    const lossMl = Math.max(0, item.expectedMl - item.countedMl);
    return {name: item.name, lossMl, lossCents: Math.round(lossMl * item.costPerLitreCents / 1000)};
  }).filter(row => row.lossMl > 0);
  return {
    lossCents: all.reduce((sum, row) => sum + row.lossCents, 0),
    losses: all.filter(row => row.lossCents > 0 && row.lossCents >= minLossCents).sort((a, b) => b.lossCents - a.lossCents || a.name.localeCompare(b.name, 'cs')),
  };
}

const confirmedGuests = (rows: Reservation[]) => rows.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + row.partySize, 0);
/** The day that is starting: plan from the same weekday's revenue, booked guests against the same weekday's usual (at least two days). */
export function outlook(today: Reservation[], planHistory: {revenueCents: number}[], guestHistory: number[]): Briefing['outlook'] {
  return {planCents: planFrom(planHistory)?.revenueCents ?? null, guests: confirmedGuests(today),
    usualGuests: guestHistory.length >= 2 ? Math.round(guestHistory.reduce((sum, value) => sum + value, 0) / guestHistory.length) : null};
}
/** Today's plan is the forecast for today when there is one (seasonality and bookings included), the same number tomorrow's message checks. */
const forecastOutlook = (base: Briefing['outlook'], forecast: Forecast | null, logged: number | null): Briefing['outlook'] =>
  logged ? {...base, planCents: logged} : forecast?.days[0]?.cents ? {...base, planCents: forecast.days[0].cents} : base;
/** No-shows are worth a warning from 6 guests, at least 10 % of the booked guests and at least twice the usual share. */
export const NO_SHOW_MIN_GUESTS = 6;
export function noShowRate(day: Reservation[], history: {confirmedGuests: number; noShowGuests: number} | null): Briefing['noShows'] {
  const confirmed = confirmedGuests(day);
  if (!confirmed) return null;
  const guests = day.filter(row => row.status === 'confirmed' && row.arrival === 'no_show').reduce((sum, row) => sum + row.partySize, 0);
  // Fewer than 50 booked guests in four weeks is too little to call anything usual.
  const usualPermille = history && history.confirmedGuests >= 50 ? Math.round(history.noShowGuests / history.confirmedGuests * 1000) : null;
  return {guests, confirmedGuests: confirmed, ratePermille: Math.round(guests / confirmed * 1000), usualPermille};
}
/** True when the day's no-shows stand out: enough guests, a tenth of the bookings or more, and twice the usual share. */
export const noShowAlarm = (rate: Briefing['noShows']) => !!rate && rate.guests >= NO_SHOW_MIN_GUESTS && rate.ratePermille >= 100
  && (rate.usualPermille === null || rate.ratePermille >= 2 * rate.usualPermille);
/** " (3,1 % tržby)": a part of the revenue to one decimal; empty without revenue. */
export const share = (cents: number, revenueCents: number) => cents && revenueCents > 0 ? ` (${(Math.round(cents / revenueCents * 1000) / 10).toFixed(1).replace('.', ',')} % tržby)` : '';
/** "nedorazil 1 host", "nedorazili 3 hosté", "nedorazilo 5 hostů". */
const notCame = (count: number) => count === 1 ? 'nedorazil' : count >= 2 && count <= 4 ? 'nedorazili' : 'nedorazilo';
const percent = (permille: number) => `${Math.round(permille / 10)} %`;
export const noShowText = (rate: NonNullable<Briefing['noShows']>) =>
  `nedorazilo ${rate.guests} ${guestsWord(rate.guests)} z ${rate.confirmedGuests} rezervovaných (${percent(rate.ratePermille)}${rate.usualPermille !== null ? `, obvykle ${percent(rate.usualPermille)}` : ''})`;

/** The week's reviews fall behind when at least 5 have stars and their average is 0,3 ★ or more under the 4 weeks before (10 or more rated). */
export function reviewDrop(week: Briefing['week']): boolean {
  const usual = week?.reviewsUsual;
  return !!week && !!usual && week.current.rated >= 5 && usual.rated >= 10 && week.current.starsTenths !== null && usual.starsTenths !== null
    && week.current.starsTenths <= usual.starsTenths - 3;
}
const stars = (tenths: number) => `${(tenths / 10).toFixed(1).replace('.', ',')} ★`;
export const reviewDropText = (week: Week) =>
  `průměr recenzí za týden ${stars(week.current.starsTenths!)} z ${week.current.rated} hodnocených (4 týdny předtím ${stars(week.reviewsUsual!.starsTenths!)})`;

/** A discount type counts as unusual when it is at least twice its usual amount and at least 1 000 Kč above it. */
export const UNUSUAL_DISCOUNT_CENTS = 100000;
/**
 * Discount types of the day (staff, promo, write-offs…) far above their usual amount: the average of the same weekday
 * over the previous weeks that have a report (at least two). A type missing on such a day counts as zero.
 */
export function unusualDiscounts(report: DailyReport, history: DiscountHistory): UnusualDiscount[] {
  const days = history.days;
  if (days < 2) return [];
  const today = new Map<string, {label: string; amountCents: number}>();
  for (const entry of report.lines.filter(entry => entry.kind === 'discount' && entry.amountCents > 0)) {
    const row = today.get(entry.key) ?? {label: entry.label, amountCents: 0};
    row.amountCents += entry.amountCents; today.set(entry.key, row);
  }
  return [...today].map(([key, row]) => ({key, ...row, usualCents: Math.round((history.totals[key] ?? 0) / days)}))
    .filter(row => row.amountCents >= 2 * row.usualCents && row.amountCents - row.usualCents >= UNUSUAL_DISCOUNT_CENTS)
    .sort((a, b) => (b.amountCents - b.usualCents) - (a.amountCents - a.usualCents) || a.key.localeCompare(b.key));
}

/**
 * Clearly more confirmed guests than the weekday's usual (at least 10 usual and 10 more) raise that day's forecast
 * by half the extra share, at most by half: walk-ins and the bar are not booked, so the revenue grows slower than the bookings.
 */
export const BOOKING_BOOST_MAX = 1.5, BOOKING_MIN_GUESTS = 10;
/** Average distance of the actual revenue from the forecast, in per mille of the forecast; at least 7 days. */
export function forecastAccuracy(rows: {forecastCents: number; actualCents: number}[]): Forecast['accuracy'] {
  const valid = rows.filter(row => row.forecastCents > 0);
  if (valid.length < 7) return null;
  return {days: valid.length, errorPermille: Math.round(valid.reduce((sum, row) => sum + Math.abs(row.actualCents - row.forecastCents) / row.forecastCents, 0) / valid.length * 1000)};
}

/** Last year's seasonality is used only within these limits, so one odd month cannot double or halve the forecast. */
export const SEASON_MIN = 0.5, SEASON_MAX = 2;
const monthEnd = (month: string) => addDays(nextMonthOf(month) + '-01', -1);
const nextMonthOf = (month: string) => { const [year, number] = month.split('-').map(Number); return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`; };
/**
 * Forecast from the day that is starting (`today`): each day = the average revenue of its weekday over the last 4 weeks (`bases`, Sunday first)
 * × last year's seasonality of its month (`seasonal`, missing = 1). Sums are `null` when any day in them has no base.
 */
export function forecast(input: {today: string; bases: (number | null)[]; seasonal: Record<string, number>; monthActual: {cents: number; days: number; missing?: string[]};
  bookings?: Record<string, {guests: number; usualGuests: number | null}>; weather?: WeatherDay[]; accuracy?: Forecast['accuracy'];
  events?: Record<string, string[]>; eventFactor?: Forecast['eventFactor'];
  /** Public holidays in the forecast's reach with how each usually changes its day (`null` = not known yet). */
  holidays?: Record<string, {name: string; factor: number | null}>; rainFactor?: Forecast['rainFactor']}): Forecast {
  const boost = (date: string) => {
    const booked = input.bookings?.[date];
    if (!booked?.usualGuests || booked.usualGuests < BOOKING_MIN_GUESTS || booked.guests - booked.usualGuests < BOOKING_MIN_GUESTS) return 1;
    return Math.min(BOOKING_BOOST_MAX, Math.round((1 + (booked.guests / booked.usualGuests - 1) / 2) * 100) / 100);
  };
  const eventBoost = (date: string) => input.events?.[date]?.length && input.eventFactor ? input.eventFactor.factor : 1;
  const weather = new Map((input.weather ?? []).map(entry => [entry.date, entry]));
  const holidayFactor = (date: string) => input.holidays?.[date]?.factor ?? 1;
  const rain = (date: string) => input.rainFactor && (weather.get(date)?.rainMm ?? 0) >= RAIN_MM ? input.rainFactor.factor : 1;
  // More bookings and an event both mean a fuller day: the bigger of the two counts, never both. A holiday and rain change the day on top.
  const day = (date: string) => {
    const base = input.bases[weekday(date)];
    return base === null || base === undefined ? null
      : Math.round(base * (input.seasonal[date.slice(0, 7)] ?? 1) * Math.max(boost(date), eventBoost(date)) * holidayFactor(date) * rain(date));
  };
  const sum = (from: string, to: string) => {
    let total = 0;
    for (let date = from; date <= to; date = addDays(date, 1)) { const value = day(date); if (value === null) return null; total += value; }
    return total;
  };
  const month = input.today.slice(0, 7), next = nextMonthOf(month);
  // Elapsed days without data are forecast too, so the month total is not too low.
  const gaps = (input.monthActual.missing ?? []).map(day), rest = sum(input.today, monthEnd(month));
  const restCents = rest === null || gaps.includes(null) ? null : rest + gaps.reduce<number>((total, value) => total + value!, 0);
  return {
    today: input.today,
    days: Array.from({length: 7}, (_, i) => addDays(input.today, i)).map(date => ({date, cents: day(date),
      guests: input.bookings?.[date]?.guests ?? 0, usualGuests: input.bookings?.[date]?.usualGuests ?? null, boost: boost(date), weather: weather.get(date) ?? null, weatherText: weather.has(date) ? weatherText(weather.get(date)!) : null,
      events: input.events?.[date] ?? [], eventBoost: eventBoost(date),
      holiday: input.holidays?.[date]?.name ?? null, holidayFactor: holidayFactor(date), rainFactor: rain(date)})),
    accuracy: input.accuracy ?? null,
    tomorrow: {date: addDays(input.today, 1), cents: day(addDays(input.today, 1))},
    week: {from: input.today, to: addDays(input.today, 6), cents: sum(input.today, addDays(input.today, 6))},
    month: {month, actualCents: input.monthActual.cents, actualDays: input.monthActual.days, elapsedDays: Number(input.today.slice(8)) - 1,
      restCents, totalCents: restCents === null ? null : input.monthActual.cents + restCents},
    nextMonth: {month: next, cents: sum(next + '-01', monthEnd(next))},
    seasonal: input.seasonal,
    eventFactor: input.eventFactor ?? null,
    rainFactor: input.rainFactor ?? null,
  };
}

/** Rain from 5 mm a day counts as a rainy day; its factor needs 6 past rainy days with revenue and stays within 0,5–1,5×. */
export const RAIN_MM = 5, RAIN_MIN_DAYS = 6;
export function rainFactor(ratios: number[]): Forecast['rainFactor'] {
  if (ratios.length < RAIN_MIN_DAYS) return null;
  const sorted = [...ratios].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {factor: Math.round(Math.min(1.5, Math.max(0.5, value)) * 100) / 100, days: ratios.length};
}

/** Event factor = median of event days' revenue against their weekday's average; at least 4 days, only raising (1–2×). */
export const EVENT_MIN_DAYS = 4;
export function eventFactor(ratios: number[]): Forecast['eventFactor'] {
  if (ratios.length < EVENT_MIN_DAYS) return null;
  const sorted = [...ratios].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {factor: Math.round(Math.min(2, Math.max(1, median)) * 100) / 100, days: ratios.length};
}

/** Plan = average revenue of the same weekday over the previous weeks that have data (at least two). */
export function planFrom(history: {revenueCents: number}[]): Briefing['plan'] {
  if (history.length < 2) return null;
  return {revenueCents: Math.round(history.reduce((sum, row) => sum + row.revenueCents, 0) / history.length), days: history.length};
}

export function buildBriefing(input: {
  businessDate: string; config: TenantConfig; bills: Bill[]; closings: CashClosing[];
  planHistory: {revenueCents: number}[]; incomplete: boolean; bottleChecks?: BottleCheck[];
  report?: DailyReport | null; notes?: NotesAnalysis | null;
  reservations?: Reservation[]; reservationsToday?: Reservation[];
  web?: WebTraffic; webLastWeek?: WebTraffic;
  /** Visits and sent booking forms of the same weekday over the 4 weeks before (days the website sent). */
  webUsual?: {visits: number; sent: number}[];
  eventRanking?: EventRank[] | null; menuWeek?: MenuWeek | null; menuDay?: MenuWeek | null; menuMonth?: MenuMonth | null; slowSellers?: SlowSellers | null; priceResults?: PriceExperiment[]; menuProblems?: string[]; priceMismatches?: PriceMismatch[]; priceCheck?: Briefing['priceCheck']; menuGaps?: Briefing['menuGaps']; menuInterest?: Briefing['menuInterest']; menuByLanguage?: Briefing['menuByLanguage']; competitors?: Briefing['competitors'];
  costs?: MonthResult | null; costsPrevious?: MonthResult | null; supplies?: SupplyBrief | null; mail?: MailBrief | null;
  reviews?: ReviewSummary;
  week?: Week | null; silent?: {name: string; since: string}[];
  month?: Month | null; lastWeekRevenueCents?: number | null; forecast?: Forecast | null;
  pendingAhead?: Briefing['pendingAhead']; events?: Briefing['events']; guestOutlook?: Omit<GuestOutlook, 'noShowGuests'> | null;
  /** The forecast OKO1 made for this day the morning before (its "plan for today"); wins over the weekday average. */
  forecastPlanCents?: number | null;
  /** The plan the message about this day gave for the next one (kept), so an old day shows what was sent. */
  todayPlanCents?: number | null;
  /** Revenue of the starting day's weekday over the previous weeks, and its confirmed guests on those days (days with bookings only). */
  todayPlanHistory?: {revenueCents: number}[]; todayGuestHistory?: number[];
  /** Confirmed and no-show guests over the 28 days before the reported day. */
  noShowHistory?: {confirmedGuests: number; noShowGuests: number};
  discountHistory?: DiscountHistory;
  tableChecks?: TableCheck[]; noteThemes?: string[]; themes?: ThemeSummary | null; djRanking?: DjRank[] | null;
  lastYearRevenueCents?: number | null; target?: MonthTarget | null; dataGaps?: DataGaps | null;
  cashNeed?: CashNeed | null; payoutAlarm?: PayoutAlarm | null; nights?: NightSummary | null; till?: Till | null;
  incidents?: Incident[] | null; foreignWeek?: ForeignWeek | null;
  wageDay?: WageDay | null; nightShare?: NightShare | null; staffGaps?: StaffGaps | null;
  promoWeek?: PromoWeek | null; promoStreaks?: PromoStreak[];
  voidWeek?: {week: VoidSum; before: VoidSum} | null; cashDiffRepeat?: {date: string; cents: number}[] | null; voidAndDiff?: VoidAndDiff | null;
}): Briefing {
  const closed = input.bills.filter(bill => bill.status === 'closed');
  const add = <K>(map: Map<K, number>, key: K, value: number) => map.set(key, (map.get(key) ?? 0) + value);
  const sections = new Map<string, {revenueCents: number; bills: number}>();
  const payments = new Map<string, number>();
  const items = new Map<string, {quantity: number; revenueCents: number}>();
  let revenueCents = 0, guests = 0, discountsCents = 0;
  const voids = {count: 0, amountCents: 0, afterPaymentCount: 0, afterPaymentCents: 0};
  for (const bill of input.bills) {
    for (const entry of bill.voids) {
      voids.count++; voids.amountCents += entry.amountCents;
      if (entry.afterPayment) { voids.afterPaymentCount++; voids.afterPaymentCents += entry.amountCents; }
    }
  }
  for (const bill of closed) {
    revenueCents += bill.totalCents; guests += bill.guests ?? 0; discountsCents += bill.discountCents;
    const section = sections.get(bill.section) ?? {revenueCents: 0, bills: 0};
    section.revenueCents += bill.totalCents; section.bills++; sections.set(bill.section, section);
    for (const payment of bill.payments) add(payments, payment.method, payment.amountCents);
    for (const item of bill.items) {
      const row = items.get(item.name) ?? {quantity: 0, revenueCents: 0};
      row.quantity += item.quantity; row.revenueCents += item.totalCents; items.set(item.name, row);
    }
  }
  const closedRegisters = new Set(input.closings.map(closing => closing.registerId));
  // A recount the same morning replaces the earlier one.
  const check = [...(input.bottleChecks ?? [])].sort((a, b) => b.countedAt.localeCompare(a.countedAt) || b.version - a.version)[0];
  const minLossCents = input.config.bottleCheck?.minLossCents ?? DEFAULT_BOTTLE_LOSS_CENTS;
  const order = Object.keys(input.config.sections);
  const report = input.report ?? null;
  // Until Pexeso runs, the managers' report is the only source of revenue; POS bills win as soon as there are any.
  const source = closed.length ? 'pos' : report && report.lines.some(entry => entry.kind === 'revenue_section') ? 'report' : 'none';
  if (source === 'report' && report) {
    for (const entry of report.lines.filter(entry => entry.kind === 'revenue_section')) {
      revenueCents += entry.amountCents;
      sections.set(entry.key, {revenueCents: entry.amountCents, bills: 0});
    }
    for (const entry of report.lines.filter(entry => entry.kind === 'payment')) add(payments, entry.key, entry.amountCents);
    discountsCents = line(report, 'total', 'discounts')?.amountCents ?? total(report, 'discount');
    const voided = report.lines.filter(entry => entry.kind === 'void');
    voids.count = voided.reduce((sum, entry) => sum + (entry.count ?? (entry.amountCents ? 1 : 0)), 0);
    voids.amountCents = total(report, 'void');
  }
  return {
    businessDate: input.businessDate,
    revenueCents, bills: closed.length, guests,
    averageBillCents: closed.length ? Math.round(revenueCents / closed.length) : null,
    bySection: [...sections].map(([section, row]) => ({section, label: input.config.sections[section] ?? section, ...row}))
      .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section)),
    payments: [...payments].map(([method, amountCents]) => ({method, amountCents})).sort((a, b) => b.amountCents - a.amountCents),
    discountsCents,
    cancelledBills: input.bills.length - closed.length,
    voids,
    cash: input.closings.map(closing => ({registerId: closing.registerId, differenceCents: closing.countedCents - closing.expectedCents}))
      .sort((a, b) => a.registerId.localeCompare(b.registerId)),
    missingClosings: input.config.registers.filter(register => !closedRegisters.has(register)),
    plan: input.forecastPlanCents ? {revenueCents: input.forecastPlanCents, days: input.planHistory.length} : planFrom(input.planHistory),
    topItems: [...items].map(([name, row]) => ({name, ...row})).sort((a, b) => b.revenueCents - a.revenueCents || a.name.localeCompare(b.name)).slice(0, 5),
    bottles: check ? {countedAt: check.countedAt, checked: check.items.length, minLossCents, ...bottleLosses(check, minLossCents)} : null,
    bottleCheckMissing: !check && !!input.config.bottleCheck,
    source,
    report: report ? {
      expensesCents: positive(report, 'expense'), payoutsCents: positive(report, 'payout'), safeCents: line(report, 'balance', 'safe')?.amountCents ?? null, cashDifferenceCents: line(report, 'total', 'cash-difference')?.amountCents ?? null,
      discounts: report.lines.filter(entry => entry.kind === 'discount' && entry.amountCents > 0).sort((a, b) => b.amountCents - a.amountCents)
        .map(({label, count, amountCents}) => ({label, count, amountCents})),
      journalMismatches: journalMismatches(report, input.config.sections),
      paymentMismatches: journalMismatches(report, methods, 'payment', 'journal_payment', ['cash', 'card', 'customer_card'], true),
    } : null,
    notes: input.notes ? {points: input.notes.points, summary: input.notes.summary, raw: null}
      : report?.notes ? {points: [], summary: null, raw: report.notes} : null,
    reservations: summarizeReservations(input.config, input.reservations ?? [], input.reservationsToday ?? []),
    web: summarizeWeb(input.web, input.webLastWeek),
    webDrop: webDrop(input.web, input.webUsual),
    eventRanking: input.eventRanking ?? null,
    menuWeek: input.menuWeek ?? null, menuDay: input.menuDay ?? null, menuMonth: input.menuMonth ?? null, slowSellers: input.slowSellers ?? null, priceResults: input.priceResults ?? [], menuProblems: input.menuProblems ?? [], priceMismatches: input.priceMismatches ?? [], priceCheck: input.priceCheck ?? null, menuGaps: input.menuGaps ?? null, menuInterest: input.menuInterest ?? null, menuByLanguage: input.menuByLanguage ?? null, competitors: input.competitors ?? null,
    reviews: summarizeReviews(input.reviews),
    costs: input.costs ?? null, costsPrevious: input.costsPrevious ?? null, supplies: input.supplies ?? null, mail: input.mail ?? null,
    week: input.week ?? null,
    month: input.month ?? null,
    lastWeekRevenueCents: input.lastWeekRevenueCents ?? null,
    outlook: forecastOutlook(outlook(input.reservationsToday ?? [], input.todayPlanHistory ?? [], input.todayGuestHistory ?? []), input.forecast ?? null, input.todayPlanCents ?? null),
    forecast: input.forecast ?? null,
    pendingAhead: input.pendingAhead ?? null,
    events: input.events ?? [],
    guestOutlook: guestOutlookWithNoShows(input.guestOutlook ?? null, input.noShowHistory ?? null),
    noShows: noShowRate(input.reservations ?? [], input.noShowHistory ?? null),
    unusualDiscounts: report ? unusualDiscounts(report, input.discountHistory ?? {days: 0, totals: {}}) : [],
    silent: input.silent ?? [],
    cashNeed: input.cashNeed ?? null, payoutAlarm: input.payoutAlarm ?? null, nights: input.nights ?? null, till: input.till ?? null, incidents: input.incidents ?? null, foreignWeek: input.foreignWeek ?? null,
    wageDay: input.wageDay ?? null, nightShare: input.nightShare ?? null, staffGaps: input.staffGaps ?? null,
    promoWeek: input.promoWeek ?? null, promoStreaks: input.promoStreaks ?? [],
    voidWeek: input.voidWeek ?? null, cashDiffRepeat: input.cashDiffRepeat ?? null, voidAndDiff: input.voidAndDiff ?? null,
    lastYearRevenueCents: input.lastYearRevenueCents ?? null, target: input.target ?? null, dataGaps: input.dataGaps ?? null,
    tableChecks: input.tableChecks ?? [], noteThemes: input.noteThemes ?? [], themes: input.themes ?? null, djRanking: input.djRanking ?? null,
    incomplete: input.incomplete,
  };
}

const days = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const methods: Record<string, string> = {cash: 'hotovost', card: 'karta', customer_card: 'zákaznická karta', voucher: 'poukaz', transfer: 'převod'};

/** Whole crowns with a space as the thousands separator: 84 320 Kč. */
export function crowns(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return sign + group(Math.round(Math.abs(cents) / 100)) + ' Kč';
}
const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function czechDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${days[weekday(date)]} ${day}. ${month}. ${year}`;
}

/** Plain text for WhatsApp or SMS. Short lines, warnings marked with ⚠. */
export function renderBriefing(name: string, briefing: Briefing): string {
  const lines = [`${name} · ${czechDate(briefing.businessDate)}`];
  if (briefing.incomplete) lines.push(`⚠ Report chybí${briefing.missingClosings.length ? ': ' + briefing.missingClosings.join(', ') : ''}. Čísla nemusí být konečná.`);
  for (const source of briefing.silent) lines.push(`⚠ ${source.name} neposílá data od ${source.since}.`);
  if (hasGaps(briefing.dataGaps)) lines.push(`⚠ Chybí data za 14 dní: ${gapsText(briefing.dataGaps!)}`);
  let revenue = `Tržba: ${crowns(briefing.revenueCents)}`;
  if (briefing.plan) {
    const delta = briefing.plan.revenueCents ? Math.round((briefing.revenueCents / briefing.plan.revenueCents - 1) * 100) : 0;
    revenue += ` (plán ${crowns(briefing.plan.revenueCents)}, ${delta >= 0 ? '+' : '−'}${Math.abs(delta)} %)`;
  }
  if (briefing.lastWeekRevenueCents && briefing.revenueCents && !briefing.incomplete) revenue += ` · před týdnem ${crowns(briefing.lastWeekRevenueCents)}${change(briefing.revenueCents, briefing.lastWeekRevenueCents)}`;
  if (briefing.lastYearRevenueCents && briefing.revenueCents && !briefing.incomplete) revenue += ` · loni ${crowns(briefing.lastYearRevenueCents)}${change(briefing.revenueCents, briefing.lastYearRevenueCents)}`;
  lines.push(revenue);
  if (briefing.bySection.length > 1) lines.push(briefing.bySection.map(row => `${row.label} ${crowns(row.revenueCents)}`).join(' · '));
  if (briefing.source !== 'report') lines.push(`Účty ${briefing.bills} · hosté ${briefing.guests}${briefing.averageBillCents === null ? '' : ` · průměrný účet ${crowns(briefing.averageBillCents)}`}`);
  // Shares of what was paid in; a negative cash part (more on cards than the bill) is shown as an amount.
  const paid = briefing.payments.filter(row => row.amountCents > 0).reduce((sum, row) => sum + row.amountCents, 0);
  if (paid > 0) lines.push('Platby: ' + briefing.payments.map(row => `${methods[row.method] ?? row.method} ${row.amountCents < 0 ? crowns(row.amountCents) : `${Math.round(row.amountCents / paid * 100)} %`}`).join(', '));
  const control = [`slevy ${crowns(briefing.discountsCents)}`, `storna ${briefing.voids.count}× ${crowns(briefing.voids.amountCents)}`];
  if (briefing.cancelledBills) control.push(`zrušené účty ${briefing.cancelledBills}`);
  lines.push('Kontrola: ' + control.join(' · '));
  if (briefing.voids.afterPaymentCount) lines.push(`⚠ Storna po zaplacení: ${briefing.voids.afterPaymentCount}× ${crowns(briefing.voids.afterPaymentCents)}`);
  const differences = briefing.cash.filter(row => row.differenceCents !== 0);
  if (differences.length) lines.push('⚠ Rozdíl v hotovosti: ' + differences.map(row => `${row.registerId} ${row.differenceCents > 0 ? '+' : ''}${crowns(row.differenceCents)}`).join(', '));
  else if (briefing.cash.length) lines.push('Hotovost v pokladnách sedí.');
  if (briefing.topItems.length) lines.push('Nejvíc tržeb: ' + briefing.topItems.slice(0, 3).map(row => `${row.name} ${row.quantity}×`).join(', '));
  lines.push(...renderReport(briefing));
  lines.push(...renderTableChecks(briefing.tableChecks));
  if (briefing.payoutAlarm) lines.push(`⚠ Výplaty v hotovosti: ${payoutAlarmText(briefing.payoutAlarm)}`);
  lines.push(...renderTill(briefing.till));
  lines.push(...renderWageDay(briefing.wageDay));
  for (const streak of briefing.promoStreaks ?? []) lines.push(`⚠ ${promoStreakText(streak)}`);
  if (briefing.voidAndDiff) lines.push(`⚠ Storna a rozdíl v kase: ${voidAndDiffText(briefing.voidAndDiff)}`);
  if (briefing.cashDiffRepeat) lines.push(`⚠ Kasa: ${cashDiffRepeatText(briefing.cashDiffRepeat)}`);
  if (briefing.nightShare) lines.push(`⚠ Výplaty noci nad obvyklým podílem: ${nightShareText(briefing.nightShare)}`);
  if (briefing.cashNeed) lines.push(`⚠ Hotovost na dnešek: ${cashNeedText(briefing.cashNeed)}; doplň hotovost nebo rozlož výplaty.`);
  lines.push(...renderBottles(briefing));
  lines.push(...renderReservations(briefing.reservations, briefing.outlook));
  lines.push(...renderEvents(briefing.events));
  lines.push(...renderGuestOutlook(briefing.guestOutlook));
  const weak = weakDays(briefing.guestOutlook);
  if (weak.length) lines.push(`⚠ Slabší výhled: ${weakDaysText(weak, briefing.eventRanking)}`);
  const shifts = shiftSignals(briefing.guestOutlook?.days);
  if (shifts.length) lines.push(`Směny na 7 dní: ${shifts.slice(0, SHIFT_LINES).map(shiftText).join(' · ')}${shifts.length > SHIFT_LINES ? ` a další ${shifts.length - SHIFT_LINES}` : ''}`);
  const staffGap = staffGapToday(addDays(briefing.businessDate, 1), briefing.staffGaps);
  if (staffGap) lines.push(`Personál: ${staffGap}`);
  if (briefing.pendingAhead) lines.push(`Na příštích 7 dní ${pendingAheadText(briefing.pendingAhead)}`);
  if (noShowAlarm(briefing.noShows)) lines.push(`⚠ No-show: ${noShowText(briefing.noShows!)}`);
  lines.push(...renderForecast(briefing.forecast));
  lines.push(...renderTarget(briefing.target));
  lines.push(...renderWeb(briefing.web));
  if (briefing.webDrop) lines.push(`⚠ Web: ${webDropText(briefing.webDrop)}.`);
  lines.push(...renderReviews(briefing.reviews));
  lines.push(...renderCosts(briefing.costs, briefing.costsPrevious));
  lines.push(...renderSupplies(briefing.supplies));
  lines.push(...renderMail(briefing.mail?.insights ?? null, briefing.mail?.weekly ?? null, briefing.mail?.monthly ?? null, briefing.mail?.previousWeek ?? null, briefing.mail?.repeated ?? []));
  lines.push(...renderPriceMismatches(briefing.priceMismatches));
  lines.push(...renderMenuWeek(briefing.menuDay, 'Lístek se změnil'), ...(briefing.menuProblems ?? []).map(text => `⚠ ${text}`));
  lines.push(...renderNotes(briefing));
  // The week in a few numbers once a week, in the message about Sunday (Monday morning).
  if (weekday(briefing.businessDate) === 0) lines.push(...renderWeek(briefing.week), ...renderMenuWeek(briefing.menuWeek), ...renderPriceResults(briefing.priceResults), ...renderPriceCheck(briefing.priceCheck), ...renderMenuGaps(briefing.menuGaps), ...renderMenuInterest(briefing.menuInterest), ...renderMenuByLanguage(briefing.menuByLanguage), ...renderCompetitors(briefing.competitors), ...renderThemes(briefing.themes), ...renderDjs(briefing.djRanking), ...renderNights(briefing.nights), ...renderNightShares(briefing.nights?.nights), ...renderStaffGaps(briefing.staffGaps), ...renderPromoWeek(briefing.promoWeek), ...renderVoidWeek(briefing.voidWeek), ...renderForeignWeek(briefing.foreignWeek));
  // The month so far once a week, and the whole month in the message about its last day (the 1st in the morning).
  lines.push(...renderMonth(briefing.month));
  // Which events draw guests, once a month in the message about its last day.
  if (addDays(briefing.businessDate, 1).endsWith('-01')) lines.push(...renderEventRanking(briefing.eventRanking), ...renderMenuMonth(briefing.menuMonth), ...renderSlowSellers(briefing.slowSellers), ...renderIncidents(briefing.businessDate.slice(0, 7), briefing.incidents));
  return lines.join('\n');
}

const BOTTLE_LINES = 5;
/** Short bottle block: one line per meaningful loss, at most five, largest first. */
export function renderBottles(briefing: Pick<Briefing, 'bottles' | 'bottleCheckMissing'>): string[] {
  if (briefing.bottleCheckMissing) return ['⚠ Ranní kontrola lahví chybí.'];
  const bottles = briefing.bottles;
  if (!bottles) return [];
  if (!bottles.losses.length) return [`Lahve: ${bottles.checked} spočítáno, bez manka nad ${crowns(bottles.minLossCents)}.`];
  const shown = bottles.losses.slice(0, BOTTLE_LINES);
  return [
    `Lahve: manko ${crowns(bottles.lossCents)} (${bottles.checked} spočítáno)`,
    ...shown.map(row => `⚠ ${row.name} −${group(row.lossMl)} ml (${crowns(row.lossCents)})`),
    ...(bottles.losses.length > shown.length ? [`… a další ${bottles.losses.length - shown.length}`] : []),
  ];
}

export const CASH_DIFFERENCE_CENTS = 50000;
const count = (value: number | null) => value === null ? '' : `${value}× `;
/** Cash the POS does not see yet: expenses and payouts from the cash book, the safe, where discounts went. */
export function renderReport(briefing: Pick<Briefing, 'report' | 'unusualDiscounts' | 'revenueCents'>): string[] {
  const report = briefing.report;
  if (!report) return [];
  const lines: string[] = [];
  if (report.discounts.length) lines.push('Slevy a odpisy: ' + report.discounts.slice(0, 3).map(row => `${row.label} ${count(row.count)}${crowns(row.amountCents)}`).join(', '));
  if (report.expensesCents || report.payoutsCents) lines.push(`Výdaje z kasy ${crowns(report.expensesCents)} · výplaty v hotovosti ${crowns(report.payoutsCents)}${share(report.payoutsCents, briefing.revenueCents)}`);
  if (report.safeCents !== null && report.safeCents < 0) lines.push(`⚠ Trezor je v deníku záporný: ${crowns(report.safeCents)}`);
  // Coins and rounding make a few crowns of difference every day; from 500 Kč it is worth a look.
  if (report.cashDifferenceCents !== null && Math.abs(report.cashDifferenceCents) >= CASH_DIFFERENCE_CENTS)
    lines.push(`⚠ Přepočet pokladny nesedí se zůstatkem v deníku: ${report.cashDifferenceCents < 0 ? 'chybí' : 'přebývá'} ${crowns(Math.abs(report.cashDifferenceCents))}`);
  if (report.journalMismatches.length) lines.push('⚠ Tržba v reportu nesedí s deníkem: ' + report.journalMismatches.map(mismatch).join(', '));
  if (report.paymentMismatches.length) lines.push('⚠ Platby v reportu nesedí s deníkem: ' + report.paymentMismatches.map(mismatch).join(', '));
  if (briefing.unusualDiscounts.length) lines.push('⚠ Neobvyklé slevy: ' + briefing.unusualDiscounts.map(unusual).join(', '));
  return lines;
}

/** "⚠ Tabulky: Promo v denním reportu 3 200 Kč nesedí se součtem promo slev 4 680 Kč" (one line each, warnings first). */
export function renderTableChecks(checks: TableCheck[] | undefined): string[] {
  const ordered = [...(checks ?? [])].sort((a, b) => (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1));
  return ordered.map(check => `${check.level === 'warn' ? '⚠ ' : ''}Tabulky: ${check.text}.`);
}

/** Topics of the day's text that need someone (for the to-do list), with what to do. */
export const themeTodos = (keys: string[] | undefined) => THEMES.filter(theme => theme.warn && keys?.includes(theme.key)).map(theme => `Report dne: ${theme.name} – ${theme.tip}`);

/** "DJ za 12 týdnů (klub): Vašek 6 nocí, průměr 220 000 Kč, +8 % proti obvyklému dni · Pavel 4 noci, 180 000 Kč, −6 %" */
export function renderDjs(ranking: DjRank[] | null | undefined): string[] {
  if (!ranking || ranking.length < 2) return [];
  const nights = (count: number) => `${count} ${count === 1 ? 'noc' : count <= 4 ? 'noci' : 'nocí'}`;
  return [`DJ za 12 týdnů (tržba klubu): ${ranking.map(row => `${row.dj} ${nights(row.nights)}, průměr ${crowns(row.averageCents)}${row.changePermille === null ? ''
    : `, ${row.changePermille >= 0 ? '+' : '−'}${Math.round(Math.abs(row.changePermille) / 10)} % proti obvyklému dni`}`).join(' · ')}`];
}

/** "Diner: report 45 200 Kč, deník 44 900 Kč" */
export const unusual = (row: UnusualDiscount) => `${row.label} ${crowns(row.amountCents)} (obvykle ${crowns(row.usualCents)})`;
export const mismatch = (row: NonNullable<Briefing['report']>['journalMismatches'][number]) => `${row.label}: report ${crowns(row.reportCents)}, deník ${crowns(row.journalCents)}`;

const NOTE_LINES = 3;
const marks: Record<NotePoint['kind'], string> = {incident: '⚠', problem: '⚠', task: '•', info: '•'};
const kinds: NotePoint['kind'][] = ['incident', 'problem', 'task', 'info'];
/** The most important points of "Report dne"; incidents and problems first. */
export function renderNotes(briefing: Pick<Briefing, 'notes'>): string[] {
  const notes = briefing.notes;
  if (!notes) return [];
  if (notes.raw) return [`Report dne: ${notes.raw.length > 280 ? notes.raw.slice(0, 279) + '…' : notes.raw}`.replace(/\s*\n\s*/g, ' / ')];
  if (!notes.points.length) return notes.summary ? [`Report dne: ${notes.summary}`] : [];
  const points = [...notes.points].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  return ['Report dne:', ...points.slice(0, NOTE_LINES).map(point => `${marks[point.kind]} ${point.text}`),
    ...(notes.points.length > NOTE_LINES ? [`… a další ${notes.points.length - NOTE_LINES}`] : [])];
}

/** "Na příštích 7 dní čeká na potvrzení 5 rezervací (12 hostů), nejbližší čt 15. 10. 18:00" */
export const pendingAheadText = (pending: NonNullable<Briefing['pendingAhead']>) =>
  `čeká na potvrzení ${pending.count} ${pending.count === 1 ? 'rezervace' : pending.count <= 4 ? 'rezervace' : 'rezervací'} (${pending.guests} ${guestsWord(pending.guests)}), nejbližší ${weekdayShort[weekday(pending.first.date)]} ${shortDate(pending.first.date)} ${pending.first.time}`;
const guestsWord = (count: number) => count === 1 ? 'host' : count >= 2 && count <= 4 ? 'hosté' : 'hostů';
/** Two short lines: how the reported day's bookings turned out, and what is booked for the day that is starting. */
export function renderReservations(reservations: Briefing['reservations'], outlook: Briefing['outlook'] | null = null): string[] {
  if (!reservations) return outlook?.planCents ? [`Dnes plán tržby ${crowns(outlook.planCents)}`] : [];
  const {day, today} = reservations;
  let past = `Rezervace: ${day.confirmed} (${day.guests} ${guestsWord(day.guests)})`;
  if (day.noShows) past += `, nedorazilo ${day.noShows} (${day.noShowGuests} ${guestsWord(day.noShowGuests)})`;
  if (day.cancelled) past += `, zrušeno ${day.cancelled}`;
  let next = `Dnes rezervováno: ${today.confirmed} (${today.guests} ${guestsWord(today.guests)})`;
  if (today.bySection.length > 1) next += ' · ' + today.bySection.map(row => `${row.label} ${row.confirmed}`).join(' · ');
  if (today.pending) next += `, čeká na potvrzení ${today.pending}`;
  // The usual count is the final one of those days, this morning's count still grows: no change in per cent.
  if (outlook?.usualGuests) next += ` · obvykle za celý den ${outlook.usualGuests} ${guestsWord(outlook.usualGuests)}`;
  if (outlook?.planCents) next += ` · plán tržby ${crowns(outlook.planCents)}`;
  const lines = [past, next];
  // The busiest hours for the staff plan: the two with the most booked guests, in time order.
  const peaks = [...today.byHour ?? []].sort((a, b) => b.guests - a.guests || (a.hour + 18) % 24 - (b.hour + 18) % 24).slice(0, 2)
    .sort((a, b) => (a.hour + 18) % 24 - (b.hour + 18) % 24);
  if (peaks.length) lines.push('Nejvíc rezervovaných hostů: ' + peaks.map(row => `${row.hour}–${(row.hour + 1) % 24} h ${row.guests}`).join(', '));
  if (today.groups?.length) lines.push(`Skupiny od ${GROUP_MIN_GUESTS} osob: ` + today.groups.map(row => `${row.time} ${row.label} ${row.partySize}`).join(', '));
  return lines;
}

const visitsWord = (count: number) => count === 1 ? 'návštěva' : count >= 2 && count <= 4 ? 'návštěvy' : 'návštěv';
/** The website's day: visits against a week before, what visitors did, and where most of them came from. */
export function renderWeb(web: Briefing['web']): string[] {
  if (!web) return [];
  let line = `Web: ${group(web.visits)} ${visitsWord(web.visits)}`;
  if (web.lastWeekVisits !== null) {
    const change = web.lastWeekVisits ? `, ${web.visits >= web.lastWeekVisits ? '+' : '−'}${Math.round(Math.abs(web.visits - web.lastWeekVisits) / web.lastWeekVisits * 100)} %` : '';
    line += ` (před týdnem ${group(web.lastWeekVisits)}${change})`;
  }
  line += `, ${group(web.withAction)} s rezervací, telefonem nebo navigací, odeslané rezervace ${web.reservationsSent}`;
  if (web.menuVisits != null) line += `, lístek si ${verb(web.menuVisits, 'otevřel')} ${group(web.menuVisits)}`;
  if (web.reviewScans) line += `, QR na recenze ${web.reviewScans}×`;
  return web.topOrigins.length ? [line, 'Odkud: ' + web.topOrigins.map(row => `${row.name} ${group(row.visits)}`).join(' · ')] : [line];
}

const reviewsWord = (count: number) => count === 1 ? 'nová' : count >= 2 && count <= 4 ? 'nové' : 'nových';
/** Reviews in one line: new ones with their average and the weak ones, then what waits in the website's admin. Nothing when all is quiet. */
export function renderReviews(reviews: Briefing['reviews']): string[] {
  if (!reviews || (!reviews.newCount && !reviews.waiting && !reviews.forManagement && !reviews.failed)) return [];
  let line = 'Recenze: ' + (reviews.newCount ? `${reviews.newCount} ${reviewsWord(reviews.newCount)}` : 'žádná nová');
  if (reviews.averageTenths !== null) line += `, průměr ${(reviews.averageTenths / 10).toFixed(1).replace('.', ',')} ★`;
  if (reviews.bySource.length > 1) line += ` (${reviews.bySource.map(row => `${row.name} ${row.newCount}`).join(' · ')})`;
  else if (reviews.bySource.length === 1) line += ` (${reviews.bySource[0].name})`;
  if (reviews.low) line += `, ${reviews.low}× 3 ★ a méně`;
  const admin = [reviews.waiting && `čeká na odpověď ${reviews.waiting}`, reviews.forManagement && `pro vedení ${reviews.forManagement}`,
    reviews.failed && `neodeslané odpovědi ${reviews.failed}`].filter(Boolean);
  if (admin.length) line += `; v adminu ${admin.join(', ')}`;
  return [line];
}

/** Change in whole per cent, with its sign; empty when there is nothing to compare with. */
const change = (now: number, before: number) => before ? ` (${now >= before ? '+' : '−'}${Math.round(Math.abs(now - before) / before * 100)} %)` : '';
const daysWord = (count: number) => `${count} ${count === 1 ? 'den' : count >= 2 && count <= 4 ? 'dny' : 'dní'}`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
/** The 7 days up to the reported day against the 7 before: revenue, bookings, no-shows, website, reviews. */
export function renderWeek(week: Briefing['week']): string[] {
  if (!week) return [];
  const {current: now, previous: before} = week;
  // Changes only against a week with data for as many days; otherwise the per cent would compare different lengths.
  const same = before.revenueDays === now.revenueDays;
  const parts: string[] = [];
  if (now.revenueDays) {
    const notes = [same ? change(now.revenueCents, before.revenueCents).slice(2, -1) : '', now.revenueDays < 7 ? `${daysWord(now.revenueDays)} s daty` : ''].filter(Boolean);
    parts.push(`tržba ${crowns(now.revenueCents)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  if (now.reservations || before.reservations) parts.push(`rezervace ${now.reservations}, ${now.guests} ${guestsWord(now.guests)}${change(now.guests, before.guests)}${now.noShowGuests ? `, ${notCame(now.noShowGuests)} ${now.noShowGuests} ${guestsWord(now.noShowGuests)} (${percent(Math.round(now.noShowGuests / now.guests * 1000))})` : ''}`
    + (now.cancelled ? `, zrušeno ${now.cancelled} (${percent(Math.round(now.cancelled / (now.cancelled + now.reservations) * 1000))} rezervací`
      + (now.lateCancelled ? `, z toho ${now.lateCancelled} až v posledních 24 h před začátkem, ${now.lateCancelledGuests} ${guestsWord(now.lateCancelledGuests ?? 0)}` : '') + ')' : ''));
  if (now.visits !== null) parts.push(`web ${group(now.visits)} ${visitsWord(now.visits)}${before.visits !== null && before.visitDays === now.visitDays ? change(now.visits, before.visits) : ''}`
    + (now.webSent || now.webConfirmed ? ` · rezervační formulář odeslán ${now.webSent}× · potvrzené rezervace z webu na tyto dny ${now.webConfirmed}` : ''));
  if (now.reviews) parts.push(`recenze ${now.reviews}${now.starsTenths !== null ? `, průměr ${stars(now.starsTenths)}` : ''}`);
  const lines = parts.length ? [`Týden ${shortDate(week.from)}–${shortDate(week.to)}: ${parts.join(' · ')}`] : [];
  lines.push(...renderBooking(now));
  lines.push(...renderEventReviews(week.events));
  if (now.origins.length) lines.push('Odkud na web za týden: ' + now.origins.slice(0, 5).map(row => `${row.name} ${group(row.visits)}${row.withAction ? ` (${group(row.withAction)} s akcí)` : ''}`).join(' · '));
  if (reviewDrop(week)) lines.push(`⚠ Recenze: ${reviewDropText(week)}`);
  return lines;
}

/** Guests who usually do not come, from the expected guests of the starting day and the share over 28 days (from 50 booked guests). */
function guestOutlookWithNoShows(outlook: Omit<GuestOutlook, 'noShowGuests'> | null, history: {confirmedGuests: number; noShowGuests: number} | null): GuestOutlook | null {
  if (!outlook?.days.length) return null;
  const today = outlook.days[0], guests = today.expected ?? today.booked;
  return {...outlook, noShowGuests: history && history.confirmedGuests >= 50 && guests ? Math.round(guests * history.noShowGuests / history.confirmedGuests) : null};
}

/** "Hosté dnes: čekej asi 140 (zatím rezervováno 95) · přes den 20 · večer 70 · noc 50 · obvykle nedorazí asi 8" */
export function renderGuestOutlook(outlook: Briefing['guestOutlook'] | undefined): string[] {
  const today = outlook?.days[0];
  if (!today || (!today.booked && !today.expected)) return [];
  const parts = today.parts.filter(part => (part.expected ?? part.booked) > 0)
    .map(part => `${DAY_PARTS.find(entry => entry.key === part.key)!.name} ${part.expected ?? part.booked}`);
  const head = today.expected !== null ? `čekej asi ${today.expected} (zatím rezervováno ${today.booked})` : `rezervováno ${today.booked}`;
  return [`Hosté dnes: ${[head, ...parts, outlook!.noShowGuests ? `obvykle nedorazí asi ${outlook!.noShowGuests}` : ''].filter(Boolean).join(' · ')}`];
}

/** "Akce za týden: pá 9. 10. Rock Night – 120 hostů z rezervací (obvykle 80, +50 %), tržba 150 000 Kč (obvykle 100 000 Kč)" */
export function renderEventReviews(events: EventReview[] | undefined): string[] {
  if (!events?.length) return [];
  return ['Akce za týden: ' + events.map(event => `${weekdayShort[weekday(event.date)]} ${shortDate(event.date)} ${event.title} – ${event.guests} ${guestsWord(event.guests)} z rezervací`
    + (event.usualGuests ? ` (obvykle ${event.usualGuests}, ${change(event.guests, event.usualGuests).slice(2, -1)})` : '')
    + (event.revenueCents !== null ? `, tržba ${crowns(event.revenueCents)}${event.usualRevenueCents ? ` (obvykle ${crowns(event.usualRevenueCents)})` : ''}` : '')).join(' · ')];
}

/** "Dnes akce: 21:00 Klub – Rock Night (rezervováno 40 hostů)" */
export function renderEvents(events: Briefing['events'] | undefined): string[] {
  if (!events?.length) return [];
  return ['Dnes akce: ' + events.map(row => `${row.time} ${row.label} – ${row.title}${row.guests ? ` (rezervováno ${row.guests} ${guestsWord(row.guests)})` : ''}`).join(' · ')];
}

const SOURCE_NAMES: Record<string, string> = {web: 'web', obsluha: 'obsluha', mcp: 'AI asistenti'};
/** "Rezervace za týden: týž den 5 · 1–2 dny předem 10 · … · zdroje: web 15 (nedorazilo 4 % hostů) · obsluha 8" */
export function renderBooking(part: WeekPart): string[] {
  const parts: string[] = [];
  const lead = part.lead;
  if (lead && lead.sameDay + lead.upTo2 + lead.upTo7 + lead.more > 0) parts.push(`týž den ${lead.sameDay} · 1–2 dny předem ${lead.upTo2} · 3–7 dní ${lead.upTo7} · víc než týden ${lead.more}`);
  const sources = (part.sources ?? []).filter(row => row.reservations);
  if (sources.length) parts.push('zdroje: ' + sources.map(row => `${SOURCE_NAMES[row.source] ?? row.source} ${row.reservations}`
    + (row.noShowGuests && row.guests ? ` (nedorazilo ${percent(Math.round(row.noShowGuests / row.guests * 1000))} hostů)` : '')).join(' · '));
  return parts.length ? [`Rezervace za týden: ${parts.join(' · ')}`] : [];
}

/** Why a day is higher: its events (and how much an event day usually makes more) or clearly more bookings; the bigger one is applied. */
function bracket(day: ForecastDay | undefined): string {
  if (!day) return '';
  const event = day.eventBoost ?? 1, notes: string[] = [];
  if (day.events?.length) notes.push(`akce ${day.events.join(', ')}${event > 1 && event >= day.boost ? `, bývá o ${Math.round((event - 1) * 100)} % víc` : ''}`);
  if (day.boost > 1 && day.boost > event) notes.push('víc rezervací než obvykle');
  const by = (factor: number) => factor > 1 ? `bývá o ${Math.round((factor - 1) * 100)} % víc` : `bývá o ${Math.round((1 - factor) * 100)} % méně`;
  if (day.holiday) notes.push(`svátek ${day.holiday}${day.holidayFactor !== undefined && day.holidayFactor !== 1 ? `, ${day.holidayFactor ? by(day.holidayFactor) : 'loni zavřeno'}` : ''}`);
  if (day.rainFactor !== undefined && day.rainFactor !== 1) notes.push(`déšť, ${by(day.rainFactor)}`);
  return notes.length ? ` (${notes.join(', ')})` : '';
}

const thousands = (cents: number) => crowns(Math.round(cents / 100000) * 100000);
const weekdayShort = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
/** "Odhad tržby: zítra (út 14. 10.) 120 000 Kč · 7 dní od dneška 900 000 Kč · říjen celkem 3 800 000 Kč (zatím 1 200 000 Kč) · listopad 3 500 000 Kč" */
export function renderForecast(forecast: Briefing['forecast']): string[] {
  if (!forecast) return [];
  const parts: string[] = [];
  const next = forecast.days?.[1];
  if (forecast.tomorrow.cents !== null) parts.push(`zítra (${weekdayShort[weekday(forecast.tomorrow.date)]} ${shortDate(forecast.tomorrow.date)}) ${thousands(forecast.tomorrow.cents)}`
    + bracket(next) + (next?.weatherText ? `, ${next.weatherText}` : '') + (next?.bySection?.length ? ` (${sectionThousands(next.cents ?? 0, next.bySection).map(row => `${row.label} ${crowns(row.cents)}`).join(', ')})` : ''));
  if (forecast.week.cents !== null) parts.push(`7 dní od dneška ${thousands(forecast.week.cents)}`);
  const month = forecast.month, missing = month.elapsedDays - month.actualDays;
  if (month.totalCents !== null) parts.push(`${monthName(month.month)} celkem ${thousands(month.totalCents)}`
    + (month.elapsedDays ? ` (zatím ${crowns(month.actualCents)}${missing > 0 ? `, ${daysWord(missing)} bez dat odhadnuto` : ''})` : ''));
  if (forecast.nextMonth.cents !== null) parts.push(`${monthName(forecast.nextMonth.month)} ${thousands(forecast.nextMonth.cents)}`);
  if (parts.length && forecast.accuracy) parts.push(`odhad se za ${daysWord(forecast.accuracy.days)} lišil v průměru o ${Math.round(forecast.accuracy.errorPermille / 10)} %`);
  return parts.length ? [`Odhad tržby: ${parts.join(' · ')}`] : [];
}

const SHIFT_LINES = 5;
/** "Cíl na říjen 3 150 000 Kč (loni 3 000 000 Kč +5 %): zatím 1 200 000 Kč (38 %) · odhad za měsíc 3 050 000 Kč (−3 % pod cílem) · potřeba 150 000 Kč denně (13 dní)" */
export function renderTarget(target: MonthTarget | null | undefined): string[] {
  if (!target) return [];
  const base = target.base.basis === 'last_year' ? `loni ${crowns(target.base.cents)}` : `${monthName(target.base.month)} ${crowns(target.base.cents)}`;
  const parts = [`zatím ${crowns(target.actualCents)} (${Math.round(target.actualCents / target.targetCents * 100)} %)`];
  if (target.forecastCents !== null) {
    const delta = Math.round((target.forecastCents / target.targetCents - 1) * 100);
    parts.push(`odhad za měsíc ${thousands(target.forecastCents)} (${delta >= 0 ? `+${delta} % nad cílem` : `−${-delta} % pod cílem`})`);
  }
  parts.push(target.actualCents >= target.targetCents ? 'cíl je splněný' : `potřeba ${crowns(target.perDayCents ?? 0)} denně (${daysWord(target.daysLeft)} do konce měsíce)`);
  return [`Cíl na ${monthName(target.month)} ${crowns(target.targetCents)} (${base} +5 %): ${parts.join(' · ')}`];
}

/** "Říjen: tržba … (+4 % proti září) · Diner … · výplaty v hotovosti … · výdaje z kasy …" */
export function renderMonth(month: Briefing['month']): string[] {
  if (!month || !month.current.revenueDays) return [];
  const {current: now, previous: before} = month;
  const name = monthName(month.month), title = name[0].toUpperCase() + name.slice(1);
  // A change only between stretches with the same coverage: as many days with data, or every day of each.
  const full = (part: MonthPart, through: string) => part.revenueDays === Number(through.slice(8));
  const comparable = before.revenueCents > 0 && (before.revenueDays === now.revenueDays || (full(now, month.through) && full(before, before.through)));
  const against = month.complete ? monthName(before.month) : `${shortDate(before.month + '-01')}–${shortDate(before.through)}`;
  // Last year's same days only when as many of them have data.
  const year = month.lastYear, againstYear = year && year.revenueCents > 0 && year.revenueDays === now.revenueDays;
  const notes = [comparable ? `${change(now.revenueCents, before.revenueCents).slice(2, -1)} proti ${against}` : '',
    againstYear ? `${change(now.revenueCents, year!.revenueCents).slice(2, -1)} proti loňsku` : '',
    now.revenueDays < Number(month.through.slice(8)) ? `${daysWord(now.revenueDays)} s daty` : ''].filter(Boolean);
  const parts = [`tržba ${crowns(now.revenueCents)}${notes.length ? ` (${notes.join(', ')})` : ''}`];
  if (now.bySection && now.bySection.length > 1) parts.push(now.bySection.map(row => `${row.label} ${crowns(row.revenueCents)}`).join(' · '));
  if (month.payoutsCents) {
    // The payouts by kind (src/wages.ts) inside the same brackets as their share of the revenue.
    const payoutShare = share(month.payoutsCents, now.revenueCents), kinds = month.wages ? wageSumText(month.wages) : '';
    parts.push(`výplaty v hotovosti ${crowns(month.payoutsCents)}${kinds ? (payoutShare ? `${payoutShare.slice(0, -1)}; ${kinds})` : ` (${kinds})`) : payoutShare}`);
  }
  if (month.expensesCents) parts.push(`výdaje z kasy ${crowns(month.expensesCents)}`);
  if (month.discountsCents) parts.push(`slevy ${crowns(month.discountsCents)}`);
  if (promoMonthText(month.promo)) parts.push(promoMonthText(month.promo));
  if (voidMonthText(month.voids)) parts.push(voidMonthText(month.voids));
  if (month.staffMeals?.cents) parts.push(staffMealsText(month.staffMeals));
  if (month.reviews?.reviews) parts.push(`recenze ${month.reviews.reviews}${month.reviews.starsTenths !== null ? `, průměr ${stars(month.reviews.starsTenths)}` : ''}`);
  return [`${title}${month.complete ? ' celkem' : ` do ${shortDate(month.through)}`}: ${parts.join(' · ')}`];
}

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
const COST_LINES = 3;
/**
 * Costs from accounting: the month so far (largest accounts) and revenue − costs; the month before while invoices
 * for it still arrive. Accounting lags behind, so the costs are "posted so far", never a final result.
 */
export function renderCosts(costs: MonthResult | null, previous: MonthResult | null): string[] {
  if (!costs) return [];
  const lines: string[] = [];
  const total = (month: MonthResult) => month.rows.reduce((sum, row) => sum + row.amountCents, 0);
  const result = (month: MonthResult) => `tržby ${crowns(month.revenueCents)} − náklady ${crowns(total(month))} = ${crowns(month.revenueCents - total(month))}`;
  const day = Number(costs.through.slice(8, 10)), monthOf = Number(costs.through.slice(5, 7));
  if (costs.rows.length) {
    const top = costs.rows.slice(0, COST_LINES).map(row => `${row.name} ${crowns(row.amountCents)}`).join(' · ');
    lines.push(`Náklady ${monthName(costs.month)} do ${day}. ${monthOf}. (zaúčtované): ${crowns(total(costs))} · ${top}`);
    lines.push(`${monthName(costs.month)[0].toUpperCase()}${monthName(costs.month).slice(1)} zatím: ${result(costs)}`);
  } else if (!costs.error) lines.push(`Náklady ${monthName(costs.month)}: zatím nic zaúčtováno.`);
  if (previous?.rows.length) lines.push(`${monthName(previous.month)[0].toUpperCase()}${monthName(previous.month).slice(1)} celkem: ${result(previous)}`);
  if (costs.error) lines.push(`⚠ Náklady z iÚčta se dnes nepodařilo načíst (${costs.error})${costs.rows.length || previous?.rows.length ? ', čísla jsou z posledního načtení' : ''}.`);
  return lines;
}
