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

  if (!databaseUrl.startsWith("mysql://")) {
    errors.push("DATABASE_URL must be a MySQL connection URL");
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
