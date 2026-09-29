CREATE TABLE `upload_reservations` (
	`blob_key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_upload_reservations_user` ON `upload_reservations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_reservations_expiry` ON `upload_reservations` (`expires_at`);--> statement-breakpoint
ALTER TABLE `planned_session_attachments` ADD `size_bytes` integer;--> statement-breakpoint
ALTER TABLE `planned_session_attachments` ADD `size_checked_at` integer;