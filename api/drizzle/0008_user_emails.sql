CREATE TABLE `user_emails` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `email` text NOT NULL UNIQUE,
  `is_primary` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL
);

CREATE TABLE `account_link_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `token` text NOT NULL UNIQUE,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL
);

-- Backfill: every existing user gets a primary email row
INSERT INTO `user_emails` (`id`, `user_id`, `email`, `is_primary`, `created_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
       `id`, `email`, 1, `created_at`
FROM `users`;
