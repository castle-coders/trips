CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`created_at` text NOT NULL,
	`actor_user_id` text,
	`actor_name` text NOT NULL,
	`actor_email` text NOT NULL,
	`actor_role` text NOT NULL,
	`channel` text NOT NULL,
	`client_id` text,
	`request_id` text,
	`trip_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_label` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`changes` text,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_id_unique` ON `audit_events` (`id`);--> statement-breakpoint
CREATE INDEX `audit_events_trip_seq` ON `audit_events` (`trip_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_seq` ON `audit_events` (`entity_type`,`entity_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_seq` ON `audit_events` (`actor_user_id`,`seq`);
