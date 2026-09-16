CREATE TABLE `menus` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`path` text NOT NULL,
	`permission` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `menus_name_unique` ON `menus` (`name`);