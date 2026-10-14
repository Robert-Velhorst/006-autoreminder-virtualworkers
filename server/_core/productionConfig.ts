type Environment = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function hasValue(env: Environment, name: string) {
  return Boolean(env[name]?.trim());
}

export function getProductionConfigurationErrors(env: Environment = process.env) {
  if (env.NODE_ENV !== "production") return [];

  const errors: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const host = env.HOST?.trim().toLowerCase() ?? "";

  let parsedDatabaseUrl: URL | null = null;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    // Report the same actionable configuration error for malformed values.
  }
  if (
    !parsedDatabaseUrl ||
    (parsedDatabaseUrl.protocol !== "postgresql:" && parsedDatabaseUrl.protocol !== "postgres:")
  ) {
    errors.push("DATABASE_URL must be a PostgreSQL connection URL");
  } else {
    const sslModes = parsedDatabaseUrl.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || sslModes[0] !== "verify-full" || parsedDatabaseUrl.searchParams.has("ssl")) {
      errors.push("DATABASE_URL must enable verified TLS with one sslmode=verify-full option and no ssl override");
    }
  }
  if ((env.JWT_SECRET?.trim().length ?? 0) < 32) {
    errors.push("JWT_SECRET must contain at least 32 characters");
  }
  if (!hasValue(env, "TRELLO_API_KEY")) {
    errors.push("TRELLO_API_KEY is required");
  }
  if (!hasValue(env, "TRELLO_TOKEN")) {
    errors.push("TRELLO_TOKEN is required");
  }
  if (!host || LOOPBACK_HOSTS.has(host)) {
    errors.push("HOST must bind to a non-loopback interface in production");
  }
  if (env.LOCAL_AUTH_BYPASS === "true") {
    errors.push("LOCAL_AUTH_BYPASS cannot be enabled in production");
  }
  if (hasValue(env, "VERCEL")) {
    errors.push("Vercel request-only runtime is unsupported; deploy the unified Docker container");
  }

  return errors;
}

export function assertProductionConfiguration(env: Environment = process.env) {
  const errors = getProductionConfigurationErrors(env);
  if (errors.length === 0) return;

  throw new Error(`Invalid production configuration: ${errors.join("; ")}`);
}
