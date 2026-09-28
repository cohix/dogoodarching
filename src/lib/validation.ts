// Every Zod schema and enum used by the API, in one place. The write endpoints
// and the import path share these so they can never accept different shapes.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums and primitives
// ---------------------------------------------------------------------------

export const sessionType = z.enum(["Range", "Gym", "SPT", "Class", "Other"]);
export const planDayKey = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const attachmentKind = z.enum(["document", "photo", "link"]);
export const maintenanceSection = z.enum(["Weekly", "Monthly", "Quarterly"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date in the athlete's local calendar, `YYYY-MM-DD`. */
export const dateInput = z.string().regex(DATE_PATTERN);

/** Optional `?today=YYYY-MM-DD` query accepted by dashboard-style reads. */
export const todayQuery = z.object({
  today: z.string().regex(DATE_PATTERN, { message: "Invalid today parameter" }).optional(),
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
export const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date" });

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

export type CredentialsInput = z.infer<typeof credentialsInput>;
export type CreateInviteInput = z.infer<typeof createInviteInput>;
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;

// ---------------------------------------------------------------------------
// Training log: sessions, scores, weekly notes
// ---------------------------------------------------------------------------

export const sessionInput = z.object({
  sessionDate: z.string().regex(DATE_PATTERN),
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
  scoreDate: z.string().regex(DATE_PATTERN),
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
  arrowsInUse: z.string().max(500), sightMarks: z.record(z.string(), z.string()),
};

export const setupInput = z.object({ id: z.number().int().positive().optional(), ...setupFields });
export const duplicateSetupInput = z.object({ poundage: z.number().int().min(1).max(100) });

export const inspirationInput = z.object({
  thoughtText: z.string().min(1).max(3000),
  videoTitle: z.string().min(1).max(300),
  videoUrl: httpUrl,
  recipeName: z.string().min(1).max(200),
  recipeSummary: z.string().min(1).max(1500),
  recipeIngredients: z.string().min(1).max(3000),
  recipeInstructions: z.string().min(1).max(6000),
});

export type SetupInput = z.infer<typeof setupInput>;
export type InspirationInput = z.infer<typeof inspirationInput>;

// ---------------------------------------------------------------------------
// Transfer (import)
// ---------------------------------------------------------------------------

export const importPayloadSchema = z.object({
  version: z.literal(1),
  data: z.object({
    trainingSessions: z.array(z.object({
      id: z.number().int(), sessionDate: z.string(), sessionType, customActivity: z.string(),
      arrows: z.number().int(), durationMinutes: z.number().int(), focus: z.string(), score: z.string(),
      notes: z.string(), createdAt: isoDateTime,
    })),
    practiceScores: z.array(z.object({
      id: z.number().int(), scoreDate: z.string(), total: z.number().int(), createdAt: isoDateTime,
    })),
    practiceScoreEnds: z.array(z.object({
      id: z.number().int(), scoreId: z.number().int(), endNumber: z.number().int(), arrow1: z.number().int(),
      arrow2: z.number().int(), arrow3: z.number().int(), endTotal: z.number().int(),
    })),
    programState: z.object({
      currentPoundage: z.number().int().nullable(), currentCycle: z.number().int(), currentWeek: z.number().int(),
      updatedAt: isoDateTime,
    }).nullable(),
    cycleWeekPlans: z.array(z.object({
      weekNumber: z.number().int(), primaryFocus: z.string(), backgroundFocusOne: z.string(),
      backgroundFocusTwo: z.string(), updatedAt: isoDateTime,
    })),
    plannedSessionOverrides: z.array(z.object({
      dayKey: planDayKey, sessionType: z.string(), detail: z.string(), prescription: z.string(),
      updatedAt: isoDateTime,
    })),
    plannedSessionAttachments: z.array(z.object({
      id: z.number().int(), dayKey: planDayKey, kind: attachmentKind,
      label: z.string(), url: z.string(), mimeType: z.string(), createdAt: isoDateTime,
    })),
    milestoneChecks: z.array(z.object({ key: z.string(), checked: z.boolean(), updatedAt: isoDateTime })),
    maintenanceChecks: z.array(z.object({ key: z.string(), checked: z.boolean(), updatedAt: isoDateTime })),
    maintenanceItems: z.array(z.object({
      id: z.number().int(), section: maintenanceSection, label: z.string(),
      sortOrder: z.number().int(), createdAt: isoDateTime, updatedAt: isoDateTime,
    })),
    inspirationEntries: z.array(z.object({
      id: z.number().int(), thoughtText: z.string(), videoTitle: z.string(), videoUrl: z.string(),
      recipeName: z.string(), recipeSummary: z.string(), recipeIngredients: z.string(),
      recipeInstructions: z.string(), updatedAt: isoDateTime,
    })),
    weeklyNotes: z.array(z.object({
      id: z.number().int(), weekStart: z.string(), notes: z.string(),
      createdAt: isoDateTime, updatedAt: isoDateTime,
    })),
    bowSetups: z.array(z.object({
      id: z.number().int(), poundage: z.number().int(), name: z.string(), limbRiser: z.string(),
      tillerBolts: z.string(), braceHeight: z.string(), stringTwists: z.string(), nockingPoint: z.string(),
      centerShot: z.string(), plunger: z.string(), gripNotes: z.string(), stabilizer: z.string(),
      clickerPosition: z.string(), bareShaft: z.string(), walkBack: z.string(), arrowsInUse: z.string(),
      sightMarksJson: z.string(), updatedAt: isoDateTime,
    })),
    // Zod strips unknown keys, including entries from legacy version-1 exports.
  }),
});

export type ImportPayload = z.infer<typeof importPayloadSchema>;
export type ImportData = ImportPayload["data"];
