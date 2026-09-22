-- Existing browser collector tokens were stored in cleartext. Keep their
-- ability to authenticate extensions while replacing the stored value with a
-- deterministic SHA-256 digest. The runtime recognizes this legacy-hex form
-- and new tokens use the stronger base64url representation from the server.
UPDATE `app_settings`
SET `value` = CONCAT('sha256hex:', SHA2(`value`, 256))
WHERE `key` LIKE 'browserTabCollectorToken:%'
  AND `value` NOT LIKE 'sha256:%'
  AND `value` NOT LIKE 'sha256hex:%';
