// Personal tracker endpoints (operate on the caller's own data) plus the
// shared business-logic functions, factored to take an explicit targetUserId
// so the coach routes can reuse them for an athlete.

import type { Context } from "hono";
import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db, type Env } from "../db";
import { authMiddleware, type AppBindings } from "../lib/rbac";
import type { AuthUser } from "../lib/auth";

// ---------------------------------------------------------------------------
// Small HTTP helpers shared with the other route modules
// ---------------------------------------------------------------------------

export async function readJsonBody(c: Context<AppBindings>): Promise<unknown> {
  return c.req.json();
}

export function zodErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input";
}

// ---------------------------------------------------------------------------
// Input schemas (copied verbatim from the reference implementation)
// ---------------------------------------------------------------------------

const sessionType = z.enum(["Range", "Gym", "SPT", "Class", "Other"]);
const planDayKey = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const attachmentKind = z.enum(["document", "photo", "link"]);
const maintenanceSection = z.enum(["Weekly", "Monthly", "Quarterly"]);
export { sessionType, planDayKey, attachmentKind, maintenanceSection };
export const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const plannedSessionDefaults = [
  { dayKey: "mon", day: "Monday", short: "Mon", sessionType: "Gym", detail: "Strength & core", prescription: "Back-tension rows/pull-downs · planks & rotational chops · rotator cuff" },
  { dayKey: "tue", day: "Tuesday", short: "Tue", sessionType: "Range", detail: "100–150 arrows", prescription: "Begin with 30 blank-bale arrows, then apply the week’s focus" },
  { dayKey: "wed", day: "Wednesday", short: "Wed", sessionType: "SPT", detail: "Band workout at home", prescription: "Draws 3×8–10 (5s hold) · T-raises 3×12 · Y-press 3×10 · cuff rotations 3×15 · thoracic expansion 2×8 · dynamic release 3×6 · torso rotations 3×12/side · Holding Song 3m28s" },
  { dayKey: "thu", day: "Thursday", short: "Thu", sessionType: "Class", detail: "Class / Coaching", prescription: "Form review and video analysis" },
  { dayKey: "fri", day: "Friday", short: "Fri", sessionType: "Gym", detail: "Strength & core", prescription: "Back-tension rows/pull-downs · planks & rotational chops · rotator cuff" },
  { dayKey: "sat", day: "Saturday", short: "Sat", sessionType: "Range", detail: "100–150 arrows", prescription: "Begin with 30 blank-bale arrows, then apply the week’s focus" },
  { dayKey: "sun", day: "Sunday", short: "Sun", sessionType: "Rest", detail: "Rest", prescription: "Recovery day" },
] as const;

export const sessionInput = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessionType,
  customActivity: z.string().trim().max(80),
  arrows: z.number().int().min(0).max(1000),
  durationMinutes: z.number().int().min(0).max(1440),
  focus: z.string().max(200),
  score: z.string().max(100),
  notes: z.string().max(3000),
}).refine((value) => value.sessionType !== "Other" || value.customActivity.length > 0, { message: "Name the activity", path: ["customActivity"] });

const scoreEndInput = z.tuple([
  z.number().int().min(0).max(10),
  z.number().int().min(0).max(10),
  z.number().int().min(0).max(10),
]);

export const practiceScoreInput = z.object({
  scoreDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ends: z.array(scoreEndInput).length(10),
});

export const plannedSessionInput = z.object({
  dayKey: planDayKey,
  sessionType: z.string().trim().min(1).max(80),
  detail: z.string().trim().min(1).max(200),
  prescription: z.string().trim().min(1).max(3000),
});

// Only http/https links may be stored; anything else (javascript:, data:, …)
// is rejected server-side so a stored URL can never become an XSS vector.
const httpUrl = z.string().url().max(2000).refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, { message: "Use an http or https link" });

export const plannedSessionLinkInput = z.object({
  dayKey: planDayKey,
  label: z.string().trim().min(1).max(160),
  url: httpUrl,
});

