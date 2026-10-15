const SENSITIVE_SETTING_NAMES = new Set([
  "key",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "authorization",
  "private",
]);

function containsSensitiveSettingName(key) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return words.some(word => SENSITIVE_SETTING_NAMES.has(word));
}

export function redactSensitiveSettings(rows) {
  return rows.map((row) => typeof row.key === "string" && containsSensitiveSettingName(row.key)
    ? { ...row, value: null }
    : row);
}
