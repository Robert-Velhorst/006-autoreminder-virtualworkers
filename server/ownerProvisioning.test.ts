import { describe, expect, it, vi } from "vitest";
import { parseOwnerProvisioningArgs, provisionOwner, runOwnerProvisioningCli, type OwnerProvisioningClient } from "./ownerProvisioning";

const env = {
  DATABASE_URL: "postgresql://synthetic:private-secret@127.0.0.1/recovery_test?sslmode=disable",
  OWNER_BOOTSTRAP_OPEN_ID: "synthetic-founder",
  OWNER_BOOTSTRAP_TOKEN: "synthetic-token-at-least-24-characters",
};
const options = { username: "synthetic-founder", name: "Synthetic Founder", execute: true };
type Row = { openId: string; name: string; role: string; passwordHash: string | null; loginMethod: string | null };
const pending = (): Row => ({ openId: options.username, name: options.name, role: "admin", passwordHash: null, loginMethod: "local" });

// A transactional native-client double, shared by connections, with an exclusive lock queue.
function database(initial: Row[] = [], failOn = "") {
  let rows = structuredClone(initial);
  let tail = Promise.resolve();
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const factory = vi.fn(() => {
    let staged: Row | undefined;
    let unlock: (() => void) | undefined;
    const end = vi.fn(async () => { unlock?.(); unlock = undefined; });
    return {
      connect: vi.fn(async () => {}), end,
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        statements.push({ text, params });
        if (failOn && text.startsWith(failOn)) throw new Error(`private db failure ${env.DATABASE_URL} ${env.OWNER_BOOTSTRAP_TOKEN}`);
        if (text.startsWith("LOCK TABLE")) {
          const previous = tail;
          tail = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
        } else if (text.startsWith("SELECT")) {
          return { rows: structuredClone(rows.filter(row => row.role === "admin" || row.openId.trim().toLowerCase() === String(params[0]).toLowerCase())) };
        } else if (text.startsWith("INSERT")) {
          staged = { ...pending(), openId: String(params[0]), name: String(params[1]) };
        } else if (text === "COMMIT" || text === "ROLLBACK") {
          if (text === "COMMIT" && staged) rows.push(staged);
          staged = undefined;
          unlock?.(); unlock = undefined;
        }
        return { rows: [] };
      }),
    } as unknown as OwnerProvisioningClient;
  });
  return { factory, statements, rows: () => structuredClone(rows) };
}

describe("operator owner arguments and configuration", () => {
  it("defaults to dry run and parses explicit modes", () => {
    expect(parseOwnerProvisioningArgs(["--username", options.username, "--name", options.name])).toEqual({ ...options, execute: false });
    expect(parseOwnerProvisioningArgs(["--username=x", "--name=X", "--execute"])?.execute).toBe(true);
    expect(parseOwnerProvisioningArgs(["--username=x", "--name=X", "--dry-run"])?.execute).toBe(false);
    expect(parseOwnerProvisioningArgs(["--help"])).toBeNull();
  });
  it.each([
    [], ["--execute", "--dry-run"], ["--username=x", "--username=y"], ["positional"],
    ["--password=super-secret"], ["--token=super-secret"], ["--database-url=super-secret"], ["--execute=false"],
  ].map(args => ({ args })))("rejects missing, duplicate, ambiguous or secret arguments: %j", ({ args }) => {
    expect(() => parseOwnerProvisioningArgs(args)).toThrow();
    try { parseOwnerProvisioningArgs(args); } catch (error) { expect(String(error)).not.toContain("super-secret"); }
  });
  it.each([
    { DATABASE_URL: undefined }, { OWNER_BOOTSTRAP_OPEN_ID: undefined }, { OWNER_BOOTSTRAP_OPEN_ID: "different" },
    { OWNER_BOOTSTRAP_TOKEN: undefined }, { OWNER_BOOTSTRAP_TOKEN: "short" }, { OWNER_BOOTSTRAP_TOKEN: ` ${env.OWNER_BOOTSTRAP_TOKEN}` },
    { DATABASE_URL: "postgresql://synthetic:secret@8.8.8.8/recovery_test" },
    { DATABASE_URL: "postgresql://synthetic:secret@db.example.com/recovery_test" },
    { DATABASE_URL: "postgresql://synthetic:secret@localhost/recovery_test?host=8.8.8.8" },
    { DATABASE_URL: "postgresql://synthetic:secret@localhost/recovery_test?sslmode=no-verify" },
    { DATABASE_URL: "postgresql://synthetic:secret@localhost/recovery_test?sslmode=disable&sslmode=verify-full" },
    { DATABASE_URL: "postgresql://localhost/recovery_test" },
    { DATABASE_URL: "mysql://synthetic:secret@localhost/recovery_test" },
  ])("fails before connecting for invalid private config %j", async override => {
    const db = database();
    await expect(provisionOwner(options, { ...env, ...override }, db.factory)).rejects.toThrow();
    expect(db.factory).not.toHaveBeenCalled();
  });
  it.each(["postgres", "10.1.2.3", "172.16.2.3", "192.168.2.3", "[fd00::1]", "[::1]", "db.internal"])("accepts private target %s", async host => {
    const db = database();
    await expect(provisionOwner({ ...options, execute: false }, { ...env, DATABASE_URL: `postgresql://synthetic:secret@${host}/recovery_test` }, db.factory)).resolves.toBe("would-create");
  });
  it.each([{ username: "bad space" }, { username: "a".repeat(65) }, { name: " " }, { name: "bad\nname" }, { name: "name " }])("rejects invalid account fields %j", async override => {
    const db = database();
    await expect(provisionOwner({ ...options, ...override }, env, db.factory)).rejects.toThrow();
    expect(db.factory).not.toHaveBeenCalled();
  });
});

