type Environment = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isTemplatePlaceholder(value: string) {
  return /(?:replace[-_ ]with|your[-_ ]|url[_-]?encoded|change[-_ ]?me|placeholder)/i.test(value);
}

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
    if (!parsedDatabaseUrl.hostname || !parsedDatabaseUrl.username || !parsedDatabaseUrl.password
      || parsedDatabaseUrl.pathname === "/" || !parsedDatabaseUrl.pathname || parsedDatabaseUrl.hash) {
      errors.push("DATABASE_URL must include a host, database, username and password without a fragment");
    }
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
  const managerProvider = env.APTLSS_MANAGER_PROVIDER?.trim() || "codex-subscription";
  if (managerProvider !== "codex-subscription") {
    errors.push("APTLSS_MANAGER_PROVIDER must be codex-subscription; paid API routing is not permitted in production");
  }

  const publicOrigins = ["PUBLIC_URL", "APP_URL", "VITE_FRONTEND_URL"].map(name => {
    const value = env[name]?.trim() ?? "";
    if (!value) {
      errors.push(`${name} must be set to the public HTTPS origin in production`);
      return null;
    }

    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        errors.push(`${name} must be an HTTPS origin without a path, credentials, query, or fragment`);
        return null;
      }
      return url.origin;
    } catch {
      errors.push(`${name} must be a valid public HTTPS origin`);
      return null;
    }
  });

  if (publicOrigins.every(Boolean) && new Set(publicOrigins).size !== 1) {
    errors.push("PUBLIC_URL, APP_URL, and VITE_FRONTEND_URL must use the same HTTPS origin");
  }

  const webhookCallback = env.TRELLO_WEBHOOK_CALLBACK_URL?.trim() ?? "";
  const webhookSecret = hasValue(env, "TRELLO_WEBHOOK_SECRET");
  if (Boolean(webhookCallback) !== webhookSecret) {
    errors.push("TRELLO_WEBHOOK_CALLBACK_URL and TRELLO_WEBHOOK_SECRET must be configured together");
  }
  if (webhookCallback) {
    try {
      const callback = new URL(webhookCallback);
      const publicOrigin = publicOrigins[0];
      if (
        callback.protocol !== "https:" ||
        callback.username ||
        callback.password ||
        callback.pathname !== "/api/trello-webhook" ||
        callback.search ||
        callback.hash ||
        !publicOrigin ||
        callback.origin !== publicOrigin
      ) {
        errors.push("TRELLO_WEBHOOK_CALLBACK_URL must be the exact HTTPS /api/trello-webhook URL on the public origin");
      }
    } catch {
      errors.push("TRELLO_WEBHOOK_CALLBACK_URL must be a valid HTTPS webhook URL");
    }
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

  for (const name of ["DATABASE_URL", "JWT_SECRET", "TRELLO_API_KEY", "TRELLO_TOKEN", "REDIS_URL"] as const) {
    if (isTemplatePlaceholder(env[name]?.trim() ?? "")) {
      errors.push(`${name} must not contain template placeholder values`);
    }
  }
  return errors;
}

export function assertProductionConfiguration(env: Environment = process.env) {
  const errors = getProductionConfigurationErrors(env);
  if (errors.length === 0) return;

  throw new Error(`Invalid production configuration: ${errors.join("; ")}`);
}
