CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`reservation_id` text,
	`file_url` text NOT NULL,
	`document_type` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text NOT NULL,
	`category` text NOT NULL,
	`payer_id` text,
	`split_type` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payer_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `itineraries` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`confirmation_number` text,
	`total_cost` real,
	`currency` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`user_id` text,
	`email` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`destination` text,
	`start_date` text,
	`end_date` text,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
