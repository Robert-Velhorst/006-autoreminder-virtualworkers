import { Client, types } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";

export type FixtureDatabase = Client;

export async function openFixtureDatabase(value: string): Promise<FixtureDatabase> {
  const client = new Client({
    connectionString: requireIsolatedPostgresTestDatabase(value, process.env.NODE_ENV === "production"),
    types: {
      getTypeParser(oid, format) {
        // Fixture counts are bounded by the test cases, far below Number.MAX_SAFE_INTEGER.
        return oid === 20 ? Number : types.getTypeParser(oid, format);
      },
    },
  });
  await client.connect();
  return client;
}

export async function fixtureInsert(client: FixtureDatabase, query: string, values: unknown[]): Promise<number> {
  const result = await client.query<{ id: number }>(`${query} RETURNING id`, values);
  if (result.rows.length !== 1 || !Number.isSafeInteger(result.rows[0].id)) {
    throw new Error("Fixture insert did not return exactly one integer ID.");
  }
  return result.rows[0].id;
}
