CREATE TABLE `comment_mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`ticket_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`read_at` text,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_mentions_unique` ON `comment_mentions` (`comment_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `comment_mentions_ticket_user_idx` ON `comment_mentions` (`ticket_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `comment_mentions_user_unread_idx` ON `comment_mentions` (`user_id`,`read_at`);