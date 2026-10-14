import { defineConfig } from "drizzle-kit";
import { requirePostgresDatabaseUrl } from "./server/db/databaseUrl";

const connectionString = requirePostgresDatabaseUrl(process.env.DATABASE_URL);

const config = {
  schema: "./drizzle/schema.postgres.ts",
  out: "./drizzle-postgres-v1",
  dialect: "postgresql" as const,
  dbCredentials: {
    url: connectionString,
  },
};

export default defineConfig(config);
