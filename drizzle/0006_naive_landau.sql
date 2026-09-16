CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` integer NOT NULL,
	`filename` text NOT NULL,
	`stored_name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `attachments_ticket_idx` ON `attachments` (`ticket_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_stored_unique` ON `attachments` (`ticket_id`,`stored_name`);--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` integer NOT NULL,
	`field` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`actor_id` integer,
	`actor_name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticket_id`);