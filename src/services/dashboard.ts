// The aggregate dashboard payload behind GET /api/tracker, and the aggregate
// subset a coach may see. This is the only place private log rows are read
// alongside plan data; the coach overview never includes them.

import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import { addUtcDays, dateKeyUtc, datedProgramState, isoWeekKey, mondayDate } from "../lib/dates";
import type { SessionCursor } from "../lib/validation";
import { attachmentUrl } from "./attachments";
import { loadProgramState, plannedSessionDefaults } from "./plan";
import { toSetup } from "./setups";

export async function getTrackerPayload(db: Db, userId: string, today: string, before?: SessionCursor) {
  const state = await loadProgramState(db, userId, today);
  const calendarState = datedProgramState(state, today);
  const currentCycleStart = addUtcDays(mondayDate(today), -(calendarState.currentWeek - 1) * 7);
  const firstCycleStart = dateKeyUtc(addUtcDays(currentCycleStart, -(calendarState.currentCycle - 1) * 42));
  const afterLastCycle = dateKeyUtc(addUtcDays(currentCycleStart, 42));
  const training = schema.trainingSessions;
  const summaryRange = and(eq(training.userId, userId), gte(training.sessionDate, firstCycleStart), lt(training.sessionDate, afterLastCycle));
  // Group by the week's Monday in SQLite; use the shared ISO helper only to
  // format the bounded aggregate rows, including weeks across year boundaries.
  const weekStart = sql<string>`date(${training.sessionDate}, '-' || ((cast(strftime('%w', ${training.sessionDate}) as integer) + 6) % 7) || ' days')`;
  const [weeklyPlanRows, plannedSessionRows, attachmentRows, sessions, practiceScores, weeklyRows, sessionDateRows, milestones, maintenance, maintenanceItemRows, setups, inspirationRows, weeklyNoteRows] = await Promise.all([
    db.select().from(schema.cycleWeekPlans).where(eq(schema.cycleWeekPlans.userId, userId)).orderBy(asc(schema.cycleWeekPlans.weekNumber)),
    db.select().from(schema.plannedSessionOverrides).where(eq(schema.plannedSessionOverrides.userId, userId)),
    db.select().from(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.userId, userId)).orderBy(asc(schema.plannedSessionAttachments.id)),
    db.select().from(training).where(and(eq(training.userId, userId), before
      ? or(lt(training.sessionDate, before.sessionDate), and(eq(training.sessionDate, before.sessionDate), lt(training.id, before.id)))
      : undefined)).orderBy(desc(training.sessionDate), desc(training.id)).limit(100),
    db.select().from(schema.practiceScores).where(eq(schema.practiceScores.userId, userId)).orderBy(desc(schema.practiceScores.scoreDate), desc(schema.practiceScores.id)).limit(100),
    db.select({ weekStart, arrows: sql<number>`sum(${training.arrows})`.mapWith(Number) }).from(training).where(summaryRange).groupBy(weekStart),
    db.selectDistinct({ sessionDate: training.sessionDate }).from(training).where(summaryRange),
    db.select().from(schema.milestoneChecks).where(eq(schema.milestoneChecks.userId, userId)),
    db.select().from(schema.maintenanceChecks).where(eq(schema.maintenanceChecks.userId, userId)),
    db.select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.userId, userId)).orderBy(asc(schema.maintenanceItems.sortOrder), asc(schema.maintenanceItems.id)),
    db.select().from(schema.bowSetups).where(eq(schema.bowSetups.userId, userId)).orderBy(asc(schema.bowSetups.poundage)),
    db.select().from(schema.inspirationEntries).where(eq(schema.inspirationEntries.userId, userId)).orderBy(desc(schema.inspirationEntries.updatedAt), desc(schema.inspirationEntries.id)),
    db.select().from(schema.weeklyNotes).where(eq(schema.weeklyNotes.userId, userId)).orderBy(desc(schema.weeklyNotes.weekStart)),
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
  const weekly = new Map(weeklyRows.map((row) => [isoWeekKey(row.weekStart), row.arrows]));
  const sessionDates = new Set(sessionDateRows.map((row) => row.sessionDate));
  const todayDate = new Date(`${today}T12:00:00Z`);
  const cycleSummaries = Array.from({ length: calendarState.currentCycle }, (_, cycleIndex) => {
    const cycle = cycleIndex + 1;
    const cycleStart = addUtcDays(currentCycleStart, (cycle - calendarState.currentCycle) * 42);
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
    weeklyArrows: Array.from(weekly.entries()).sort(([a], [b]) => b.localeCompare(a)).slice(0, 8).reverse().map(([week, arrows]) => ({ week, arrows })),
    cycleSummaries,
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
    recipes: inspirationRows.map((row) => ({
      id: row.id,
      name: row.recipeName,
      summary: row.recipeSummary,
      ingredients: row.recipeIngredients,
      instructions: row.recipeInstructions,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export type TrackerPayload = Awaited<ReturnType<typeof getTrackerPayload>>;

/**
 * The coach-visible subset of an athlete's dashboard. RBAC: only plans and
 * aggregates leave here — never sessions, practice scores, weekly notes,
 * setups, maintenance, or inspiration.
 */
export async function getCoachOverview(db: Db, athleteId: string, today: string) {
  const payload = await getTrackerPayload(db, athleteId, today);
  return {
    state: payload.state,
    weeklyPlans: payload.weeklyPlans,
    plannedSessions: payload.plannedSessions,
    weeklyArrows: payload.weeklyArrows,
    cycleSummaries: payload.cycleSummaries,
  };
}
