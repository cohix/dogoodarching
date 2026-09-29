// The aggregate dashboard payload behind GET /api/tracker, and the aggregate
// subset a coach may see. Plan and aggregate queries are shared; private log
// rows are loaded only by the athlete dashboard.

import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import { addUtcDays, dateKeyUtc, datedProgramState, isoWeekKey, mondayDate } from "../lib/dates";
import type { SessionCursor } from "../lib/validation";
import { attachmentUrl } from "./attachments";
import { loadProgramState, plannedSessionDefaults, programStateOrDefault } from "./plan";
import { toSetup } from "./setups";
import { listTeamMealRecipes } from "./team-meals";

const training = schema.trainingSessions;
// Group by the week's Monday in SQLite; use the shared ISO helper only to
// format the bounded aggregate rows, including weeks across year boundaries.
const sessionWeekStart = sql<string>`date(${training.sessionDate}, '-' || ((cast(strftime('%w', ${training.sessionDate}) as integer) + 6) % 7) || ' days')`;

/** Monday of the first week of the calendar state's current cycle. */
function currentCycleStartFor(calendarState: { currentWeek: number }, today: string): Date {
  return addUtcDays(mondayDate(today), -(calendarState.currentWeek - 1) * 7);
}

/**
 * One six-week cycle's grid: arrows per week (from SQL weekly sums keyed by
 * `isoWeekKey`) and Monday–Saturday statuses (from distinct session dates).
 * The only definition of the week/day-status rules, shared by every view.
 */
function buildCycleSummary(cycle: number, cycleStart: Date, weekly: ReadonlyMap<string, number>, sessionDates: ReadonlySet<string>, today: string) {
  const todayDate = new Date(`${today}T12:00:00Z`);
  return {
    cycle,
    weeks: Array.from({ length: 6 }, (_unused, weekIndex) => {
      const weekStart = addUtcDays(cycleStart, weekIndex * 7);
      return {
        weekNumber: weekIndex + 1,
        weekStart: dateKeyUtc(weekStart),
        arrows: weekly.get(isoWeekKey(dateKeyUtc(weekStart))) ?? 0,
        dayStatuses: Array.from({ length: 6 }, (_day, dayIndex) => {
          const key = dateKeyUtc(addUtcDays(weekStart, dayIndex));
          return sessionDates.has(key) ? "completed" as const : new Date(`${key}T12:00:00Z`) < todayDate ? "skipped" as const : "upcoming" as const;
        }),
      };
    }),
  };
}

export type CycleSummary = ReturnType<typeof buildCycleSummary>;

/**
 * Current-cycle totals and averages, the one definition used wherever these
 * figures appear. Unrounded: clients round for display only.
 * `averagePerWeek` matches the athlete Dashboard's "Average / week";
 * `averagePerSession` is null when no session was logged this cycle.
 */
export function cycleFigures(input: { cycleArrows: number; cycleSessions: number; currentWeek: number }) {
  return {
    cycleArrows: input.cycleArrows,
    cycleSessions: input.cycleSessions,
    averagePerWeek: input.cycleArrows / Math.max(input.currentWeek, 1),
    averagePerSession: input.cycleSessions > 0 ? input.cycleArrows / input.cycleSessions : null,
  };
}

