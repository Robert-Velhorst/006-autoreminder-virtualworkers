import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

const connectionString = process.env.DATABASE_URL;
if (!connectionString?.startsWith("mysql://")) {
  throw new Error("DATABASE_URL must be a MySQL connection string");
}

const pool = mysql.createPool({ uri: connectionString, connectionLimit: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("Database migrations applied successfully");
} finally {
  await pool.end();
}
