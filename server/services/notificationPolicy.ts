export function areNotificationsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.NOTIFICATIONS_ENABLED === "true";
}
