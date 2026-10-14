type DatabaseUrlOptions = { requireVerifiedTls?: boolean };

export function requirePostgresDatabaseUrl(
  value: string | undefined,
  options: DatabaseUrlOptions = {}
): string {
  if (!value) throw new Error("DATABASE_URL is required");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol");
  }
  if (options.requireVerifiedTls) {
    const sslModes = url.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || sslModes[0] !== "verify-full" || url.searchParams.has("ssl")) {
      throw new Error("DATABASE_URL must enable verified TLS with one sslmode=verify-full option and no ssl override");
    }
  }
  return value;
}
