/** Czech public holidays (zákon č. 245/2000 Sb.), the forecast's days out of the ordinary. Dates are YYYY-MM-DD. */

/** Easter Sunday of a year (Gregorian calendar, the anonymous algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const shift = (date: string, days: number) => {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const FIXED: [string, string][] = [
  ['01-01', 'Nový rok'], ['05-01', 'Svátek práce'], ['05-08', 'Den vítězství'], ['07-05', 'Cyril a Metoděj'], ['07-06', 'Jan Hus'],
  ['09-28', 'Den české státnosti'], ['10-28', 'Den vzniku státu'], ['11-17', 'Den boje za svobodu'],
  ['12-24', 'Štědrý den'], ['12-25', '1. svátek vánoční'], ['12-26', '2. svátek vánoční'],
];

/** The public holidays of a year by date, with their Czech names. */
export function czechHolidays(year: number): Record<string, string> {
  const easter = easterSunday(year);
  const days: Record<string, string> = Object.fromEntries(FIXED.map(([day, name]) => [`${year}-${day}`, name]));
  days[shift(easter, -2)] = 'Velký pátek';
  days[shift(easter, 1)] = 'Velikonoční pondělí';
  return days;
}

/** The holiday's name on a date, or null. */
export function holidayName(date: string): string | null {
  return czechHolidays(Number(date.slice(0, 4)))[date] ?? null;
}