export const plannedSessionFileInput = z.object({
  dayKey: planDayKey,
  kind: z.enum(["document", "photo"]),
  label: z.string().trim().min(1).max(160),
  // MIME type must look like "type/subtype" so the stored value can't be
  // smuggled into a download response as something unexpected.
  mimeType: z.string().trim().min(1).max(120).regex(/^[\w.+-]+\/[\w.+-]+$/, {
    message: "Invalid MIME type",
  }),
  dataBase64: z.string().min(1).max(12_000_000),
});

export const cycleWeekPlanInput = z.object({
  weekNumber: z.number().int().min(1).max(6),
  primaryFocus: z.string().trim().min(1).max(120),
  backgroundFocusOne: z.string().trim().max(160),
  backgroundFocusTwo: z.string().trim().max(160),
});

export const adjustInput = z.object({
  adjustment: z.enum(["skip", "forward", "back"]),
  today: dateInput,
});

export const checkInput = z.object({
  group: z.enum(["milestone", "maintenance"]),
  key: z.string().min(1).max(120),
  checked: z.boolean(),
});

export const maintenanceItemInput = z.object({
  section: maintenanceSection,
  label: z.string().trim().min(1).max(160),
});

const setupFields = {
  poundage: z.number().int().min(1).max(100), name: z.string().min(1).max(80),
  limbRiser: z.string().max(500), tillerBolts: z.string().max(200), braceHeight: z.string().max(100),
  stringTwists: z.string().max(100), nockingPoint: z.string().max(100), centerShot: z.string().max(200),
  plunger: z.string().max(300), gripNotes: z.string().max(1000), stabilizer: z.string().max(500),
  clickerPosition: z.string().max(200), bareShaft: z.string().max(1000), walkBack: z.string().max(1000),
  arrowsInUse: z.string().max(500), sightMarks: z.record(z.string(), z.string()),
};

export const setupInput = z.object({ id: z.number().int().positive().optional(), ...setupFields });

export const inspirationInput = z.object({
  thoughtText: z.string().min(1).max(3000),
  videoTitle: z.string().min(1).max(300),
  videoUrl: httpUrl,
  recipeName: z.string().min(1).max(200),
  recipeSummary: z.string().min(1).max(1500),
  recipeIngredients: z.string().min(1).max(3000),
  recipeInstructions: z.string().min(1).max(6000),
});

export const weeklyNoteInput = z.object({ today: dateInput, notes: z.string().max(8000) });

// ---------------------------------------------------------------------------
// Date helpers (copied verbatim from the reference implementation)
// ---------------------------------------------------------------------------

const weekMs = 7 * 86400000;

export function isoWeekKey(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
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
  const elapsedWeeks = Math.max(0, Math.floor((todayMonday.getTime() - anchorMonday.getTime()) / weekMs));
  const absoluteWeek = Math.max(0, ((state.currentCycle - 1) * 6) + (state.currentWeek - 1) + elapsedWeeks);
  return { currentCycle: Math.floor(absoluteWeek / 6) + 1, currentWeek: (absoluteWeek % 6) + 1 };
}

export function shiftProgramState(
  state: { currentCycle: number; currentWeek: number },
  delta: number,
): { currentCycle: number; currentWeek: number } {
  const absoluteWeek = Math.max(0, ((state.currentCycle - 1) * 6) + (state.currentWeek - 1) + delta);
  return { currentCycle: Math.floor(absoluteWeek / 6) + 1, currentWeek: (absoluteWeek % 6) + 1 };
}

