import { parseArgs } from "node:util";
import { isIP } from "node:net";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { users, type User } from "../drizzle/schema.postgres";

export class OwnerProvisioningError extends Error {}

export type OwnerProvisioningOptions = {
  username: string;
  name: string;
  execute: boolean;
};

export const OWNER_PROVISIONING_HELP = `Operator-only pending owner provisioning (no password or worker profile).
Usage: tsx scripts/provision-owner.ts --username <username> --name <name> [--dry-run | --execute]
Default: dry run, with no database writes.
Required private environment: DATABASE_URL, OWNER_BOOTSTRAP_OPEN_ID, OWNER_BOOTSTRAP_TOKEN (24+ characters).
The username must exactly match OWNER_BOOTSTRAP_OPEN_ID. Never pass secrets as arguments.
After execution, finish the existing one-time owner setup UI with the configured token.`;

export function parseOwnerProvisioningArgs(args: string[]): OwnerProvisioningOptions | null {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: false, options: {
      username: { type: "string" }, name: { type: "string" },
      execute: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
    }, tokens: true });
  } catch {
    throw new OwnerProvisioningError("Invalid arguments. Use --help; secrets belong only in the environment.");
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new OwnerProvisioningError("Duplicate options are not allowed.");
    seen.add(token.name);
  }
  const values = parsed.values;
  if (values.execute && values["dry-run"]) throw new OwnerProvisioningError("Choose --dry-run or --execute, not both.");
  if (values.help) return null;
  if (typeof values.username !== "string" || typeof values.name !== "string") {
    throw new OwnerProvisioningError("Both --username and --name are required.");
  }
  return { username: values.username, name: values.name, execute: values.execute === true };
}

function privateHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(normalized) === 6) return /^(fc|fd)[0-9a-f]{2}:/.test(normalized);
  return /^[a-z][a-z0-9-]*$/.test(normalized) || normalized.endsWith(".internal") || normalized.endsWith(".localhost");
}

function validateConfig(options: OwnerProvisioningOptions, env: NodeJS.ProcessEnv): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/.test(options.username)) {
    throw new OwnerProvisioningError("Username must be 1-64 ASCII letters, digits, or ._@+- and start with a letter or digit.");
  }
  if (!options.name.trim() || options.name !== options.name.trim() || options.name.length > 200 || /[\u0000-\u001f\u007f]/.test(options.name)) {
    throw new OwnerProvisioningError("Name must be 1-200 characters without surrounding whitespace or control characters.");
  }
  if (env.OWNER_BOOTSTRAP_OPEN_ID !== options.username) {
    throw new OwnerProvisioningError("Username must exactly match OWNER_BOOTSTRAP_OPEN_ID.");
  }
  if (!env.OWNER_BOOTSTRAP_TOKEN || env.OWNER_BOOTSTRAP_TOKEN.trim().length < 24 || env.OWNER_BOOTSTRAP_TOKEN !== env.OWNER_BOOTSTRAP_TOKEN.trim()) {
    throw new OwnerProvisioningError("OWNER_BOOTSTRAP_TOKEN must contain at least 24 characters without surrounding whitespace.");
  }
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    // Reject query overrides that can redirect pg to a different host or database.
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !privateHost(url.hostname) ||
        !url.username || !url.password || url.pathname.length < 2 || url.hash ||
        [...url.searchParams.keys()].some(key => key !== "sslmode") ||
        url.searchParams.getAll("sslmode").length > 1 ||
        (url.searchParams.has("sslmode") && !["disable", "verify-full"].includes(url.searchParams.get("sslmode")!))) throw new Error();
    return url.href;
  } catch {
    throw new OwnerProvisioningError("DATABASE_URL must be a private PostgreSQL URL with credentials and database; only optional sslmode=disable or verify-full is allowed.");
  }
}

export type OwnerProvisioningClient = Pick<Client, "connect" | "query" | "end">;
type PendingOwner = Pick<User, "openId" | "name" | "role" | "passwordHash" | "loginMethod">;
const dialect = new PgDialect();

export async function provisionOwner(
  options: OwnerProvisioningOptions,
  env: NodeJS.ProcessEnv = process.env,
  createClient: (connectionString: string) => OwnerProvisioningClient = connectionString => new Client({
    connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    application_name: "va-owner-provisioning",
  }),
): Promise<"would-create" | "created" | "already-pending"> {
  const connectionString = validateConfig(options, env);
  let client: OwnerProvisioningClient | undefined;
  let inTransaction = false;
  const query = (statement: SQL) => {
    const compiled = dialect.sqlToQuery(statement);
    return client!.query(compiled.sql, compiled.params);
  };
  try {
    client = createClient(connectionString);
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Self-conflicting even on an empty table; also excludes non-cooperating writers.
    await query(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
    const result = await query(sql`SELECT ${users.openId} AS "openId", ${users.name} AS "name",
      ${users.role} AS "role", ${users.passwordHash} AS "passwordHash", ${users.loginMethod} AS "loginMethod"
      FROM ${users} WHERE ${users.role} = 'admin' OR lower(btrim(${users.openId})) = lower(${options.username})`);
    const existing = result.rows as PendingOwner[];
    const owner = existing.find(row => row.openId === options.username);
    if (existing.some(row => row.openId !== options.username)) {
      throw new OwnerProvisioningError("Provisioning refused: conflicting identity/username or a different administrator exists.");
    }
    if (owner && (owner.role !== "admin" || owner.passwordHash !== null || owner.name !== options.name || owner.loginMethod !== "local")) {
      throw new OwnerProvisioningError("Provisioning refused: existing identity is not the exact pending local owner; no promotion or reset is allowed.");
    }
    if (!owner && options.execute) {
      await query(sql`INSERT INTO ${users} (${sql.identifier(users.openId.name)}, ${sql.identifier(users.name.name)},
        ${sql.identifier(users.role.name)}, ${sql.identifier(users.passwordHash.name)}, ${sql.identifier(users.loginMethod.name)})
        VALUES (${options.username}, ${options.name}, 'admin', NULL, 'local')`);
    }
    await client.query(options.execute ? "COMMIT" : "ROLLBACK");
    inTransaction = false;
    return owner ? "already-pending" : options.execute ? "created" : "would-create";
  } catch (error) {
    if (client && inTransaction) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof OwnerProvisioningError) throw error;
    // pg and Drizzle errors may include connection details, SQL parameters or existing hashes.
    throw new OwnerProvisioningError("Owner provisioning failed; verify database access, migrations and conflicts privately before retrying. No success is confirmed.");
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

export async function runOwnerProvisioningCli(
  args: string[], env: NodeJS.ProcessEnv = process.env,
  output: (message: string) => void = console.log,
  createClient?: (connectionString: string) => OwnerProvisioningClient,
): Promise<number> {
  try {
    const options = parseOwnerProvisioningArgs(args);
    if (!options) { output(OWNER_PROVISIONING_HELP); return 0; }
    const result = await provisionOwner(options, env, createClient);
    output(result === "created" ? "Pending owner created. Complete the one-time owner setup UI. No worker profile was created."
      : result === "already-pending" ? "Matching pending owner already exists. No account changes made."
      : "Dry run: would create a pending owner. No database writes made.");
    return 0;
  } catch (error) {
    output(error instanceof OwnerProvisioningError ? error.message : "Owner provisioning failed. No success is confirmed.");
    return 1;
  }
}
