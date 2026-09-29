// Calendar helpers. Calendar dates are `YYYY-MM-DD` strings in the athlete's
// local calendar (supplied by the client as `today`); the arithmetic here runs
// in UTC at noon so DST and timezone offsets can never shift a date.

/** One week in milliseconds. */
export const WEEK_MS = 7 * 86400000;

/** Six-week training cycles: cycle/week arithmetic is done on absolute week numbers. */
const WEEKS_PER_CYCLE = 6;
/** About 23 years of six-week cycles; bounds dashboard allocation even after elapsed time. */
export const MAX_PROGRAM_CYCLES = 200;

function boundedWeek(value: number): number {
  return Math.min(MAX_PROGRAM_CYCLES * WEEKS_PER_CYCLE - 1, Math.max(0, value));
}

export function isoWeekKey(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 12));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function mondayDate(value: string): Date {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date;
}

export function datedProgramState(
  state: { currentCycle: number; currentWeek: number; updatedAt: Date },
  today: string,
): { currentCycle: number; currentWeek: number } {
  const anchorMonday = mondayDate(state.updatedAt.toISOString().slice(0, 10));
  const todayMonday = mondayDate(today);
  const elapsedWeeks = Math.max(0, Math.floor((todayMonday.getTime() - anchorMonday.getTime()) / WEEK_MS));
  const absoluteWeek = boundedWeek(((state.currentCycle - 1) * WEEKS_PER_CYCLE) + (state.currentWeek - 1) + elapsedWeeks);
  return { currentCycle: Math.floor(absoluteWeek / WEEKS_PER_CYCLE) + 1, currentWeek: (absoluteWeek % WEEKS_PER_CYCLE) + 1 };
}

export function shiftProgramState(
  state: { currentCycle: number; currentWeek: number },
  delta: number,
): { currentCycle: number; currentWeek: number } {
  const absoluteWeek = boundedWeek(((state.currentCycle - 1) * WEEKS_PER_CYCLE) + (state.currentWeek - 1) + delta);
  return { currentCycle: Math.floor(absoluteWeek / WEEKS_PER_CYCLE) + 1, currentWeek: (absoluteWeek % WEEKS_PER_CYCLE) + 1 };
}

export function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function dateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}
