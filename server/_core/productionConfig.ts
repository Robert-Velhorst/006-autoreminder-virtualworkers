type Environment = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function hasValue(env: Environment, name: string) {
  return Boolean(env[name]?.trim());
}

function canonicalPublicOrigin(env: Environment) {
  return env.PUBLIC_URL?.trim()
    || env.WEBHOOK_BASE_URL?.trim()
    || env.APP_URL?.trim()
    || null;
}

function isHttpsPublicOrigin(value: string | null) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
  if (!hasValue(env, "OPENAI_API_KEY")) {
    errors.push("OPENAI_API_KEY is required");
  }
  if (!host || LOOPBACK_HOSTS.has(host)) {
    errors.push("HOST must bind to a non-loopback interface in production");
  }
  if (!isHttpsPublicOrigin(canonicalPublicOrigin(env))) {
    errors.push("PUBLIC_URL, WEBHOOK_BASE_URL, or APP_URL must provide an HTTPS public origin in production");
  }
  if (env.LOCAL_AUTH_BYPASS === "true") {
    errors.push("LOCAL_AUTH_BYPASS cannot be enabled in production");
  }
  if (hasValue(env, "OWNER_BOOTSTRAP_TOKEN") && (env.OWNER_BOOTSTRAP_TOKEN?.trim().length ?? 0) < 24) {
    errors.push("OWNER_BOOTSTRAP_TOKEN must contain at least 24 characters when configured");
  }
  if (env.BRIEFING_SCHEDULER_ENABLED === "true" && env.NOTIFICATIONS_ENABLED !== "true") {
    errors.push("BRIEFING_SCHEDULER_ENABLED requires NOTIFICATIONS_ENABLED=true");
  }
  if (hasValue(env, "TRELLO_WEBHOOK_CALLBACK_URL")
    && !hasValue(env, "TRELLO_WEBHOOK_SECRET")
    && !hasValue(env, "TRELLO_POWERUP_SECRET")) {
    errors.push("TRELLO_WEBHOOK_SECRET is required when Trello webhooks are enabled");
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
