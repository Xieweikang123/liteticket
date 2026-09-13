ALTER TABLE `users` ADD `username` text;--> statement-breakpoint
UPDATE `users` SET `username` = lower(substr(`email`, 1, instr(`email`, '@') - 1)) WHERE `username` IS NULL;--> statement-breakpoint
UPDATE `users` SET `username` = 'user' || `id` WHERE `username` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
