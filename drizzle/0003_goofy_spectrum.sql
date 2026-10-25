CREATE TABLE `igMedia` (
	`id` varchar(64) NOT NULL,
	`caption` text,
	`mediaType` varchar(32),
	`mediaUrl` text,
	`thumbnailUrl` text,
	`permalink` text,
	`postedAt` timestamp,
	`commentsCount` int,
	`syncedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `igMedia_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `replyTemplates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(120) NOT NULL,
	`category` varchar(60) NOT NULL DEFAULT '',
	`text` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `replyTemplates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `replies` ADD `channel` enum('reply','private') DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE `replyRules` ADD `templateId` int;--> statement-breakpoint
ALTER TABLE `replyRules` ADD `dmTemplate` text;--> statement-breakpoint
ALTER TABLE `replyRules` ADD `dmTemplateId` int;--> statement-breakpoint
ALTER TABLE `replyRules` ADD `mediaIds` json;