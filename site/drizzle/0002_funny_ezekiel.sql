CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`result` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`source_record_id` text NOT NULL,
	`target_record_id` text,
	`operation` text NOT NULL,
	`checksum` text NOT NULL,
	`source_version` integer,
	`status` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_sync_items_run` ON `sync_items` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_items_conflicts` ON `sync_items` (`status`);--> statement-breakpoint
CREATE TABLE `sync_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`conflicts` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `admin_overview` ADD `source_system` text;--> statement-breakpoint
ALTER TABLE `admin_overview` ADD `source_record_id` text;--> statement-breakpoint
ALTER TABLE `admin_overview` ADD `source_updated_at` text;--> statement-breakpoint
ALTER TABLE `admin_overview` ADD `sync_version` integer;--> statement-breakpoint
ALTER TABLE `admin_overview` ADD `checksum` text;--> statement-breakpoint
ALTER TABLE `books` ADD `source_system` text;--> statement-breakpoint
ALTER TABLE `books` ADD `source_record_id` text;--> statement-breakpoint
ALTER TABLE `books` ADD `source_updated_at` text;--> statement-breakpoint
ALTER TABLE `books` ADD `sync_version` integer;--> statement-breakpoint
ALTER TABLE `books` ADD `checksum` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_books_source_identity` ON `books` (`source_system`,`source_record_id`);--> statement-breakpoint
ALTER TABLE `reading_progress` ADD `source_system` text;--> statement-breakpoint
ALTER TABLE `reading_progress` ADD `source_record_id` text;--> statement-breakpoint
ALTER TABLE `reading_progress` ADD `source_updated_at` text;--> statement-breakpoint
ALTER TABLE `reading_progress` ADD `sync_version` integer;--> statement-breakpoint
ALTER TABLE `reading_progress` ADD `checksum` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_progress_source_identity` ON `reading_progress` (`source_system`,`source_record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_progress_student_book` ON `reading_progress` (`student_id`,`book_id`);--> statement-breakpoint
ALTER TABLE `students` ADD `source_system` text;--> statement-breakpoint
ALTER TABLE `students` ADD `source_record_id` text;--> statement-breakpoint
ALTER TABLE `students` ADD `source_updated_at` text;--> statement-breakpoint
ALTER TABLE `students` ADD `sync_version` integer;--> statement-breakpoint
ALTER TABLE `students` ADD `checksum` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_students_source_identity` ON `students` (`source_system`,`source_record_id`);