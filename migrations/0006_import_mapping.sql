ALTER TABLE `maintenance_items` ADD `import_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_import_key_unique` ON `maintenance_items` (`user_id`,`import_key`);--> statement-breakpoint
ALTER TABLE `practice_scores` ADD `import_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `score_import_key_unique` ON `practice_scores` (`user_id`,`import_key`);