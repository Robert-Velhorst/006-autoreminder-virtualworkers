-- Older single-worker deployments used one global collector token. Hash it as
-- well so the compatibility fallback cannot retain a plaintext secret.
UPDATE `app_settings`
SET `value` = CONCAT('sha256hex:', SHA2(`value`, 256))
WHERE `key` = 'browserTabCollectorToken'
  AND `value` NOT LIKE 'sha256:%'
  AND `value` NOT LIKE 'sha256hex:%';