export function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function dateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toSetup(row: typeof schema.bowSetups.$inferSelect) {
  let sightMarks: Record<string, string> = {};
  try { sightMarks = JSON.parse(row.sightMarksJson) as Record<string, string>; } catch { sightMarks = {}; }
  return { id: row.id, poundage: row.poundage, name: row.name, limbRiser: row.limbRiser, tillerBolts: row.tillerBolts,
    braceHeight: row.braceHeight, stringTwists: row.stringTwists, nockingPoint: row.nockingPoint, centerShot: row.centerShot,
    plunger: row.plunger, gripNotes: row.gripNotes, stabilizer: row.stabilizer, clickerPosition: row.clickerPosition,
    bareShaft: row.bareShaft, walkBack: row.walkBack, arrowsInUse: row.arrowsInUse, sightMarks, updatedAt: row.updatedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Shared business logic — every function takes an explicit targetUserId
// ---------------------------------------------------------------------------

export async function getTrackerPayload(db: Db, userId: string, today: string) {
  const [stateRows, weeklyPlanRows, plannedSessionRows, attachmentRows, allSessions, practiceScores, practiceScoreEnds, milestones, maintenance, maintenanceItemRows, setups, inspirationRows, weeklyNoteRows] = await Promise.all([
    db.select().from(schema.programState).where(eq(schema.programState.userId, userId)).limit(1),
    db.select().from(schema.cycleWeekPlans).where(eq(schema.cycleWeekPlans.userId, userId)).orderBy(asc(schema.cycleWeekPlans.weekNumber)),
    db.select().from(schema.plannedSessionOverrides).where(eq(schema.plannedSessionOverrides.userId, userId)),
    db.select().from(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.userId, userId)).orderBy(asc(schema.plannedSessionAttachments.id)),
    db.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId)).orderBy(desc(schema.trainingSessions.sessionDate), desc(schema.trainingSessions.id)),
    db.select().from(schema.practiceScores).where(eq(schema.practiceScores.userId, userId)).orderBy(desc(schema.practiceScores.scoreDate), desc(schema.practiceScores.id)).limit(100),
    db.select().from(schema.practiceScoreEnds).where(eq(schema.practiceScoreEnds.userId, userId)).orderBy(asc(schema.practiceScoreEnds.endNumber)),
    db.select().from(schema.milestoneChecks).where(eq(schema.milestoneChecks.userId, userId)),
    db.select().from(schema.maintenanceChecks).where(eq(schema.maintenanceChecks.userId, userId)),
    db.select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.userId, userId)).orderBy(asc(schema.maintenanceItems.sortOrder), asc(schema.maintenanceItems.id)),
    db.select().from(schema.bowSetups).where(eq(schema.bowSetups.userId, userId)).orderBy(asc(schema.bowSetups.poundage)),
    db.select().from(schema.inspirationEntries).where(eq(schema.inspirationEntries.userId, userId)).orderBy(desc(schema.inspirationEntries.updatedAt), desc(schema.inspirationEntries.id)),
    db.select().from(schema.weeklyNotes).where(eq(schema.weeklyNotes.userId, userId)).orderBy(desc(schema.weeklyNotes.weekStart)),
  ]);
  const state = stateRows[0] ?? { currentPoundage: 24, currentCycle: 2, currentWeek: 6, updatedAt: new Date() };
  const currentWeekStart = mondayDate(today).toISOString().slice(0, 10);
  const calendarState = datedProgramState(state, today);
  const currentNote = weeklyNoteRows.find((row) => row.weekStart === currentWeekStart);
  const historicalWeeklyNotes = weeklyNoteRows.filter((row) => row.weekStart < currentWeekStart && row.notes.trim());
  const weekly = new Map<string, number>();
  const sessionDates = new Set<string>();
  for (const row of allSessions) {
    weekly.set(isoWeekKey(row.sessionDate), (weekly.get(isoWeekKey(row.sessionDate)) ?? 0) + row.arrows);
    sessionDates.add(row.sessionDate);
  }
  const todayDate = new Date(`${today}T12:00:00Z`);
  const currentCycleStart = addUtcDays(mondayDate(today), -(calendarState.currentWeek - 1) * 7);
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
  const sessions = allSessions.slice(0, 100);
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
        url: attachment.kind === "link" ? attachment.url : `/api/plan/attachments/${attachment.id}/file`,
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

export async function saveWeeklyNoteFor(db: Db, userId: string, input: z.infer<typeof weeklyNoteInput>) {
  const weekStart = mondayDate(input.today).toISOString().slice(0, 10);
  const now = new Date();
  await db.insert(schema.weeklyNotes).values({ userId, weekStart, notes: input.notes, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [schema.weeklyNotes.userId, schema.weeklyNotes.weekStart], set: { notes: input.notes, updatedAt: now } });
  const rows = await db.select().from(schema.weeklyNotes)
    .where(and(eq(schema.weeklyNotes.userId, userId), eq(schema.weeklyNotes.weekStart, weekStart))).limit(1);
  const row = rows[0];
  if (!row) throw new Error("Weekly note could not be saved");
  return { id: row.id, weekStart: row.weekStart, notes: row.notes, updatedAt: row.updatedAt.toISOString() };
}

