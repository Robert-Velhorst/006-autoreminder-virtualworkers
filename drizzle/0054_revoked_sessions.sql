CREATE TABLE IF NOT EXISTS `revoked_sessions` (
  `sessionHash` varchar(64) NOT NULL,
  `revokedAt` timestamp NOT NULL DEFAULT (now()),
  `expiresAt` timestamp NOT NULL,
  CONSTRAINT `revoked_sessions_sessionHash` PRIMARY KEY (`sessionHash`),
  INDEX `revoked_sessions_expires_at_idx` (`expiresAt`)
);
