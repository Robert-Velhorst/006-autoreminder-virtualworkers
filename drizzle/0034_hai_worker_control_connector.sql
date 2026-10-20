CREATE TABLE `hai_connector_tokens` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceOwnerId` int NOT NULL,
  `createdByUserId` int NOT NULL,
  `label` varchar(128) NOT NULL DEFAULT 'HAI Worker Control',
  `tokenPrefix` varchar(24) NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `scopes` varchar(255) NOT NULL DEFAULT 'worker_control:read',
  `lastUsedAt` timestamp NULL,
  `expiresAt` timestamp NULL,
  `revokedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `hai_connector_tokens_id` PRIMARY KEY(`id`),
  CONSTRAINT `hai_connector_tokens_hash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE INDEX `hai_connector_tokens_owner_active_idx` ON `hai_connector_tokens` (`workspaceOwnerId`,`revokedAt`,`createdAt`);
