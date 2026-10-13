type Environment = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isPlaceholder(value: string) {
  return /(?:replace[-_ ]with|your[-_ ]|example(?:[.-]|$)|url[_-]?encoded|change[-_ ]?me|placeholder)/i.test(value);
}

function parseUrl(value: string | undefined) {
  if (!value?.trim()) return undefined;

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function getExpressTrustProxySetting(env: Environment = process.env): 1 | false {
  return env.NODE_ENV === "production" ? 1 : false;
}

export function getProductionConfigurationErrors(env: Environment = process.env) {
  if (env.NODE_ENV !== "production") return [];

  const errors: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const host = env.HOST?.trim().toLowerCase() ?? "";
  const database = parseUrl(databaseUrl);
  const redisUrl = env.REDIS_URL?.trim() ?? "";
  const redis = parseUrl(redisUrl);

  if (
    !database ||
    database.protocol !== "mysql:" ||
    !database.hostname ||
    !database.pathname.slice(1) ||
    !database.username ||
    !database.password
  ) {
    errors.push("DATABASE_URL must be a complete MySQL URL with host, database, username, and password");
  } else if (isPlaceholder(databaseUrl)) {
    errors.push("DATABASE_URL must not contain template placeholder values");
  }
  if (!redis || !["redis:", "rediss:"].includes(redis.protocol) || !redis.hostname || !redis.password) {
    errors.push("REDIS_URL must be a Redis URL with host and password");
  } else if (isPlaceholder(redisUrl)) {
    errors.push("REDIS_URL must not contain template placeholder values");
  }
  const jwtSecret = env.JWT_SECRET?.trim() ?? "";
  if (jwtSecret.length < 32) {
    errors.push("JWT_SECRET must contain at least 32 characters");
  } else if (isPlaceholder(jwtSecret)) {
    errors.push("JWT_SECRET must not contain template placeholder values");
  }
  const trelloApiKey = env.TRELLO_API_KEY?.trim() ?? "";
  if (!trelloApiKey || isPlaceholder(trelloApiKey)) {
    errors.push("TRELLO_API_KEY must be configured with a non-placeholder value");
  }
  const trelloToken = env.TRELLO_TOKEN?.trim() ?? "";
  if (!trelloToken || isPlaceholder(trelloToken)) {
    errors.push("TRELLO_TOKEN must be configured with a non-placeholder value");
  }
  for (const name of ["PUBLIC_URL", "WEBHOOK_BASE_URL"] as const) {
    const url = env[name]?.trim() ?? "";
    const parsed = parseUrl(url);
    if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) {
      errors.push(`${name} must be a valid public HTTPS URL`);
    } else if (isPlaceholder(url)) {
      errors.push(`${name} must not contain template placeholder values`);
    }
  }
  if (!host || LOOPBACK_HOSTS.has(host)) {
    errors.push("HOST must bind to a non-loopback interface in production");
  }
  if (env.LOCAL_AUTH_BYPASS === "true") {
    errors.push("LOCAL_AUTH_BYPASS cannot be enabled in production");
  }
  if (env.VERCEL?.trim()) {
    errors.push("Vercel request-only runtime is unsupported; deploy the unified Docker container");
  }
  return errors;
}

export function assertProductionConfiguration(env: Environment = process.env) {
  const errors = getProductionConfigurationErrors(env);
  if (errors.length === 0) return;

  throw new Error(`Invalid production configuration: ${errors.join("; ")}`);
}
