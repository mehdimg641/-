CREATE TABLE `igAccounts` (
	`id` varchar(64) NOT NULL,
	`username` varchar(64),
	`name` varchar(120),
	`token` text NOT NULL,
	`tokenExpiresAt` timestamp,
	`tokenRefreshedAt` timestamp,
	`lastError` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `igAccounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `igMedia` ADD `accountId` varchar(64);--> statement-breakpoint
ALTER TABLE `replyRules` ADD `accountId` varchar(64);--> statement-breakpoint
ALTER TABLE `replyTemplates` ADD `accountId` varchar(64);