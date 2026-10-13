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
    let database: URL;
    try {
      database = new URL(env.APTLSS_TEST_DATABASE_URL?.trim() ?? "");
    } catch {
      throw new Error("APTLSS browser-test mode requires its explicit loopback test database URL.");
    }
    if (
      env.NODE_ENV === "production" ||
      database.protocol !== "mysql:" ||
      database.search || database.hash ||
      !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
      !/^\/(?:aptlss_test|recovery_test)$/.test(database.pathname)
    ) {
      throw new Error("APTLSS browser-test mode is restricted to non-production loopback test databases.");
    }
    isolatedBrowserTest = true;
  }

  const reason = configured === "false" ? "BACKGROUND_JOBS_ENABLED=false"
    : options.localAuthBypassEnabled ? "Local auth bypass enabled"
    : isolatedBrowserTest ? "Isolated APTLSS browser-test mode"
    : null;
  return { enabled: reason === null, reason };
}