export async function addSessionFor(db: Db, userId: string, input: z.infer<typeof sessionInput>) {
  const result = await db.insert(schema.trainingSessions).values({ userId, ...input }).returning({ id: schema.trainingSessions.id });
  const row = result[0];
  if (!row) throw new Error("Session could not be saved");
  return { id: row.id };
}

export async function updateSessionFor(db: Db, userId: string, id: number, input: z.infer<typeof sessionInput>) {
  await db.update(schema.trainingSessions).set(input)
    .where(and(eq(schema.trainingSessions.id, id), eq(schema.trainingSessions.userId, userId)));
  return { ok: true as const };
}

export async function deleteSessionFor(db: Db, userId: string, id: number) {
  await db.delete(schema.trainingSessions)
    .where(and(eq(schema.trainingSessions.id, id), eq(schema.trainingSessions.userId, userId)));
  return { ok: true as const };
}

export async function addPracticeScoreFor(db: Db, userId: string, input: z.infer<typeof practiceScoreInput>) {
  const total = input.ends.reduce((sum, arrows) => sum + arrows.reduce((endSum, value) => endSum + value, 0), 0);
  const inserted = await db.insert(schema.practiceScores)
    .values({ userId, scoreDate: input.scoreDate, total, createdAt: new Date() })
    .returning({ id: schema.practiceScores.id });
  const score = inserted[0];
  if (!score) throw new Error("Practice score could not be saved");
  await db.insert(schema.practiceScoreEnds).values(input.ends.map((arrows, index) => ({
    userId,
    scoreId: score.id,
    endNumber: index + 1,
    arrow1: arrows[0],
    arrow2: arrows[1],
    arrow3: arrows[2],
    endTotal: arrows[0] + arrows[1] + arrows[2],
  })));
  return { id: score.id, total, averageArrow: total / 30 };
}

export async function deletePracticeScoreFor(db: Db, userId: string, id: number) {
  await (db as Db).batch([
    db.delete(schema.practiceScoreEnds).where(and(eq(schema.practiceScoreEnds.scoreId, id), eq(schema.practiceScoreEnds.userId, userId))),
    db.delete(schema.practiceScores).where(and(eq(schema.practiceScores.id, id), eq(schema.practiceScores.userId, userId))),
  ] as never);
  return { ok: true as const };
}

export async function savePlannedSessionFor(db: Db, userId: string, input: z.infer<typeof plannedSessionInput>) {
  const updatedAt = new Date();
  await db.insert(schema.plannedSessionOverrides).values({ userId, ...input, updatedAt })
    .onConflictDoUpdate({
      target: [schema.plannedSessionOverrides.userId, schema.plannedSessionOverrides.dayKey],
      set: { sessionType: input.sessionType, detail: input.detail, prescription: input.prescription, updatedAt },
    });
  return { ...input, updatedAt: updatedAt.toISOString() };
}

export async function addPlannedSessionLinkFor(db: Db, userId: string, input: z.infer<typeof plannedSessionLinkInput>) {
  const rows = await db.insert(schema.plannedSessionAttachments).values({
    userId, dayKey: input.dayKey, kind: "link", label: input.label, url: input.url, blobKey: "", mimeType: "text/uri-list", createdAt: new Date(),
  }).returning({ id: schema.plannedSessionAttachments.id });
  const row = rows[0];
  if (!row) throw new Error("Attachment could not be saved");
  return { id: row.id };
}

function safeFilename(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return base || "file";
}

