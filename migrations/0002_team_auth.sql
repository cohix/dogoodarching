-- Reviewed drizzle-kit migration. D1 always enforces foreign keys; do not use
-- PRAGMA foreign_keys=OFF. Defer checks during rebuilds within the migration batch.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
-- Orphans from old local/test data are discarded: they have no account that can
-- access them. Valid user data is preserved; broken inviter references become NULL.
-- Snapshot ends without FKs BEFORE rebuilding practice_scores: deferred checks
-- do not suppress ON DELETE CASCADE when its old parent table is dropped.
CREATE TABLE __saved_score_ends AS SELECT * FROM practice_score_ends;
--> statement-breakpoint
DROP TABLE practice_score_ends;
--> statement-breakpoint
DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`invited_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_users` (id, username, password_hash, role, is_owner, invited_by, created_at)
SELECT id, username, password_hash, role,
  CASE WHEN id = (SELECT id FROM users WHERE role = 'coach' ORDER BY created_at, id LIMIT 1) THEN 1 ELSE 0 END,
  NULL, created_at FROM users;--> statement-breakpoint
CREATE TABLE __saved_inviters AS
SELECT u.id, u.coach_id FROM users u WHERE EXISTS (SELECT 1 FROM users creator WHERE creator.id = u.coach_id);
--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
UPDATE users SET invited_by = (SELECT coach_id FROM __saved_inviters WHERE __saved_inviters.id = users.id);
--> statement-breakpoint
DROP TABLE __saved_inviters;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_ci_unique` ON `users` (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX `users_one_owner_unique` ON `users` (`is_owner`) WHERE "users"."is_owner" = 1;--> statement-breakpoint
CREATE TABLE `__new_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text,
	`role` text DEFAULT 'athlete' NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_invites` (id, token_hash, created_by, role, expires_at, used_at, created_at)
SELECT id, token_hash, (SELECT id FROM users WHERE users.id = invites.coach_id),
  'athlete', expires_at, used_at, created_at FROM invites;--> statement-breakpoint
DROP TABLE `invites`;--> statement-breakpoint
ALTER TABLE `__new_invites` RENAME TO `invites`;--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invites_created_by` ON `invites` (`created_by`);--> statement-breakpoint
CREATE TABLE `__new_program_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`current_poundage` integer,
	`current_cycle` integer NOT NULL,
	`current_week` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_program_state`("user_id", "current_poundage", "current_cycle", "current_week", "updated_at") SELECT "user_id", "current_poundage", "current_cycle", "current_week", "updated_at" FROM `program_state` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `program_state`;--> statement-breakpoint
ALTER TABLE `__new_program_state` RENAME TO `program_state`;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "token_hash", "user_id", "expires_at", "created_at") SELECT "id", "token_hash", "user_id", "expires_at", "created_at" FROM `sessions` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_bow_setups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`poundage` integer NOT NULL,
	`name` text NOT NULL,
	`limb_riser` text DEFAULT '' NOT NULL,
	`tiller_bolts` text DEFAULT '' NOT NULL,
	`brace_height` text DEFAULT '' NOT NULL,
	`string_twists` text DEFAULT '' NOT NULL,
	`nocking_point` text DEFAULT '' NOT NULL,
	`center_shot` text DEFAULT '' NOT NULL,
	`plunger` text DEFAULT '' NOT NULL,
	`grip_notes` text DEFAULT '' NOT NULL,
	`stabilizer` text DEFAULT '' NOT NULL,
	`clicker_position` text DEFAULT '' NOT NULL,
	`bare_shaft` text DEFAULT '' NOT NULL,
	`walk_back` text DEFAULT '' NOT NULL,
	`arrows_in_use` text DEFAULT '' NOT NULL,
	`sight_marks_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_bow_setups`("id", "user_id", "poundage", "name", "limb_riser", "tiller_bolts", "brace_height", "string_twists", "nocking_point", "center_shot", "plunger", "grip_notes", "stabilizer", "clicker_position", "bare_shaft", "walk_back", "arrows_in_use", "sight_marks_json", "updated_at") SELECT "id", "user_id", "poundage", "name", "limb_riser", "tiller_bolts", "brace_height", "string_twists", "nocking_point", "center_shot", "plunger", "grip_notes", "stabilizer", "clicker_position", "bare_shaft", "walk_back", "arrows_in_use", "sight_marks_json", "updated_at" FROM `bow_setups` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `bow_setups`;--> statement-breakpoint
