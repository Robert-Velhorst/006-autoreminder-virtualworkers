import { defineConfig } from "drizzle-kit";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

function detectDialect(url: string): "mysql" | "postgresql" {
  if (url.startsWith("mysql://")) return "mysql";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://"))
    return "postgresql";
  throw new Error(
    "DATABASE_URL must use mysql://, postgresql://, or postgres://"
  );
}

const dialect = detectDialect(connectionString);
console.log(`[Drizzle] Detected dialect: ${dialect}`);

const config = {
  schema:
    dialect === "postgresql"
      ? "./drizzle/schema.postgres.ts"
      : "./drizzle/schema.ts",
  out: dialect === "postgresql" ? "./drizzle-postgres-v1" : "./drizzle",
  dialect: dialect,
  dbCredentials: {
    url: connectionString,
  },
};

export default defineConfig(config);
