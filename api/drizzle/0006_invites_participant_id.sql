ALTER TABLE `invites` ADD COLUMN `participant_id` text REFERENCES `participants`(`id`) ON DELETE SET NULL;
