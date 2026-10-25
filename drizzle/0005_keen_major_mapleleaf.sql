ALTER TABLE `igEvents` ADD `reaction` varchar(16);--> statement-breakpoint
ALTER TABLE `igEvents` ADD `hidden` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `igEvents` ADD `deleted` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `replies` ADD `externalId` varchar(191);--> statement-breakpoint
ALTER TABLE `replies` ADD `customerReaction` varchar(32);