describe("pending owner transaction", () => {
  it("dry run takes the lock, checks state, rolls back and never inserts", async () => {
    const db = database();
    expect(await provisionOwner({ ...options, execute: false }, env, db.factory)).toBe("would-create");
    expect(db.rows()).toEqual([]);
    const commands = db.statements.map(statement => statement.text);
    expect(commands[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(commands.findIndex(text => text.startsWith("LOCK TABLE"))).toBeLessThan(commands.findIndex(text => text.startsWith("SELECT")));
    expect(commands).toContain('LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE');
    expect(commands.at(-1)).toBe("ROLLBACK");
    expect(commands.some(text => text.startsWith("INSERT"))).toBe(false);
  });
  it("creates only the pending admin, with bound values and no secrets, then retries without writes", async () => {
    const db = database();
    expect(await provisionOwner(options, env, db.factory)).toBe("created");
    expect(db.rows()).toEqual([pending()]);
    const insertion = db.statements.find(statement => statement.text.startsWith("INSERT"))!;
    expect(insertion.params).toEqual([options.username, options.name]);
    expect(insertion.text).not.toContain(options.name);
    expect(await provisionOwner(options, env, db.factory)).toBe("already-pending");
    expect(await provisionOwner({ ...options, execute: false }, env, db.factory)).toBe("already-pending");
    expect(db.statements.filter(statement => statement.text.startsWith("INSERT"))).toHaveLength(1);
    expect(JSON.stringify(db.statements)).not.toMatch(/va_profiles|synthetic-token|private-secret/);
  });
  it.each([
    { role: "worker" }, { role: "user" }, { passwordHash: "existing-private-hash" }, { passwordHash: "" },
    { name: "Other Name" }, { loginMethod: "trello" }, { loginMethod: null },
    { openId: options.username.toUpperCase(), role: "user" }, { openId: ` ${options.username} `, role: "user" },
    { openId: "different-owner" },
  ])("refuses collisions without promotion/reset, including in dry run: %j", async override => {
    for (const execute of [false, true]) {
      const initial = [{ ...pending(), ...override }];
      const db = database(initial);
      await expect(provisionOwner({ ...options, execute }, env, db.factory)).rejects.toThrow(/refused/);
      expect(db.rows()).toEqual(initial);
      expect(db.statements.at(-1)?.text).toBe("ROLLBACK");
      expect(db.statements.some(statement => statement.text.startsWith("INSERT"))).toBe(false);
    }
  });
  it("refuses another admin even alongside the correct pending owner", async () => {
    const db = database([pending(), { ...pending(), openId: "other-admin" }]);
    await expect(provisionOwner(options, env, db.factory)).rejects.toThrow(/different administrator/);
  });
  it("preserves unrelated workers without creating a VA profile", async () => {
    const worker = { ...pending(), openId: "synthetic-worker", role: "worker" };
    const db = database([worker]);
    await provisionOwner(options, env, db.factory);
    expect(db.rows()).toEqual([worker, pending()]);
  });
  it.each(["LOCK TABLE", "SELECT", "INSERT", "COMMIT"])("rolls back and sanitizes native failure at %s", async failOn => {
    const db = database([], failOn);
    await expect(provisionOwner(options, env, db.factory)).rejects.toThrow("No success is confirmed");
    expect(db.rows()).toEqual([]);
    expect(db.statements.at(-1)?.text).toBe("ROLLBACK");
  });
  it("serializes same-owner retry and rejects concurrent conflicting owners", async () => {
    const same = database();
    expect(await Promise.all([provisionOwner(options, env, same.factory), provisionOwner(options, env, same.factory)])).toEqual(["created", "already-pending"]);
    expect(same.rows()).toHaveLength(1);
    const different = database();
    const results = await Promise.allSettled([
      provisionOwner(options, env, different.factory),
      provisionOwner({ ...options, username: "other" }, { ...env, OWNER_BOOTSTRAP_OPEN_ID: "other" }, different.factory),
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(different.rows()).toHaveLength(1);
  });
  it("CLI help never connects and CLI errors/output never disclose secrets", async () => {
    const output = vi.fn();
    const db = database([], "SELECT");
    expect(await runOwnerProvisioningCli(["--help"], {}, output, db.factory)).toBe(0);
    expect(db.factory).not.toHaveBeenCalled();
    expect(await runOwnerProvisioningCli(["--username", options.username, "--name", options.name], env, output, db.factory)).toBe(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain(env.OWNER_BOOTSTRAP_TOKEN);
    expect(JSON.stringify(output.mock.calls)).not.toContain(env.DATABASE_URL);
    expect(await runOwnerProvisioningCli(["--username", options.username, "--name", options.name], env, output, database().factory)).toBe(0);
    expect(output).toHaveBeenLastCalledWith("Dry run: would create a pending owner. No database writes made.");
  });
});
