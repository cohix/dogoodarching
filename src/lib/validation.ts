// Every Zod schema and enum used by the API, in one place. The write endpoints
// and the import path share these so they can never accept different shapes.

import { z } from "zod";
import { MAX_PROGRAM_CYCLES } from "./dates";

// ---------------------------------------------------------------------------
// Enums and primitives
// ---------------------------------------------------------------------------

export const sessionType = z.enum(["Range", "Gym", "SPT", "Class", "Other"]);
export const planDayKey = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const attachmentKind = z.enum(["document", "photo", "link"]);
export const maintenanceSection = z.enum(["Weekly", "Monthly", "Quarterly"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date in the athlete's local calendar, `YYYY-MM-DD`. */
export const dateInput = z.string().regex(DATE_PATTERN).refine((value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, { message: "Invalid calendar date" });

/** Optional `?today=YYYY-MM-DD` query accepted by dashboard-style reads. */
export const todayQuery = z.object({
  today: z.string().refine(value => dateInput.safeParse(value).success, { message: "Invalid today parameter" }).optional(),
});

/** Exclusive descending (session_date, id) boundary, built from the last row. */
export const sessionCursor = z.string().regex(/^\d{4}-\d{2}-\d{2},[1-9]\d*$/, {
  message: "Invalid before parameter",
}).refine((value) => {
  const [date, id] = value.split(",");
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isSafeInteger(Number(id)) && !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === date;
}, { message: "Invalid before parameter" }).transform((value) => {
  const [sessionDate, id] = value.split(",");
  return { sessionDate, id: Number(id) };
});

export const trackerQuery = todayQuery.extend({ before: sessionCursor.optional() });
export type SessionCursor = z.infer<typeof sessionCursor>;

/** ISO date-time string, as written by export. */
export const isoDateTime = z.iso.datetime();

// Only http/https links may be stored; anything else (javascript:, data:, …)
// is rejected server-side so a stored URL can never become an XSS vector.
export const httpUrl = z.string().url().max(2000).refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, { message: "Use an http or https link" });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const usernameSchema = z.string().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, {
  message: "Username must be 3-32 characters: letters, numbers, _ or -",
});
// Max length bounds PBKDF2 input so a multi-megabyte password can't burn CPU.
export const passwordSchema = z.string().min(8, { message: "Password must be at least 8 characters" }).max(128, {
  message: "Password must be at most 128 characters",
});

export const credentialsInput = z.object({ username: usernameSchema, password: passwordSchema });
export const createInviteInput = z.object({ role: z.enum(["athlete", "coach"]).default("athlete") });
export const acceptInviteInput = z.object({
  token: z.string().min(1),
  username: usernameSchema,
  password: passwordSchema,
});

/**
 * A password being verified (not set): only bounded, so an account whose
 * password predates today's minimum length can still confirm it. New
 * passwords always use `passwordSchema`.
 */
export const currentPasswordSchema = z.string().min(1, { message: "Password is required" }).max(128, {
  message: "Password must be at most 128 characters",
});

// Account lifecycle (0002 §7)
export const changePasswordInput = z.object({ currentPassword: currentPasswordSchema, newPassword: passwordSchema });
export const deleteAccountInput = z.object({ password: currentPasswordSchema });
export const transferOwnershipInput = z.object({
  coachId: z.string().min(1).max(64, { message: "Invalid coach id" }),
  password: currentPasswordSchema,
});
/** `GET /api/coach/athletes?include=deactivated` lists deactivated athletes too. */
export const athleteListQuery = z.object({
  include: z.enum(["deactivated"], { message: "Invalid include parameter" }).optional(),
});

export type CredentialsInput = z.infer<typeof credentialsInput>;
export type CreateInviteInput = z.infer<typeof createInviteInput>;
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;
export type DeleteAccountInput = z.infer<typeof deleteAccountInput>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipInput>;

// ---------------------------------------------------------------------------
// Training log: sessions, scores, weekly notes
// ---------------------------------------------------------------------------

export const sessionInput = z.object({
  sessionDate: dateInput,
  sessionType,
  customActivity: z.string().trim().max(80),
  arrows: z.number().int().min(0).max(1000),
  durationMinutes: z.number().int().min(0).max(1440),
  focus: z.string().max(200),
  score: z.string().max(100),
  notes: z.string().max(3000),
}).refine((value) => value.sessionType !== "Other" || value.customActivity.length > 0, { message: "Name the activity", path: ["customActivity"] });

const arrowValue = z.number().int().min(0).max(10);
const scoreEndInput = z.tuple([arrowValue, arrowValue, arrowValue]);

export const practiceScoreInput = z.object({
  scoreDate: dateInput,
  ends: z.array(scoreEndInput).length(10),
});

export const weeklyNoteInput = z.object({ today: dateInput, notes: z.string().max(8000) });

export type SessionInput = z.infer<typeof sessionInput>;
export type PracticeScoreInput = z.infer<typeof practiceScoreInput>;
export type WeeklyNoteInput = z.infer<typeof weeklyNoteInput>;

// ---------------------------------------------------------------------------
// Plan: planned sessions, cycle weeks, schedule adjustment, attachments
// ---------------------------------------------------------------------------

export const plannedSessionInput = z.object({
  dayKey: planDayKey,
  sessionType: z.string().trim().min(1).max(80),
  detail: z.string().trim().min(1).max(200),
  prescription: z.string().trim().min(1).max(3000),
});

export const plannedSessionLinkInput = z.object({
  dayKey: planDayKey,
  label: z.string().trim().min(1).max(160),
  url: httpUrl,
});

/** The only upload MIME allowlist; also used to sanitize legacy downloads. */
export const UPLOAD_MIME_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export function normalizeMimeType(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

export function effectiveFileMimeType(value: string): string {
  const normalized = normalizeMimeType(value);
  return (UPLOAD_MIME_TYPES as readonly string[]).includes(normalized) ? normalized : "application/octet-stream";
}

/** Raw upload metadata comes from the query string, never from the file body. */
export const plannedSessionFileInput = z.object({
  dayKey: planDayKey,
  kind: z.enum(["document", "photo"]),
  label: z.string().trim().min(1).max(160),
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

/** Bow poundage the athlete sets when `program_state.current_poundage` is still null (same bounds as setups). */
export const poundageInput = z.object({
  poundage: z.number().int().min(1).max(100),
  today: dateInput.default(() => new Date().toISOString().slice(0, 10)),
});

export type PlannedSessionInput = z.infer<typeof plannedSessionInput>;
export type PlannedSessionLinkInput = z.infer<typeof plannedSessionLinkInput>;
export type PlannedSessionFileInput = z.infer<typeof plannedSessionFileInput>;
export type CycleWeekPlanInput = z.infer<typeof cycleWeekPlanInput>;
export type AdjustInput = z.infer<typeof adjustInput>;
export type PoundageInput = z.infer<typeof poundageInput>;

// ---------------------------------------------------------------------------
// Checklists and maintenance
// ---------------------------------------------------------------------------

export const checkInput = z.object({
  group: z.enum(["milestone", "maintenance"]),
  key: z.string().min(1).max(120),
  checked: z.boolean(),
});

export const maintenanceItemInput = z.object({
  section: maintenanceSection,
  label: z.string().trim().min(1).max(160),
});

export const maintenanceItemLabelInput = z.object({ label: z.string().trim().min(1).max(160) });
export const maintenanceItemCheckInput = z.object({ checked: z.boolean() });
export const maintenanceSectionInput = z.object({ section: maintenanceSection });

export type CheckInput = z.infer<typeof checkInput>;
export type MaintenanceItemInput = z.infer<typeof maintenanceItemInput>;
export type MaintenanceSection = z.infer<typeof maintenanceSection>;

// ---------------------------------------------------------------------------
// Bow setups and inspiration
// ---------------------------------------------------------------------------

const setupFields = {
  poundage: z.number().int().min(1).max(100), name: z.string().min(1).max(80),
  limbRiser: z.string().max(500), tillerBolts: z.string().max(200), braceHeight: z.string().max(100),
  stringTwists: z.string().max(100), nockingPoint: z.string().max(100), centerShot: z.string().max(200),
  plunger: z.string().max(300), gripNotes: z.string().max(1000), stabilizer: z.string().max(500),
  clickerPosition: z.string().max(200), bareShaft: z.string().max(1000), walkBack: z.string().max(1000),
  arrowsInUse: z.string().max(500), sightMarks: z.record(z.string().max(100), z.string().max(500))
    .refine((marks) => Object.keys(marks).length <= 100, { message: "At most 100 sight marks" }),
};

export const setupInput = z.object({ id: z.number().int().positive().optional(), ...setupFields });
export const duplicateSetupInput = z.object({ poundage: z.number().int().min(1).max(100) });

/** Recipe fields: the one set of rules for check-in recipes and team meals. */
export const recipeInput = z.object({
  name: z.string().min(1).max(200),
  summary: z.string().min(1).max(1500),
  ingredients: z.string().min(1).max(3000),
  instructions: z.string().min(1).max(6000),
});

export const inspirationInput = z.object({
  thoughtText: z.string().min(1).max(3000),
  videoTitle: z.string().min(1).max(300),
  videoUrl: httpUrl,
  recipeName: recipeInput.shape.name,
  recipeSummary: recipeInput.shape.summary,
  recipeIngredients: recipeInput.shape.ingredients,
  recipeInstructions: recipeInput.shape.instructions,
});

/** `POST /api/coach/meals` and the full replace in `PUT /api/coach/meals/:id`. */
export const teamMealInput = recipeInput;

export type SetupInput = z.infer<typeof setupInput>;
export type InspirationInput = z.infer<typeof inspirationInput>;
export type RecipeInput = z.infer<typeof recipeInput>;
export type TeamMealInput = z.infer<typeof teamMealInput>;

// ---------------------------------------------------------------------------
// Transfer (import)
// ---------------------------------------------------------------------------

const sourceId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const created = { createdAt: isoDateTime };
const updated = { updatedAt: isoDateTime };
const importedCheck = z.object({ key: checkInput.shape.key, checked: checkInput.shape.checked, ...updated });
const sightMarksJson = z.string().max(64_000).refine((value) => {
  try { return setupFields.sightMarks.safeParse(JSON.parse(value)).success; } catch { return false; }
}, { message: "Sight marks must be a JSON object of strings (at most 100 marks)" });

// These row caps are structural ceilings; byte and atomic batch budgets can
// reject a smaller document. Legacy `entries` is intentionally stripped.
export const importPayloadSchema = z.object({
  version: z.literal(1),
  data: z.object({
    trainingSessions: z.array(sessionInput.safeExtend({ id: sourceId, ...created })).max(20_000),
    practiceScores: z.array(z.object({
      id: sourceId, scoreDate: dateInput, total: z.number().int().min(0).max(300), ...created,
    })).max(5_000),
    practiceScoreEnds: z.array(z.object({
      id: sourceId, scoreId: sourceId, endNumber: z.number().int().min(1).max(10),
      arrow1: arrowValue, arrow2: arrowValue, arrow3: arrowValue,
      endTotal: z.number().int().min(0).max(30),
    })).max(50_000),
    programState: z.object({
      currentPoundage: poundageInput.shape.poundage.nullable(),
      currentCycle: z.number().int().min(1).max(MAX_PROGRAM_CYCLES),
      currentWeek: cycleWeekPlanInput.shape.weekNumber, ...updated,
    }).nullable(),
    cycleWeekPlans: z.array(cycleWeekPlanInput.extend(updated)).max(6),
    plannedSessionOverrides: z.array(plannedSessionInput.extend(updated)).max(7),
    plannedSessionAttachments: z.array(plannedSessionLinkInput.extend({
      id: sourceId, kind: z.literal("link"), mimeType: z.string().max(100), ...created,
    })).max(5_000),
    milestoneChecks: z.array(importedCheck).max(5_000),
    maintenanceChecks: z.array(importedCheck).max(5_000),
    maintenanceItems: z.array(maintenanceItemInput.extend({
      id: sourceId, sortOrder: z.number().int().min(0).max(1_000_000), ...created, ...updated,
    })).max(5_000),
    inspirationEntries: z.array(inspirationInput.extend({ id: sourceId, ...updated })).max(5_000),
    weeklyNotes: z.array(z.object({
      id: sourceId, weekStart: dateInput, notes: weeklyNoteInput.shape.notes, ...created, ...updated,
    })).max(5_000),
    bowSetups: z.array(setupInput.omit({ sightMarks: true }).extend({
      id: sourceId, sightMarksJson, ...updated,
    })).max(1_000),
  }).superRefine((data, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    for (const [name, rows] of Object.entries(data)) {
      if (!Array.isArray(rows)) continue;
      const ids = new Set<number>();
      const keys = new Set<string | number>();
      const natural = ({ cycleWeekPlans: "weekNumber", plannedSessionOverrides: "dayKey", milestoneChecks: "key", maintenanceChecks: "key", weeklyNotes: "weekStart" } as Record<string, string>)[name];
      rows.forEach((row, index) => {
        if ("id" in row) {
          if (ids.has(row.id)) fail([name, index, "id"], "Duplicate source id");
          ids.add(row.id);
        }
        if (natural) {
          let key = (row as unknown as Record<string, string | number>)[natural];
          if (name === "maintenanceChecks" && typeof key === "string" && /^item:\d+$/.test(key)) key = `item:${Number(key.slice(5))}`;
          if (keys.has(key)) fail([name, index, natural], "Duplicate key");
          keys.add(key);
        }
      });
    }
    const scores = new Map(data.practiceScores.map((score) => [score.id, { numbers: new Set<number>(), total: 0 }]));
    data.practiceScoreEnds.forEach((end, index) => {
      const score = scores.get(end.scoreId);
      if (!score) { fail(["practiceScoreEnds", index, "scoreId"], "Score is absent"); return; }
      if (score.numbers.has(end.endNumber)) fail(["practiceScoreEnds", index, "endNumber"], "Duplicate score end");
      score.numbers.add(end.endNumber);
      const total = end.arrow1 + end.arrow2 + end.arrow3;
      if (end.endTotal !== total) fail(["practiceScoreEnds", index, "endTotal"], "Total does not match arrows");
      score.total += total;
    });
    data.practiceScores.forEach((score, index) => {
      const ends = scores.get(score.id)!;
      if (ends.numbers.size !== 10) fail(["practiceScores", index], "Each score needs ten unique ends (1–10)");
      if (ends.total !== score.total) fail(["practiceScores", index, "total"], "Total does not match arrows");
    });
    const items = new Set(data.maintenanceItems.map((item) => item.id));
    data.maintenanceChecks.forEach((check, index) => {
      const match = /^item:(\d+)$/.exec(check.key);
      if (match && !items.has(Number(match[1]))) fail(["maintenanceChecks", index, "key"], "Maintenance item is absent");
    });
  }),
});

export type ImportPayload = z.infer<typeof importPayloadSchema>;
export type ImportData = ImportPayload["data"];
