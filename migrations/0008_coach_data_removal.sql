-- 0003 §5: coaches have no personal training data. Deletes every coach's rows
-- in the personal tracker tables and their own upload reservations. Rows a
-- coach created in athlete plans are stored under the athlete's user_id and
-- are untouched; so are reservations where only actor_id is the coach.
--
-- First, in the same migration, queue the R2 keys of the coach-owned file
-- attachments (and of their own upload reservations) in blob_cleanup, like
-- enqueueBlobCleanupFromAttachments: the scheduled job deletes the objects.
-- A key still referenced by an athlete's attachment row is never queued.
-- Existing records are left as they are (INSERT OR IGNORE). Time is epoch ms.
INSERT OR IGNORE INTO `blob_cleanup` (`blob_key`, `reason`, `attempts`, `last_error`, `next_attempt_at`, `created_at`)
SELECT `blob_key`, 'coach-data-removal', 0, NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
FROM (
  SELECT `blob_key` FROM `planned_session_attachments`
    WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach')
  UNION
  SELECT `blob_key` FROM `upload_reservations`
    WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach')
) AS `coach_blobs`
WHERE `blob_key` != '' AND NOT EXISTS (
  SELECT 1 FROM `planned_session_attachments` AS `kept`
  WHERE `kept`.`blob_key` = `coach_blobs`.`blob_key`
    AND `kept`.`user_id` NOT IN (SELECT `id` FROM `users` WHERE `role` = 'coach')
);
--> statement-breakpoint
-- Children before parents: score ends reference practice_scores.
DELETE FROM `practice_score_ends` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `practice_scores` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `training_sessions` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `program_state` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `cycle_week_plans` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `planned_session_overrides` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `planned_session_attachments` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `milestone_checks` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `maintenance_checks` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `maintenance_items` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `inspiration_entries` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `weekly_notes` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
DELETE FROM `bow_setups` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
--> statement-breakpoint
-- Only the coach's own uploads; uploads into athlete plans (actor_id = coach) stay.
DELETE FROM `upload_reservations` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'coach');
