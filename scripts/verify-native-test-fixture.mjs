import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";

// Hosted release and PR gates must not silently turn native suites into skips.
export function verifyNativeTestFixture(env = process.env) {
  const names = ["DATABASE_URL", "APTLSS_TEST_DATABASE_URL", "OWNER_PROVISIONING_TEST_DATABASE_URL"];
  const targets = names.map(name => requireIsolatedPostgresTestDatabase(env[name], env.NODE_ENV === "production"));
  if (new Set(targets).size !== 1) throw new Error("Native test URLs must identify the same isolated PostgreSQL fixture.");
  if (env.APTLSS_TEST_DISABLE_BACKGROUND_JOBS !== "true" || env.NOTIFICATIONS_ENABLED !== "false") {
    throw new Error("Native CI requires background test jobs disabled and notifications off.");
  }
  return { passed: true, nativePostgresConfigured: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(verifyNativeTestFixture())); }
  catch { console.error("Native test fixture validation failed; refusing a skipped or unsafe database gate."); process.exitCode = 1; }
}
