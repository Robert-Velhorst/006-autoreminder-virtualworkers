import bcrypt from "bcryptjs";
import { Pool } from "pg";

const E2E_USERNAME = "va-dashboard-ci-worker";
const E2E_PASSWORD = "ci-only-worker-password";

function requireIsolatedCiDatabase() {
  if (process.env.CI !== "true") {
    throw new Error("Browser E2E fixtures may only run in CI.");
  }

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl)
    throw new Error("DATABASE_URL is required for browser E2E tests.");

  const databaseUrl = new URL(rawUrl);
  if (
    databaseUrl.pathname !== "/recovery_test" ||
    !["127.0.0.1", "localhost"].includes(databaseUrl.hostname)
  ) {
    throw new Error(
      "Browser E2E fixtures require the local recovery_test database."
    );
  }

  return rawUrl;
}

export default async function globalSetup() {
  const pool = new Pool({ connectionString: requireIsolatedCiDatabase() });
  try {
    const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users ("openId", name, "loginMethod", role, "passwordHash")
       VALUES ($1, 'CI Worker', 'local', 'worker', $2)
       ON CONFLICT ("openId") DO UPDATE SET
         name = EXCLUDED.name,
         "loginMethod" = EXCLUDED."loginMethod",
         role = EXCLUDED.role,
         "passwordHash" = EXCLUDED."passwordHash"`,
      [E2E_USERNAME, passwordHash]
    );
    await pool.query(`INSERT INTO users ("openId", name, role)
      VALUES ('va-dashboard-ci-founder', 'CI Founder', 'admin')
      ON CONFLICT ("openId") DO NOTHING`);
    await pool.query(`DELETE FROM va_profiles WHERE "userId" = (SELECT id FROM users WHERE "openId" = $1)`, [E2E_USERNAME]);
    await pool.query(`INSERT INTO va_profiles ("userId", "founderId", name, timezone, status)
      SELECT worker.id, founder.id, 'CI Worker', 'UTC', 'active'
      FROM users worker CROSS JOIN users founder
      WHERE worker."openId" = $1 AND founder."openId" = 'va-dashboard-ci-founder'`, [E2E_USERNAME]);
  } finally {
    await pool.end();
  }

  return async () => {
    const teardownPool = new Pool({
      connectionString: requireIsolatedCiDatabase(),
    });
    try {
      await teardownPool.query('DELETE FROM va_profiles WHERE "userId" = (SELECT id FROM users WHERE "openId" = $1)', [E2E_USERNAME]);
      await teardownPool.query("DELETE FROM users WHERE \"openId\" = 'va-dashboard-ci-founder'");
      await teardownPool.query('DELETE FROM users WHERE "openId" = $1', [
        E2E_USERNAME,
      ]);
    } finally {
      await teardownPool.end();
    }
  };
}