export async function addPlannedSessionFileFor(
  env: Env, db: Db, userId: string, input: z.infer<typeof plannedSessionFileInput>,
) {
  const binary = atob(input.dataBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > 8_000_000) throw new Error("Attachment is larger than 8 MB");
  const blobKey = `attachments/${userId}/${crypto.randomUUID()}-${safeFilename(input.label)}`;
  await env.ATTACHMENTS.put(blobKey, bytes, { httpMetadata: { contentType: input.mimeType } });
  try {
    const rows = await db.insert(schema.plannedSessionAttachments).values({
      userId, dayKey: input.dayKey, kind: input.kind, label: input.label, url: "", blobKey, mimeType: input.mimeType, createdAt: new Date(),
    }).returning({ id: schema.plannedSessionAttachments.id });
    const row = rows[0];
    if (!row) throw new Error("Attachment could not be saved");
    return { id: row.id };
  } catch (error) {
    await env.ATTACHMENTS.delete(blobKey);
    throw error;
  }
}

export async function deletePlannedSessionAttachmentFor(env: Env, db: Db, userId: string, attachmentId: number) {
  const rows = await db.select().from(schema.plannedSessionAttachments)
    .where(and(eq(schema.plannedSessionAttachments.id, attachmentId), eq(schema.plannedSessionAttachments.userId, userId))).limit(1);
  const attachment = rows[0];
  if (!attachment) return false;
  if (attachment.blobKey) await env.ATTACHMENTS.delete(attachment.blobKey);
  await db.delete(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.id, attachmentId));
  return true;
}

/**
 * Loads an attachment for file download. Returns null unless the requester
 * is the owner or a coach of the owner.
 */
export async function getAttachmentForDownload(db: Db, attachmentId: number, requester: AuthUser) {
  const rows = await db.select().from(schema.plannedSessionAttachments)
    .where(eq(schema.plannedSessionAttachments.id, attachmentId)).limit(1);
  const attachment = rows[0];
  if (!attachment) return null;
  if (attachment.userId === requester.id) return attachment;
  if (requester.role === "coach") {
    const athletes = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.id, attachment.userId), eq(schema.users.role, "athlete"), eq(schema.users.coachId, requester.id))).limit(1);
    if (athletes[0]) return attachment;
  }
  return null;
}

export async function saveCycleWeekPlanFor(db: Db, userId: string, input: z.infer<typeof cycleWeekPlanInput>) {
  const updatedAt = new Date();
  await db.insert(schema.cycleWeekPlans).values({ userId, ...input, updatedAt })
    .onConflictDoUpdate({
      target: [schema.cycleWeekPlans.userId, schema.cycleWeekPlans.weekNumber],
      set: { primaryFocus: input.primaryFocus, backgroundFocusOne: input.backgroundFocusOne, backgroundFocusTwo: input.backgroundFocusTwo, updatedAt },
    });
  return { ...input, updatedAt: updatedAt.toISOString() };
}

