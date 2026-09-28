import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Auth tables (new for the Cloudflare fork)
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["coach", "athlete"] }).notNull(),
  coachId: text("coach_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(), // epoch ms
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  coachId: text("coach_id").notNull(),
  expiresAt: integer("expires_at").notNull(), // epoch ms
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStart: integer("window_start").notNull(), // epoch ms
});

// ---------------------------------------------------------------------------
// Tracker tables (ported from the reference schema, each scoped by user_id)
// ---------------------------------------------------------------------------

export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const trainingSessions = sqliteTable("training_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  sessionDate: text("session_date").notNull(),
  sessionType: text("session_type", { enum: ["Range", "Gym", "SPT", "Class", "Other"] }).notNull(),
  customActivity: text("custom_activity").notNull().default(""),
  arrows: integer("arrows").notNull().default(0),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  focus: text("focus").notNull().default(""),
  score: text("score").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const programState = sqliteTable("program_state", {
  userId: text("user_id").primaryKey(),
  currentPoundage: integer("current_poundage").notNull(),
  currentCycle: integer("current_cycle").notNull(),
  currentWeek: integer("current_week").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const cycleWeekPlans = sqliteTable("cycle_week_plans", {
  userId: text("user_id").notNull(),
  weekNumber: integer("week_number").notNull(),
  primaryFocus: text("primary_focus").notNull(),
  backgroundFocusOne: text("background_focus_one").notNull().default(""),
  backgroundFocusTwo: text("background_focus_two").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.weekNumber] })]);

export const plannedSessionOverrides = sqliteTable("planned_session_overrides", {
  userId: text("user_id").notNull(),
  dayKey: text("day_key").notNull(),
  sessionType: text("session_type").notNull(),
  detail: text("detail").notNull(),
  prescription: text("prescription").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.dayKey] })]);

export const plannedSessionAttachments = sqliteTable("planned_session_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  dayKey: text("day_key").notNull(),
  kind: text("kind", { enum: ["document", "photo", "link"] }).notNull(),
  label: text("label").notNull(),
  url: text("url").notNull().default(""),
  blobKey: text("blob_key").notNull().default(""),
  mimeType: text("mime_type").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const milestoneChecks = sqliteTable("milestone_checks", {
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  checked: integer("checked", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.key] })]);

export const maintenanceChecks = sqliteTable("maintenance_checks", {
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  checked: integer("checked", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.key] })]);

export const maintenanceItems = sqliteTable("maintenance_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  section: text("section", { enum: ["Weekly", "Monthly", "Quarterly"] }).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const inspirationEntries = sqliteTable("inspiration_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  thoughtText: text("thought_text").notNull(),
  videoTitle: text("video_title").notNull(),
  videoUrl: text("video_url").notNull(),
  recipeName: text("recipe_name").notNull(),
  recipeSummary: text("recipe_summary").notNull(),
  recipeIngredients: text("recipe_ingredients").notNull(),
  recipeInstructions: text("recipe_instructions").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const weeklyNotes = sqliteTable("weekly_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  weekStart: text("week_start").notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [unique("weekly_notes_user_week_unique").on(t.userId, t.weekStart)]);

export const practiceScores = sqliteTable("practice_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  scoreDate: text("score_date").notNull(),
  total: integer("total").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const practiceScoreEnds = sqliteTable("practice_score_ends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  scoreId: integer("score_id").notNull().references(() => practiceScores.id, { onDelete: "cascade" }),
  endNumber: integer("end_number").notNull(),
  arrow1: integer("arrow_1").notNull(),
  arrow2: integer("arrow_2").notNull(),
  arrow3: integer("arrow_3").notNull(),
  endTotal: integer("end_total").notNull(),
});

export const bowSetups = sqliteTable("bow_setups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  poundage: integer("poundage").notNull(),
  name: text("name").notNull(),
  limbRiser: text("limb_riser").notNull().default(""),
  tillerBolts: text("tiller_bolts").notNull().default(""),
  braceHeight: text("brace_height").notNull().default(""),
  stringTwists: text("string_twists").notNull().default(""),
  nockingPoint: text("nocking_point").notNull().default(""),
  centerShot: text("center_shot").notNull().default(""),
  plunger: text("plunger").notNull().default(""),
  gripNotes: text("grip_notes").notNull().default(""),
  stabilizer: text("stabilizer").notNull().default(""),
  clickerPosition: text("clicker_position").notNull().default(""),
  bareShaft: text("bare_shaft").notNull().default(""),
  walkBack: text("walk_back").notNull().default(""),
  arrowsInUse: text("arrows_in_use").notNull().default(""),
  sightMarksJson: text("sight_marks_json").notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