ALTER TABLE `__new_bow_setups` RENAME TO `bow_setups`;--> statement-breakpoint
CREATE INDEX `idx_bow_setups_user` ON `bow_setups` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_cycle_week_plans` (
	`user_id` text NOT NULL,
	`week_number` integer NOT NULL,
	`primary_focus` text NOT NULL,
	`background_focus_one` text DEFAULT '' NOT NULL,
	`background_focus_two` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `week_number`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_cycle_week_plans`("user_id", "week_number", "primary_focus", "background_focus_one", "background_focus_two", "updated_at") SELECT "user_id", "week_number", "primary_focus", "background_focus_one", "background_focus_two", "updated_at" FROM `cycle_week_plans` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `cycle_week_plans`;--> statement-breakpoint
ALTER TABLE `__new_cycle_week_plans` RENAME TO `cycle_week_plans`;--> statement-breakpoint
CREATE INDEX `idx_cycle_week_plans_user` ON `cycle_week_plans` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_inspiration_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`thought_text` text NOT NULL,
	`video_title` text NOT NULL,
	`video_url` text NOT NULL,
	`recipe_name` text NOT NULL,
	`recipe_summary` text NOT NULL,
	`recipe_ingredients` text NOT NULL,
	`recipe_instructions` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_inspiration_entries`("id", "user_id", "thought_text", "video_title", "video_url", "recipe_name", "recipe_summary", "recipe_ingredients", "recipe_instructions", "updated_at") SELECT "id", "user_id", "thought_text", "video_title", "video_url", "recipe_name", "recipe_summary", "recipe_ingredients", "recipe_instructions", "updated_at" FROM `inspiration_entries` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `inspiration_entries`;--> statement-breakpoint
ALTER TABLE `__new_inspiration_entries` RENAME TO `inspiration_entries`;--> statement-breakpoint
CREATE INDEX `idx_inspiration_entries_user` ON `inspiration_entries` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_maintenance_checks` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_maintenance_checks`("user_id", "key", "checked", "updated_at") SELECT "user_id", "key", "checked", "updated_at" FROM `maintenance_checks` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `maintenance_checks`;--> statement-breakpoint
ALTER TABLE `__new_maintenance_checks` RENAME TO `maintenance_checks`;--> statement-breakpoint
CREATE INDEX `idx_maintenance_checks_user` ON `maintenance_checks` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_maintenance_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`section` text NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_maintenance_items`("id", "user_id", "section", "label", "sort_order", "created_at", "updated_at") SELECT "id", "user_id", "section", "label", "sort_order", "created_at", "updated_at" FROM `maintenance_items` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `maintenance_items`;--> statement-breakpoint
ALTER TABLE `__new_maintenance_items` RENAME TO `maintenance_items`;--> statement-breakpoint
CREATE INDEX `idx_maintenance_items_user` ON `maintenance_items` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_milestone_checks` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_milestone_checks`("user_id", "key", "checked", "updated_at") SELECT "user_id", "key", "checked", "updated_at" FROM `milestone_checks` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `milestone_checks`;--> statement-breakpoint
ALTER TABLE `__new_milestone_checks` RENAME TO `milestone_checks`;--> statement-breakpoint
CREATE INDEX `idx_milestone_checks_user` ON `milestone_checks` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_planned_session_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`day_key` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`blob_key` text DEFAULT '' NOT NULL,
	`mime_type` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_planned_session_attachments`("id", "user_id", "day_key", "kind", "label", "url", "blob_key", "mime_type", "created_at") SELECT "id", "user_id", "day_key", "kind", "label", "url", "blob_key", "mime_type", "created_at" FROM `planned_session_attachments` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `planned_session_attachments`;--> statement-breakpoint
ALTER TABLE `__new_planned_session_attachments` RENAME TO `planned_session_attachments`;--> statement-breakpoint
CREATE INDEX `idx_planned_session_attachments_user` ON `planned_session_attachments` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_planned_session_overrides` (
	`user_id` text NOT NULL,
	`day_key` text NOT NULL,
	`session_type` text NOT NULL,
	`detail` text NOT NULL,
	`prescription` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_planned_session_overrides`("user_id", "day_key", "session_type", "detail", "prescription", "updated_at") SELECT "user_id", "day_key", "session_type", "detail", "prescription", "updated_at" FROM `planned_session_overrides` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `planned_session_overrides`;--> statement-breakpoint
ALTER TABLE `__new_planned_session_overrides` RENAME TO `planned_session_overrides`;--> statement-breakpoint
CREATE INDEX `idx_planned_session_overrides_user` ON `planned_session_overrides` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_practice_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`score_date` text NOT NULL,
	`total` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_practice_scores`("id", "user_id", "score_date", "total", "created_at") SELECT "id", "user_id", "score_date", "total", "created_at" FROM `practice_scores` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `practice_scores`;--> statement-breakpoint
ALTER TABLE `__new_practice_scores` RENAME TO `practice_scores`;--> statement-breakpoint
CREATE INDEX `idx_practice_scores_user` ON `practice_scores` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_training_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`session_date` text NOT NULL,
	`session_type` text NOT NULL,
	`custom_activity` text DEFAULT '' NOT NULL,
	`arrows` integer DEFAULT 0 NOT NULL,
	`duration_minutes` integer DEFAULT 0 NOT NULL,
	`focus` text DEFAULT '' NOT NULL,
	`score` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_training_sessions`("id", "user_id", "session_date", "session_type", "custom_activity", "arrows", "duration_minutes", "focus", "score", "notes", "created_at") SELECT "id", "user_id", "session_date", "session_type", "custom_activity", "arrows", "duration_minutes", "focus", "score", "notes", "created_at" FROM `training_sessions` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `training_sessions`;--> statement-breakpoint
ALTER TABLE `__new_training_sessions` RENAME TO `training_sessions`;--> statement-breakpoint
CREATE INDEX `idx_training_sessions_user` ON `training_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_weekly_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_weekly_notes`("id", "user_id", "week_start", "notes", "created_at", "updated_at") SELECT "id", "user_id", "week_start", "notes", "created_at", "updated_at" FROM `weekly_notes` WHERE user_id IN (SELECT id FROM users);--> statement-breakpoint
DROP TABLE `weekly_notes`;--> statement-breakpoint
ALTER TABLE `__new_weekly_notes` RENAME TO `weekly_notes`;--> statement-breakpoint
CREATE INDEX `idx_weekly_notes_user` ON `weekly_notes` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_notes_user_week_unique` ON `weekly_notes` (`user_id`,`week_start`);
--> statement-breakpoint
CREATE TABLE `__new_practice_score_ends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`score_id` integer NOT NULL,
	`end_number` integer NOT NULL,
	`arrow_1` integer NOT NULL,
	`arrow_2` integer NOT NULL,
	`arrow_3` integer NOT NULL,
	`end_total` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`score_id`) REFERENCES `practice_scores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_practice_score_ends`("id", "user_id", "score_id", "end_number", "arrow_1", "arrow_2", "arrow_3", "end_total") SELECT "id", "user_id", "score_id", "end_number", "arrow_1", "arrow_2", "arrow_3", "end_total" FROM __saved_score_ends WHERE user_id IN (SELECT id FROM users) AND score_id IN (SELECT id FROM practice_scores);--> statement-breakpoint
DROP TABLE __saved_score_ends;--> statement-breakpoint
ALTER TABLE `__new_practice_score_ends` RENAME TO `practice_score_ends`;--> statement-breakpoint
CREATE INDEX `idx_practice_score_ends_user` ON `practice_score_ends` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_practice_score_ends_score` ON `practice_score_ends` (`score_id`);--> statement-breakpoint

-- The old fallback used new Date() as its anchor on each request. An epoch-ms
-- migration-time anchor is in the same UTC week as that fallback, so
-- datedProgramState(row, migrationToday) yields cycle 2 / week 6, not a shifted week.
-- Existing saved states (including their anchors) remain unchanged.
INSERT INTO program_state (user_id, current_poundage, current_cycle, current_week, updated_at)
SELECT id, 24, 2, 6, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users
WHERE NOT EXISTS (SELECT 1 FROM program_state WHERE user_id = users.id);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
