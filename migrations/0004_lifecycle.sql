CREATE TABLE `blob_cleanup` (
	`blob_key` text PRIMARY KEY NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_blob_cleanup_next_attempt` ON `blob_cleanup` (`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `deactivated_at` integer;