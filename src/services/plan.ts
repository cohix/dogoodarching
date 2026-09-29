// Training plan: program state (cycle/week/poundage), the weekly session
// template with per-day overrides, cycle-week focus plans and schedule
// adjustments. Coaches edit these for any athlete through the coach routes.

import { eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import { WEEK_MS, datedProgramState, mondayDate, shiftProgramState } from "../lib/dates";
import type { AdjustInput, CycleWeekPlanInput, PlannedSessionInput } from "../lib/validation";

/** Program state for a user with no `program_state` row: the only definition of these defaults. */
export const DEFAULT_PROGRAM_STATE = { currentPoundage: null, currentCycle: 1, currentWeek: 1 } as const;

export type ProgramState = {
  currentPoundage: number | null;
  currentCycle: number;
  currentWeek: number;
  updatedAt: Date;
};

/** A stored row, or the default anchored to the client's calendar day when there is none. */
export function programStateOrDefault(row: ProgramState | undefined, today: string): ProgramState {
  return row ?? { ...DEFAULT_PROGRAM_STATE, updatedAt: new Date(`${today}T12:00:00Z`) };
}

/** Stored program state, or the default anchored to the client's calendar day. */
export async function loadProgramState(db: Db, userId: string, today: string): Promise<ProgramState> {
  const rows = await db.select().from(schema.programState).where(eq(schema.programState.userId, userId)).limit(1);
  return programStateOrDefault(rows[0], today);
}

export const plannedSessionDefaults = [
  { dayKey: "mon", day: "Monday", short: "Mon", sessionType: "Practice", detail: "Technique practice", prescription: "Choose a focus for your practice." },
  { dayKey: "tue", day: "Tuesday", short: "Tue", sessionType: "Activity", detail: "General activity", prescription: "Choose an activity that suits your goals." },
  { dayKey: "wed", day: "Wednesday", short: "Wed", sessionType: "Practice", detail: "Skills practice", prescription: "Choose a skill to work on." },
  { dayKey: "thu", day: "Thursday", short: "Thu", sessionType: "Review", detail: "Review your progress", prescription: "Reflect on your practice and update your plan." },
  { dayKey: "fri", day: "Friday", short: "Fri", sessionType: "Activity", detail: "General activity", prescription: "Choose an activity that suits your goals." },
  { dayKey: "sat", day: "Saturday", short: "Sat", sessionType: "Practice", detail: "Open practice", prescription: "Plan a session around your current goals." },
  { dayKey: "sun", day: "Sunday", short: "Sun", sessionType: "Rest", detail: "Rest and reflect", prescription: "Take time to rest and plan the week ahead." },
] as const;

export async function savePlannedSessionFor(db: Db, userId: string, input: PlannedSessionInput) {
  const updatedAt = new Date();
  await db.insert(schema.plannedSessionOverrides).values({ userId, ...input, updatedAt })
    .onConflictDoUpdate({
      target: [schema.plannedSessionOverrides.userId, schema.plannedSessionOverrides.dayKey],
      set: { sessionType: input.sessionType, detail: input.detail, prescription: input.prescription, updatedAt },
    });
  return { ...input, updatedAt: updatedAt.toISOString() };
}

export async function saveCycleWeekPlanFor(db: Db, userId: string, input: CycleWeekPlanInput) {
  const updatedAt = new Date();
  await db.insert(schema.cycleWeekPlans).values({ userId, ...input, updatedAt })
    .onConflictDoUpdate({
      target: [schema.cycleWeekPlans.userId, schema.cycleWeekPlans.weekNumber],
      set: { primaryFocus: input.primaryFocus, backgroundFocusOne: input.backgroundFocusOne, backgroundFocusTwo: input.backgroundFocusTwo, updatedAt },
    });
  return { ...input, updatedAt: updatedAt.toISOString() };
}

/**
 * Set the athlete's current bow poundage. A user with no `program_state` row
 * gets one at the default cycle/week anchored to the client's calendar day;
 * an existing row keeps its cycle, week and anchor.
 */
export async function savePoundageFor(db: Db, userId: string, poundage: number, today: string) {
  await db.insert(schema.programState).values({
    userId,
    currentPoundage: poundage,
    currentCycle: DEFAULT_PROGRAM_STATE.currentCycle,
    currentWeek: DEFAULT_PROGRAM_STATE.currentWeek,
    updatedAt: new Date(`${today}T12:00:00Z`),
  }).onConflictDoUpdate({
    target: schema.programState.userId,
    set: { currentPoundage: poundage },
  });
  return { currentPoundage: poundage };
}

export async function adjustScheduleFor(db: Db, userId: string, input: AdjustInput) {
  const stored = await loadProgramState(db, userId, input.today);
  const calendarState = datedProgramState(stored, input.today);
  const adjustedState = input.adjustment === "skip"
    ? calendarState
    : shiftProgramState(calendarState, input.adjustment === "forward" ? 1 : -1);
  const currentMonday = mondayDate(input.today);
  const nextAnchor = input.adjustment === "skip"
    ? new Date(currentMonday.getTime() + WEEK_MS)
    : currentMonday;
  await db.insert(schema.programState).values({
    userId,
    currentPoundage: stored.currentPoundage,
    currentCycle: adjustedState.currentCycle,
    currentWeek: adjustedState.currentWeek,
    updatedAt: nextAnchor,
  }).onConflictDoUpdate({
    target: schema.programState.userId,
    set: { currentCycle: adjustedState.currentCycle, currentWeek: adjustedState.currentWeek, updatedAt: nextAnchor },
  });
  return { ...adjustedState, adjustment: input.adjustment };
}
