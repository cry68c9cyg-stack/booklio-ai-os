import {localTime} from './time.ts';

/** One local day of the forecast from MET Norway (api.met.no, free also for businesses, CC BY 4.0; no key, identified by User-Agent). */
export type WeatherDay = {date: string; minC: number; maxC: number; rainMm: number; symbol: string | null};

export const WEATHER_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
/** MET Norway's terms: identify the application with a contact. */
export const WEATHER_AGENT = 'OKO1 https://oko1.rr7whdyyhf.workers.dev';

type Step = {time?: unknown; data?: {instant?: {details?: {air_temperature?: unknown}};
  next_1_hours?: {summary?: {symbol_code?: unknown}; details?: {precipitation_amount?: unknown}};
  next_6_hours?: {summary?: {symbol_code?: unknown}; details?: {precipitation_amount?: unknown}}}};
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const code = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null;

/**
 * Local days from a locationforecast answer: lowest and highest temperature, rain summed without overlaps
 * (hourly steps while they last, then the 6-hour steps) and the symbol around noon. Anything unexpected is skipped.
 */
export function weatherDays(answer: unknown, timeZone: string): WeatherDay[] {
  const steps = (answer as {properties?: {timeseries?: unknown}})?.properties?.timeseries;
  if (!Array.isArray(steps)) return [];
  const days = new Map<string, WeatherDay & {noon: number}>();
  for (const step of steps.slice(0, 200) as Step[]) {
    const at = typeof step?.time === 'string' ? new Date(step.time) : null;
    const temperature = num(step?.data?.instant?.details?.air_temperature);
    if (!at || Number.isNaN(at.getTime()) || temperature === null) continue;
    const local = localTime(at, timeZone);
    const day = days.get(local.date) ?? {date: local.date, minC: temperature, maxC: temperature, rainMm: 0, symbol: null, noon: 99};
    day.minC = Math.min(day.minC, temperature); day.maxC = Math.max(day.maxC, temperature);
    const hour = step.data?.next_1_hours, six = step.data?.next_6_hours;
    day.rainMm += num(hour ? hour.details?.precipitation_amount : six?.details?.precipitation_amount) ?? 0;
    const symbol = code(hour?.summary?.symbol_code) ?? code(six?.summary?.symbol_code);
    if (symbol && Math.abs(local.hour - 12) < day.noon) { day.symbol = symbol; day.noon = Math.abs(local.hour - 12); }
    days.set(local.date, day);
  }
  return [...days.values()].map(({noon: _noon, ...day}) => ({...day, minC: Math.round(day.minC), maxC: Math.round(day.maxC), rainMm: Math.round(day.rainMm * 10) / 10}));
}

const SYMBOLS: [RegExp, string][] = [
  [/thunder/, 'bouřky'], [/sleet/, 'déšť se sněhem'], [/snow/, 'sníh'], [/^heavyrain/, 'silný déšť'], [/^lightrain/, 'slabý déšť'],
  [/rainshowers/, 'přeháňky'], [/rain/, 'déšť'], [/^fog/, 'mlha'], [/^cloudy/, 'zataženo'], [/^partlycloudy/, 'polojasno'],
  [/^fair/, 'skoro jasno'], [/^clearsky/, 'jasno'],
];
/** "14 °C, slabý déšť" – the day's highest temperature and its weather in Czech. */
export function weatherText(day: WeatherDay): string {
  const words = day.symbol ? SYMBOLS.find(([pattern]) => pattern.test(day.symbol!))?.[1] : undefined;
  return `${day.maxC} °C${words ? `, ${words}` : ''}`;
}