/** Shared coach-safe queries and formatting for both dashboard views. */
async function loadPlanAndAggregates(db: Db, userId: string, today: string) {
  const state = await loadProgramState(db, userId, today);
  const calendarState = datedProgramState(state, today);
  const currentCycleStart = currentCycleStartFor(calendarState, today);
  const firstCycleStart = dateKeyUtc(addUtcDays(currentCycleStart, -(calendarState.currentCycle - 1) * 42));
  const afterLastCycle = dateKeyUtc(addUtcDays(currentCycleStart, 42));
  const summaryRange = and(eq(training.userId, userId), gte(training.sessionDate, firstCycleStart), lt(training.sessionDate, afterLastCycle));
  const [weeklyPlanRows, plannedSessionRows, attachmentRows, weeklyRows, sessionDateRows] = await Promise.all([
    db.select().from(schema.cycleWeekPlans).where(eq(schema.cycleWeekPlans.userId, userId)).orderBy(asc(schema.cycleWeekPlans.weekNumber)),
    db.select().from(schema.plannedSessionOverrides).where(eq(schema.plannedSessionOverrides.userId, userId)),
    db.select().from(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.userId, userId)).orderBy(asc(schema.plannedSessionAttachments.id)),
    db.select({ weekStart: sessionWeekStart, arrows: sql<number>`sum(${training.arrows})`.mapWith(Number) }).from(training).where(summaryRange).groupBy(sessionWeekStart),
    db.selectDistinct({ sessionDate: training.sessionDate }).from(training).where(summaryRange),
  ]);
  const weekly = new Map(weeklyRows.map((row) => [isoWeekKey(row.weekStart), row.arrows]));
  const sessionDates = new Set(sessionDateRows.map((row) => row.sessionDate));
  const cycleSummaries = Array.from({ length: calendarState.currentCycle }, (_, cycleIndex) => {
    const cycle = cycleIndex + 1;
    return buildCycleSummary(cycle, addUtcDays(currentCycleStart, (cycle - calendarState.currentCycle) * 42), weekly, sessionDates, today);
  });
  const plannedSessions = plannedSessionDefaults.map((fallback) => {
    const saved = plannedSessionRows.find((row) => row.dayKey === fallback.dayKey);
    const attachments = attachmentRows.filter((row) => row.dayKey === fallback.dayKey);
    return {
      dayKey: fallback.dayKey,
      day: fallback.day,
      short: fallback.short,
      sessionType: saved?.sessionType ?? fallback.sessionType,
      detail: saved?.detail ?? fallback.detail,
      prescription: saved?.prescription ?? fallback.prescription,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        dayKey: fallback.dayKey,
        kind: attachment.kind,
        label: attachment.label,
        url: attachmentUrl(attachment),
        mimeType: attachment.mimeType,
        createdAt: attachment.createdAt.toISOString(),
      })),
    };
  });
  return {
    state: { currentPoundage: state.currentPoundage, currentCycle: calendarState.currentCycle, currentWeek: calendarState.currentWeek },
    weeklyPlans: weeklyPlanRows.map((row) => ({
      weekNumber: row.weekNumber,
      primaryFocus: row.primaryFocus,
      backgroundFocusOne: row.backgroundFocusOne,
      backgroundFocusTwo: row.backgroundFocusTwo,
      updatedAt: row.updatedAt.toISOString(),
    })),
    plannedSessions,
    weeklyArrows: Array.from(weekly.entries()).sort(([a], [b]) => b.localeCompare(a)).slice(0, 8).reverse().map(([week, arrows]) => ({ week, arrows })),
    cycleSummaries,
  };
}

