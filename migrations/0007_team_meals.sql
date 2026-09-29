CREATE TABLE `team_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` text,
	`updated_by` text,
	`name` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`ingredients` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_team_meals_created_at` ON `team_meals` (`created_at`);