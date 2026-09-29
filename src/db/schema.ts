// Instants are epoch-ms INTEGERs mapped with timestamp_ms. Calendar dates are
// YYYY-MM-DD strings in the athlete's local calendar, supplied by the client as today.
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Auth tables (new for the Cloudflare fork)
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").notNull(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["coach", "athlete"] }).notNull(),
  isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  invitedBy: text("invited_by").references((): AnySQLiteColumn => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  // Athletes only (0002 §7): set by a coach to disable login and hide the
  // athlete from the roster; NULL means active. Data and username are kept.
  // Last in the column list so insert-select statements append it.
  deactivatedAt: integer("deactivated_at", { mode: "timestamp_ms" }),
}, (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("users_username_ci_unique").on(sql`lower(${t.username})`), uniqueIndex("users_one_owner_unique").on(t.isOwner).where(sql`${t.isOwner} = 1`)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.id] }), index("idx_sessions_user").on(t.userId)]);

export const invites = sqliteTable("invites", {
  id: text("id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  role: text("role", { enum: ["athlete", "coach"] }).notNull().default("athlete"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.id] }), index("idx_invites_created_by").on(t.createdBy)]);

// Durable R2 cleanup queue (0002 §7). A row is written in the SAME D1 batch
// that removes the last reference to a blob (account deletion, import
// replacement, attachment deletion, abandoned upload recovery); the blob is
// deleted from R2 only after that batch commits. Deliberately NOT foreign-keyed
// to users: records must survive the deletion of the user whose files they
// name. `blob_key` is the primary key so re-enqueueing is idempotent.
export const blobCleanup = sqliteTable("blob_cleanup", {
  blobKey: text("blob_key").notNull(),
  /** Free-text origin for operators, e.g. `account-delete`, `import`, `attachment-delete`. */
  reason: text("reason").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** Earliest instant the scheduled job may (re)try this key; failures push it out. */
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.blobKey] }), index("idx_blob_cleanup_next_attempt").on(t.nextAttemptAt)]);

// ---------------------------------------------------------------------------
// Tracker tables (ported from the reference schema, each scoped by user_id)
// ---------------------------------------------------------------------------

export const trainingSessions = sqliteTable("training_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionDate: text("session_date").notNull(),
  sessionType: text("session_type", { enum: ["Range", "Gym", "SPT", "Class", "Other"] }).notNull(),
  customActivity: text("custom_activity").notNull().default(""),
  arrows: integer("arrows").notNull().default(0),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  focus: text("focus").notNull().default(""),
  score: text("score").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [index("idx_training_sessions_user").on(t.userId)]);

export const programState = sqliteTable("program_state", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  currentPoundage: integer("current_poundage"),
  currentCycle: integer("current_cycle").notNull(),
  currentWeek: integer("current_week").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId] })]);

export const cycleWeekPlans = sqliteTable("cycle_week_plans", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  weekNumber: integer("week_number").notNull(),
  primaryFocus: text("primary_focus").notNull(),
  backgroundFocusOne: text("background_focus_one").notNull().default(""),
  backgroundFocusTwo: text("background_focus_two").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.weekNumber] }), index("idx_cycle_week_plans_user").on(t.userId)]);

export const plannedSessionOverrides = sqliteTable("planned_session_overrides", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dayKey: text("day_key").notNull(),
  sessionType: text("session_type").notNull(),
  detail: text("detail").notNull(),
  prescription: text("prescription").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.dayKey] }), index("idx_planned_session_overrides_user").on(t.userId)]);

// No user FK: recovery records must survive either account's deletion.
// Expired rows are recovery tombstones, excluded from quota accounting.
export const uploadReservations = sqliteTable("upload_reservations", {
  blobKey: text("blob_key").primaryKey(),
  userId: text("user_id").notNull(),
  actorId: text("actor_id").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("idx_upload_reservations_user").on(t.userId), index("idx_upload_reservations_expiry").on(t.expiresAt)]);

export const plannedSessionAttachments = sqliteTable("planned_session_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dayKey: text("day_key").notNull(),
  kind: text("kind", { enum: ["document", "photo", "link"] }).notNull(),
  label: text("label").notNull(),
  url: text("url").notNull().default(""),
  blobKey: text("blob_key").notNull().default(""),
  mimeType: text("mime_type").notNull().default(""),
  sizeBytes: integer("size_bytes"),
  /** Backfill retry ordering; NULL means never attempted. */
  sizeCheckedAt: integer("size_checked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [index("idx_planned_session_attachments_user").on(t.userId)]);

export const milestoneChecks = sqliteTable("milestone_checks", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  checked: integer("checked", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.key] }), index("idx_milestone_checks_user").on(t.userId)]);

export const maintenanceChecks = sqliteTable("maintenance_checks", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  checked: integer("checked", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.userId, t.key] }), index("idx_maintenance_checks_user").on(t.userId)]);

export const maintenanceItems = sqliteTable("maintenance_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  section: text("section", { enum: ["Weekly", "Monthly", "Quarterly"] }).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  // Ephemeral mapping, set and cleared inside the same atomic import batch.
  importKey: text("import_key"),
}, (t) => [index("idx_maintenance_items_user").on(t.userId), uniqueIndex("maintenance_import_key_unique").on(t.userId, t.importKey)]);

export const inspirationEntries = sqliteTable("inspiration_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  thoughtText: text("thought_text").notNull(),
  videoTitle: text("video_title").notNull(),
  videoUrl: text("video_url").notNull(),
  recipeName: text("recipe_name").notNull(),
  recipeSummary: text("recipe_summary").notNull(),
  recipeIngredients: text("recipe_ingredients").notNull(),
  recipeInstructions: text("recipe_instructions").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [index("idx_inspiration_entries_user").on(t.userId)]);

export const weeklyNotes = sqliteTable("weekly_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  weekStart: text("week_start").notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [unique("weekly_notes_user_week_unique").on(t.userId, t.weekStart), index("idx_weekly_notes_user").on(t.userId)]);

export const practiceScores = sqliteTable("practice_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scoreDate: text("score_date").notNull(),
  total: integer("total").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  importKey: text("import_key"),
}, (t) => [index("idx_practice_scores_user").on(t.userId), uniqueIndex("score_import_key_unique").on(t.userId, t.importKey)]);

export const practiceScoreEnds = sqliteTable("practice_score_ends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scoreId: integer("score_id").notNull().references(() => practiceScores.id, { onDelete: "cascade" }),
  endNumber: integer("end_number").notNull(),
  arrow1: integer("arrow_1").notNull(),
  arrow2: integer("arrow_2").notNull(),
  arrow3: integer("arrow_3").notNull(),
  endTotal: integer("end_total").notNull(),
}, (t) => [index("idx_practice_score_ends_user").on(t.userId), index("idx_practice_score_ends_score").on(t.scoreId)]);

export const bowSetups = sqliteTable("bow_setups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
}, (t) => [index("idx_bow_setups_user").on(t.userId)]);
