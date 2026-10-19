CREATE TABLE `igEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`accountId` varchar(64) NOT NULL,
	`kind` enum('comment','dm') NOT NULL,
	`externalId` varchar(191) NOT NULL,
	`senderId` varchar(64) NOT NULL,
	`username` varchar(64),
	`text` text NOT NULL,
	`mediaId` varchar(64),
	`ruleId` int,
	`isRead` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `igEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `igEvents_external_unique` UNIQUE(`accountId`,`kind`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `replies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` int NOT NULL,
	`ruleId` int,
	`source` enum('rule','manual') NOT NULL,
	`text` text NOT NULL,
	`status` enum('pending','sending','sent','rejected','failed') NOT NULL DEFAULT 'pending',
	`error` text,
	`decidedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`sentAt` timestamp,
	CONSTRAINT `replies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `replyRules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`keywords` json NOT NULL,
	`channels` json NOT NULL,
	`action` enum('send','approval') NOT NULL DEFAULT 'approval',
	`template` text NOT NULL,
	`priority` int NOT NULL DEFAULT 100,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `replyRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `igEvents_sender_idx` ON `igEvents` (`senderId`);--> statement-breakpoint
CREATE INDEX `replies_event_idx` ON `replies` (`eventId`);--> statement-breakpoint
CREATE INDEX `replies_status_idx` ON `replies` (`status`);