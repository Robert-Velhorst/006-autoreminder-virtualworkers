CREATE TABLE `worker_invitations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `vaId` int NOT NULL,
  `founderId` int NOT NULL,
  `email` varchar(320) NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `sentAt` timestamp NULL,
  `acceptedAt` timestamp NULL,
  `revokedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `worker_invitations_id` PRIMARY KEY(`id`),
  CONSTRAINT `worker_invitations_token_hash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE INDEX `worker_invitations_user_status_idx`
  ON `worker_invitations` (`userId`, `acceptedAt`, `revokedAt`);
--> statement-breakpoint
CREATE INDEX `worker_invitations_founder_created_idx`
  ON `worker_invitations` (`founderId`, `createdAt`);