export async function adjustScheduleFor(db: Db, userId: string, input: z.infer<typeof adjustInput>) {
  const rows = await db.select().from(schema.programState).where(eq(schema.programState.userId, userId)).limit(1);
  const stored = rows[0] ?? { currentPoundage: 24, currentCycle: 2, currentWeek: 6, updatedAt: new Date() };
  const calendarState = datedProgramState(stored, input.today);
  const adjustedState = input.adjustment === "skip"
    ? calendarState
    : shiftProgramState(calendarState, input.adjustment === "forward" ? 1 : -1);
  const currentMonday = mondayDate(input.today);
  const nextAnchor = input.adjustment === "skip"
    ? new Date(currentMonday.getTime() + weekMs)
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

export async function setCheckFor(db: Db, userId: string, input: z.infer<typeof checkInput>) {
  const table = input.group === "milestone" ? schema.milestoneChecks : schema.maintenanceChecks;
  await db.insert(table).values({ userId, key: input.key, checked: input.checked, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [table.userId, table.key], set: { checked: input.checked, updatedAt: new Date() } });
  return { ok: true as const };
}

export async function addMaintenanceItemFor(db: Db, userId: string, input: z.infer<typeof maintenanceItemInput>) {
  const existing = await db.select({ id: schema.maintenanceItems.id }).from(schema.maintenanceItems)
    .where(and(eq(schema.maintenanceItems.userId, userId), eq(schema.maintenanceItems.section, input.section)));
  const result = await db.insert(schema.maintenanceItems).values({
    userId,
    section: input.section,
    label: input.label,
    sortOrder: existing.length,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning({ id: schema.maintenanceItems.id });
  const row = result[0];
  if (!row) throw new Error("Maintenance item could not be saved");
  return { id: row.id };
}

export async function updateMaintenanceItemFor(db: Db, userId: string, id: number, label: string) {
  await db.update(schema.maintenanceItems).set({ label, updatedAt: new Date() })
    .where(and(eq(schema.maintenanceItems.id, id), eq(schema.maintenanceItems.userId, userId)));
  return { ok: true as const };
}

export async function deleteMaintenanceItemFor(db: Db, userId: string, id: number) {
  await (db as Db).batch([
    db.delete(schema.maintenanceChecks).where(and(eq(schema.maintenanceChecks.key, `item:${id}`), eq(schema.maintenanceChecks.userId, userId))),
    db.delete(schema.maintenanceItems).where(and(eq(schema.maintenanceItems.id, id), eq(schema.maintenanceItems.userId, userId))),
  ] as never);
  return { ok: true as const };
}

export async function setMaintenanceItemCheckedFor(db: Db, userId: string, id: number, checked: boolean) {
  await db.insert(schema.maintenanceChecks).values({ userId, key: `item:${id}`, checked, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.maintenanceChecks.userId, schema.maintenanceChecks.key],
      set: { checked, updatedAt: new Date() },
    });
  return { ok: true as const };
}

export async function clearMaintenanceSectionFor(db: Db, userId: string, section: z.infer<typeof maintenanceSection>) {
  const items = await db.select({ id: schema.maintenanceItems.id }).from(schema.maintenanceItems)
    .where(and(eq(schema.maintenanceItems.userId, userId), eq(schema.maintenanceItems.section, section)));
  for (const item of items) {
    await db.insert(schema.maintenanceChecks).values({ userId, key: `item:${item.id}`, checked: false, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.maintenanceChecks.userId, schema.maintenanceChecks.key],
        set: { checked: false, updatedAt: new Date() },
      });
  }
  return { ok: true as const };
}

export async function saveSetupFor(db: Db, userId: string, input: z.infer<typeof setupInput>) {
  const { id, sightMarks, ...fields } = input;
  const values = { ...fields, sightMarksJson: JSON.stringify(sightMarks), updatedAt: new Date() };
  if (id) {
    await db.update(schema.bowSetups).set(values)
      .where(and(eq(schema.bowSetups.id, id), eq(schema.bowSetups.userId, userId)));
    return { id };
  }
  const result = await db.insert(schema.bowSetups).values({ userId, ...values }).returning({ id: schema.bowSetups.id });
  const row = result[0];
  if (!row) throw new Error("Setup could not be saved");
  return { id: row.id };
}

export async function duplicateSetupFor(db: Db, userId: string, id: number, poundage: number) {
  const rows = await db.select().from(schema.bowSetups)
    .where(and(eq(schema.bowSetups.id, id), eq(schema.bowSetups.userId, userId))).limit(1);
  const source = rows[0];
  if (!source) return null;
  const { id: _id, userId: _userId, updatedAt: _updatedAt, ...copy } = source;
  const result = await db.insert(schema.bowSetups)
    .values({ ...copy, userId, poundage, name: `${poundage} lb setup`, updatedAt: new Date() })
    .returning({ id: schema.bowSetups.id });
  const row = result[0];
  if (!row) throw new Error("Setup could not be duplicated");
  return { id: row.id };
}

export async function addInspirationFor(db: Db, userId: string, input: z.infer<typeof inspirationInput>) {
  const updatedAt = new Date();
  await db.insert(schema.inspirationEntries).values({ userId, ...input, updatedAt });
  return { ...input, updatedAt: updatedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const tracker = new Hono<AppBindings>();

tracker.use("*", authMiddleware);

function userIdOf(c: Context<AppBindings>): string {
  return c.get("user").id;
}

function parsePositiveInt(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

tracker.get("/tracker", async (c) => {
  const parsed = dateInput.optional().safeParse(c.req.query("today") ?? undefined);
  if (!parsed.success) return c.json({ error: "Invalid today parameter" }, 400);
  const today = parsed.data ?? new Date().toISOString().slice(0, 10);
  return c.json(await getTrackerPayload(getDb(c.env.DB), userIdOf(c), today));
});

tracker.post("/notes/weekly", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = weeklyNoteInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await saveWeeklyNoteFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/sessions", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = sessionInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await addSessionFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.put("/sessions/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid session id" }, 400);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = sessionInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await updateSessionFor(getDb(c.env.DB), userIdOf(c), id, parsed.data));
});

tracker.delete("/sessions/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid session id" }, 400);
  return c.json(await deleteSessionFor(getDb(c.env.DB), userIdOf(c), id));
});

