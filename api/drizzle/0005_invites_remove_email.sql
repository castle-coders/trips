PRAGMA foreign_keys=OFF;
CREATE TABLE `invites_new` (
  `id` text PRIMARY KEY NOT NULL,
  `trip_id` text NOT NULL REFERENCES `trips`(`id`) ON DELETE CASCADE,
  `email` text,
  `name` text,
  `role` text NOT NULL DEFAULT 'Viewer',
  `token` text NOT NULL UNIQUE,
  `status` text NOT NULL DEFAULT 'pending',
  `invited_by` text NOT NULL REFERENCES `users`(`id`),
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL
);
INSERT INTO `invites_new` SELECT * FROM `invites`;
DROP TABLE `invites`;
ALTER TABLE `invites_new` RENAME TO `invites`;
PRAGMA foreign_keys=ON;
