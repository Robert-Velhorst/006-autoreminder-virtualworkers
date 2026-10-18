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
  if (env.LOCAL_AUTH_BYPASS === "true") {
    errors.push("LOCAL_AUTH_BYPASS cannot be enabled in production");
  }
  return errors;
}

export function assertProductionConfiguration(env: Environment = process.env) {
  const errors = getProductionConfigurationErrors(env);
  if (errors.length === 0) return;

  throw new Error(`Invalid production configuration: ${errors.join("; ")}`);
}