export async function getTrackerPayload(db: Db, userId: string, today: string, before?: SessionCursor) {
  const [planAndAggregates, sessions, practiceScores, milestones, maintenance, maintenanceItemRows, setups, inspirationRows, weeklyNoteRows, teamMeals] = await Promise.all([
    loadPlanAndAggregates(db, userId, today),
    db.select().from(training).where(and(eq(training.userId, userId), before
      ? or(lt(training.sessionDate, before.sessionDate), and(eq(training.sessionDate, before.sessionDate), lt(training.id, before.id)))
      : undefined)).orderBy(desc(training.sessionDate), desc(training.id)).limit(100),
    db.select().from(schema.practiceScores).where(eq(schema.practiceScores.userId, userId)).orderBy(desc(schema.practiceScores.scoreDate), desc(schema.practiceScores.id)).limit(100),
    db.select().from(schema.milestoneChecks).where(eq(schema.milestoneChecks.userId, userId)),
    db.select().from(schema.maintenanceChecks).where(eq(schema.maintenanceChecks.userId, userId)),
    db.select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.userId, userId)).orderBy(asc(schema.maintenanceItems.sortOrder), asc(schema.maintenanceItems.id)),
    db.select().from(schema.bowSetups).where(eq(schema.bowSetups.userId, userId)).orderBy(asc(schema.bowSetups.poundage)),
    db.select().from(schema.inspirationEntries).where(eq(schema.inspirationEntries.userId, userId)).orderBy(desc(schema.inspirationEntries.updatedAt), desc(schema.inspirationEntries.id)),
    db.select().from(schema.weeklyNotes).where(eq(schema.weeklyNotes.userId, userId)).orderBy(desc(schema.weeklyNotes.weekStart)),
    listTeamMealRecipes(db),
  ]);
  // At most 100 IDs, split to leave room for userId within D1's bind limit.
  const scoreIds = practiceScores.map((score) => score.id);
  const scoreIdGroups = [scoreIds.slice(0, 50), scoreIds.slice(50)].filter((ids) => ids.length > 0);
  const practiceScoreEnds = (await Promise.all(scoreIdGroups.map((ids) =>
    db.select().from(schema.practiceScoreEnds)
      .where(and(eq(schema.practiceScoreEnds.userId, userId), inArray(schema.practiceScoreEnds.scoreId, ids)))
      .orderBy(asc(schema.practiceScoreEnds.endNumber)),
  ))).flat();
  const currentWeekStart = mondayDate(today).toISOString().slice(0, 10);
  const currentNote = weeklyNoteRows.find((row) => row.weekStart === currentWeekStart);
  const historicalWeeklyNotes = weeklyNoteRows.filter((row) => row.weekStart < currentWeekStart && row.notes.trim());
  return {
    ...planAndAggregates,
    sessions: sessions.map((row) => ({ id: row.id, sessionDate: row.sessionDate, sessionType: row.sessionType, customActivity: row.customActivity, arrows: row.arrows,
      durationMinutes: row.durationMinutes, focus: row.focus, score: row.score, notes: row.notes, createdAt: row.createdAt.toISOString() })),
    practiceScores: practiceScores.map((row) => ({
      id: row.id,
      scoreDate: row.scoreDate,
      total: row.total,
      averageArrow: row.total / 30,
      averageEnd: row.total / 10,
      ends: practiceScoreEnds.filter((end) => end.scoreId === row.id).map((end) => ({
        endNumber: end.endNumber,
        arrows: [end.arrow1, end.arrow2, end.arrow3] as [number, number, number],
        total: end.endTotal,
        averageArrow: end.endTotal / 3,
      })),
      createdAt: row.createdAt.toISOString(),
    })),
    currentWeeklyNote: currentNote
      ? { id: currentNote.id, weekStart: currentNote.weekStart, notes: currentNote.notes, updatedAt: currentNote.updatedAt.toISOString() }
      : { id: null, weekStart: currentWeekStart, notes: "", updatedAt: null },
    historicalWeeklyNotes: historicalWeeklyNotes.map((row) => ({
      id: row.id, weekStart: row.weekStart, notes: row.notes, updatedAt: row.updatedAt.toISOString(),
    })),
    milestoneChecks: Object.fromEntries(milestones.map((row) => [row.key, row.checked])),
    maintenanceChecks: Object.fromEntries(maintenance.map((row) => [row.key, row.checked])),
    maintenanceItems: maintenanceItemRows.map((item) => ({
      id: item.id,
      section: item.section,
      label: item.label,
      checked: maintenance.find((row) => row.key === `item:${item.id}`)?.checked
        ?? maintenance.find((row) => row.key === `${item.section}:${item.label}`)?.checked
        ?? false,
    })),
    setups: setups.map(toSetup),
    inspiration: inspirationRows[0] ? {
      thoughtText: inspirationRows[0].thoughtText,
      videoTitle: inspirationRows[0].videoTitle,
      videoUrl: inspirationRows[0].videoUrl,
      recipeName: inspirationRows[0].recipeName,
      recipeSummary: inspirationRows[0].recipeSummary,
      recipeIngredients: inspirationRows[0].recipeIngredients,
      recipeInstructions: inspirationRows[0].recipeInstructions,
      updatedAt: inspirationRows[0].updatedAt.toISOString(),
    } : null,
    // Own check-in recipes merged with team meals, newest first. Team meals
    // sort by created_at so an edit never moves one; ids of the two sources
    // collide, so clients key rows by `key`. `inspiration` above stays own-only.
    recipes: [
      ...inspirationRows.map((row) => ({
        key: `own:${row.id}`,
        source: "own" as const,
        id: row.id,
        name: row.recipeName,
        summary: row.recipeSummary,
        ingredients: row.recipeIngredients,
        instructions: row.recipeInstructions,
        author: null,
        updatedAt: row.updatedAt.toISOString(),
        sortAt: row.updatedAt.getTime(),
      })),
      ...teamMeals.map((meal) => ({
        key: `team:${meal.id}`,
        source: "team" as const,
        id: meal.id,
        name: meal.name,
        summary: meal.summary,
        ingredients: meal.ingredients,
        instructions: meal.instructions,
        author: meal.author,
        updatedAt: meal.updatedAt,
        sortAt: Date.parse(meal.createdAt),
      })),
    ].sort((a, b) => b.sortAt - a.sortAt || (a.source === b.source ? b.id - a.id : a.source === "team" ? -1 : 1))
      .map(({ sortAt: _sortAt, ...recipe }) => recipe),
  };
}

export type TrackerPayload = Awaited<ReturnType<typeof getTrackerPayload>>;

/** Only plan rows and bounded SQL aggregates are queried for coaches. */
export async function getCoachOverview(db: Db, athleteId: string, today: string) {
  return loadPlanAndAggregates(db, athleteId, today);
}

