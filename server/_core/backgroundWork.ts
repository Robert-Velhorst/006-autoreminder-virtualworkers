import { requireIsolatedPostgresTestDatabase } from "../../shared/isolatedPostgresTestDatabase.mjs";
type Environment = Record<string, string | undefined>;

export function getBackgroundWorkConfiguration(
  env: Environment,
  options: { localAuthBypassEnabled: boolean },
) {
  const configured = env.BACKGROUND_JOBS_ENABLED;
  if (configured !== undefined && configured !== "true" && configured !== "false") {
    throw new Error("BACKGROUND_JOBS_ENABLED must be exactly true or false when configured.");
  }

  let isolatedBrowserTest = false;
  if (env.APTLSS_TEST_DISABLE_BACKGROUND_JOBS === "true") {
    try {
      requireIsolatedPostgresTestDatabase(env.APTLSS_TEST_DATABASE_URL, env.NODE_ENV === "production");
    } catch {
      throw new Error("APTLSS browser-test mode is restricted to non-production loopback test databases and requires its explicit loopback test database URL.");
    }
    isolatedBrowserTest = true;
  }

  const reason = configured === "false" ? "BACKGROUND_JOBS_ENABLED=false"
    : options.localAuthBypassEnabled ? "Local auth bypass enabled"
    : isolatedBrowserTest ? "Isolated APTLSS browser-test mode"
    : null;
  return { enabled: reason === null, reason };
}
