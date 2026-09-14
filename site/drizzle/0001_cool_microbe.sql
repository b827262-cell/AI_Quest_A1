ALTER TABLE `books` ADD `object_key` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `books` ADD `content_type` text DEFAULT 'application/pdf' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `byte_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `sha256` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `books` ADD `storage_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;