/**
 * Ids per `IN (...)` list in the team overview. Each chunk query binds its ids
 * plus two window dates, which stays under D1's 100 bound parameters.
 */
export const TEAM_OVERVIEW_ID_CHUNK = 90;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * Current-cycle overview of every active athlete for coach Today, ordered by
 * display name (the username; there is no separate display-name column), then
 * username. Same privacy boundary as `getCoachOverview`: program state, SQL
 * weekly arrow sums with a session COUNT, and distinct session dates only.
 *
 * Query count: one roster query, plus three grouped queries per chunk of
 * `TEAM_OVERVIEW_ID_CHUNK` athletes (never per athlete). Every athlete's current
 * cycle starts within the five weeks before this week's Monday, so one shared
 * date window covers all of them; weeks outside an athlete's own cycle are
 * dropped when the grid is built.
 */
export async function getCoachTeamOverview(db: Db, today: string) {
  const users = schema.users;
  const athletes = await db.select({ id: users.id, username: users.username }).from(users)
    .where(and(eq(users.role, "athlete"), isNull(users.deactivatedAt)))
    .orderBy(asc(sql`lower(${users.username})`), asc(users.username));
  if (athletes.length === 0) return { athletes: [] };
  const thisMonday = mondayDate(today);
  const windowStart = dateKeyUtc(addUtcDays(thisMonday, -35));
  const windowEnd = dateKeyUtc(addUtcDays(thisMonday, 42));
  const results = await Promise.all(chunks(athletes.map((athlete) => athlete.id), TEAM_OVERVIEW_ID_CHUNK).map((ids) => {
    const range = and(inArray(training.userId, ids), gte(training.sessionDate, windowStart), lt(training.sessionDate, windowEnd));
    return Promise.all([
      db.select({
        userId: schema.programState.userId,
        currentPoundage: schema.programState.currentPoundage,
        currentCycle: schema.programState.currentCycle,
        currentWeek: schema.programState.currentWeek,
        updatedAt: schema.programState.updatedAt,
      }).from(schema.programState).where(inArray(schema.programState.userId, ids)),
      db.select({
        userId: training.userId,
        weekStart: sessionWeekStart,
        arrows: sql<number>`sum(${training.arrows})`.mapWith(Number),
        sessions: sql<number>`count(${training.id})`.mapWith(Number),
      }).from(training).where(range).groupBy(training.userId, sessionWeekStart),
      db.selectDistinct({ userId: training.userId, sessionDate: training.sessionDate }).from(training).where(range),
    ]);
  }));
  const states = new Map(results.flatMap(([rows]) => rows.map((row) => [row.userId, row] as const)));
  const weeklyArrows = new Map<string, Map<string, number>>();
  const weeklySessions = new Map<string, Map<string, number>>();
  const sessionDates = new Map<string, Set<string>>();
  for (const [, weeklyRows, dateRows] of results) {
    for (const row of weeklyRows) {
      const week = isoWeekKey(row.weekStart);
      if (!weeklyArrows.has(row.userId)) { weeklyArrows.set(row.userId, new Map()); weeklySessions.set(row.userId, new Map()); }
      weeklyArrows.get(row.userId)!.set(week, row.arrows);
      weeklySessions.get(row.userId)!.set(week, row.sessions);
    }
    for (const row of dateRows) {
      if (!sessionDates.has(row.userId)) sessionDates.set(row.userId, new Set());
      sessionDates.get(row.userId)!.add(row.sessionDate);
    }
  }
  return {
    athletes: athletes.map((athlete) => {
      const state = programStateOrDefault(states.get(athlete.id), today);
      const calendarState = datedProgramState(state, today);
      const summary = buildCycleSummary(calendarState.currentCycle, currentCycleStartFor(calendarState, today),
        weeklyArrows.get(athlete.id) ?? new Map(), sessionDates.get(athlete.id) ?? new Set(), today);
      const sessions = weeklySessions.get(athlete.id);
      return {
        id: athlete.id,
        username: athlete.username,
        displayName: athlete.username,
        currentPoundage: state.currentPoundage,
        currentCycle: calendarState.currentCycle,
        currentWeek: calendarState.currentWeek,
        currentCycleSummary: summary,
        ...cycleFigures({
          cycleArrows: summary.weeks.reduce((total, week) => total + week.arrows, 0),
          cycleSessions: summary.weeks.reduce((total, week) => total + (sessions?.get(isoWeekKey(week.weekStart)) ?? 0), 0),
          currentWeek: calendarState.currentWeek,
        }),
      };
    }),
  };
}

export type CoachTeamOverview = Awaited<ReturnType<typeof getCoachTeamOverview>>;
