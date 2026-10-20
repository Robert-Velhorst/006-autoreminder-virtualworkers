export function requireIsolatedPostgresTestDatabase(value, isProduction = false) {
  const message = "An explicit non-production loopback PostgreSQL URL naming aptlss_test or recovery_test with only sslmode=disable is required.";
  if (isProduction || typeof value !== "string" || !value.trim()) throw new Error(message);
  let database;
  try { database = new URL(value); } catch { throw new Error(message); }
  const parameters = [...database.searchParams.entries()];
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !["/aptlss_test", "/recovery_test"].includes(database.pathname) ||
    database.hash ||
    parameters.length > 1 ||
    (parameters.length === 1 && (parameters[0][0] !== "sslmode" || parameters[0][1] !== "disable"))
  ) throw new Error(message);
  return database.href;
}