tracker.post("/scores", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = practiceScoreInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await addPracticeScoreFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.delete("/scores/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid score id" }, 400);
  return c.json(await deletePracticeScoreFor(getDb(c.env.DB), userIdOf(c), id));
});

tracker.post("/plan/sessions", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = plannedSessionInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await savePlannedSessionFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/plan/sessions/links", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = plannedSessionLinkInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await addPlannedSessionLinkFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/plan/sessions/files", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = plannedSessionFileInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  try {
    return c.json(await addPlannedSessionFileFor(c.env, getDb(c.env.DB), userIdOf(c), parsed.data));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Upload failed" }, 400);
  }
});

tracker.delete("/plan/attachments/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid attachment id" }, 400);
  const deleted = await deletePlannedSessionAttachmentFor(c.env, getDb(c.env.DB), userIdOf(c), id);
  if (!deleted) return c.json({ error: "Attachment not found" }, 404);
  return c.json({ ok: true });
});

tracker.get("/plan/attachments/:id/file", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid attachment id" }, 400);
  const attachment = await getAttachmentForDownload(getDb(c.env.DB), id, c.get("user"));
  if (!attachment || attachment.kind === "link" || !attachment.blobKey) {
    return c.json({ error: "File not found" }, 404);
  }
  const object = await c.env.ATTACHMENTS.get(attachment.blobKey);
  if (!object) return c.json({ error: "File not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.mimeType || "application/octet-stream",
      "Content-Length": String(object.size),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(attachment.label)}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

tracker.post("/plan/weeks", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = cycleWeekPlanInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await saveCycleWeekPlanFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/plan/adjust", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = adjustInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await adjustScheduleFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/checks", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = checkInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await setCheckFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/maintenance/items", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = maintenanceItemInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await addMaintenanceItemFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.put("/maintenance/items/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid item id" }, 400);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = z.object({ label: z.string().trim().min(1).max(160) }).safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await updateMaintenanceItemFor(getDb(c.env.DB), userIdOf(c), id, parsed.data.label));
});

tracker.delete("/maintenance/items/:id", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid item id" }, 400);
  return c.json(await deleteMaintenanceItemFor(getDb(c.env.DB), userIdOf(c), id));
});

tracker.post("/maintenance/items/:id/check", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid item id" }, 400);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = z.object({ checked: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await setMaintenanceItemCheckedFor(getDb(c.env.DB), userIdOf(c), id, parsed.data.checked));
});

tracker.post("/maintenance/sections/clear", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = z.object({ section: maintenanceSection }).safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await clearMaintenanceSectionFor(getDb(c.env.DB), userIdOf(c), parsed.data.section));
});

tracker.post("/setups", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = setupInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await saveSetupFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

tracker.post("/setups/:id/duplicate", async (c) => {
  const id = parsePositiveInt(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid setup id" }, 400);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = z.object({ poundage: z.number().int().min(1).max(100) }).safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  const result = await duplicateSetupFor(getDb(c.env.DB), userIdOf(c), id, parsed.data.poundage);
  if (!result) return c.json({ error: "Setup not found" }, 404);
  return c.json(result);
});

tracker.post("/inspiration", async (c) => {
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = inspirationInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await addInspirationFor(getDb(c.env.DB), userIdOf(c), parsed.data));
});

export default tracker;
