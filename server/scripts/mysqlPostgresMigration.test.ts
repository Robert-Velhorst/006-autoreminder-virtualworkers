import { afterEach, describe, expect, it, vi } from "vitest";
import { runMysqlPostgresMigration } from "../../scripts/migrate-mysql-to-postgres";
import { removeQueueBootstrap } from "./mysqlPostgresTransferCore";

const drivers = vi.hoisted(() => ({ source: null as any, target: null as any }));
vi.mock("mysql2", () => ({ default: { createConnection: () => drivers.source } }));
vi.mock("pg", () => ({
  Client: class { constructor() { return drivers.target; } },
  types: { setTypeParser: vi.fn() },
}));

const queue = "aptlss_manager_queue_slots";
const targetOnly = ["atis_chatbot_conversations", "atis_checklist_completion", "atis_checklist_sync"];
const columns = [
  { name: "id", dataType: "integer", nullable: false },
  { name: "vaId", dataType: "integer", nullable: true },
  { name: "token", dataType: "character varying", nullable: true },
  { name: "leaseUntil", dataType: "timestamp without time zone", nullable: true },
];
type Row = Record<string, unknown>;
const seeds = (): Row[] => [1, 2, 3, 4].map(id => ({ id, vaId: null, token: null, leaseUntil: null }));
const env = {
  LEGACY_MYSQL_DATABASE_URL: "mysql://reader:synthetic@source.invalid/fixture",
  DATABASE_URL: "postgresql://migrator:synthetic@target.invalid/fixture?sslmode=verify-full",
};

function fixture(options: {
  rows?: Row[]; sourceRows?: Row[]; sourceAbsent?: boolean; otherRows?: boolean;
  onLock?: (rows: Row[]) => void; onRecheck?: (rows: Row[]) => void;
  failReconciliation?: boolean; wrongDelete?: boolean; failSetup?: boolean;
  failCopy?: boolean; corruptDigest?: boolean;
} = {}) {
  let rows = structuredClone(options.rows ?? seeds());
  let snapshot: Row[] | undefined;
  let locked = false;
  let inspections = 0;
  const events: string[] = [];
  const sourceRows = options.sourceRows ?? [
    { id: 1, vaId: 8, token: "retained-source-lease", leaseUntil: "2026-10-22 10:00:00" },
    { id: 9, vaId: null, token: null, leaseUntil: null },
  ];
  const targetColumns = [queue, ...targetOnly].flatMap(tableName =>
    (tableName === queue ? columns : [columns[0]]).map(c => ({
      tableName, columnName: c.name, dataType: c.dataType, udtName: c.dataType,
      generated: "NEVER", identity: "NO", nullable: c.nullable ? "YES" : "NO", columnDefault: null,
    })));
  const sourceQuery = async (sql: string) => {
    events.push(`source:${sql}`);
    if (sql.includes("information_schema.tables")) return [options.sourceAbsent ? [] : [{ tableName: queue, engine: "InnoDB" }]];
    if (sql.includes("information_schema.columns")) return [options.sourceAbsent ? [] : columns.map((c, i) => ({
      tableName: queue, columnName: c.name, dataType: c.dataType, ordinalPosition: i + 1, extra: "",
    }))];
    if (sql.includes("information_schema.TABLE_CONSTRAINTS")) return [[{ tableName: queue, columnName: "id", ordinalPosition: 1 }]];
    if (sql.startsWith("SELECT COUNT")) return [[{ count: String(sourceRows.length) }]];
    if (/^(SET |START TRANSACTION|COMMIT|ROLLBACK)/.test(sql)) return [[]];
    throw new Error(`Unexpected source SQL: ${sql}`);
  };
  drivers.source = {
    promise: () => ({ query: sourceQuery, end: async () => {} }),
    query: () => ({ stream: () => (async function* () { for (const row of sourceRows) yield row; })() }),
  };
  drivers.target = {
    connect: async () => {}, end: async () => {},
    query: async (sql: string, values: unknown[] = []) => {
      events.push(sql);
      if (sql === "BEGIN") { snapshot = structuredClone(rows); return { rows: [] }; }
      if (sql === "ROLLBACK") { rows = snapshot!; snapshot = undefined; return { rows: [] }; }
      if (sql === "COMMIT") { snapshot = undefined; return { rows: [] }; }
      if (sql.startsWith("SELECT set_config")) {
        if (options.failSetup) throw new Error("setup failure");
        return { rows: [] };
      }
      if (sql.startsWith("LOCK TABLE")) {
        expect(snapshot).toBeDefined();
        if (!locked) options.onLock?.(rows);
        locked = true;
        return { rows: [] };
      }
      if (sql.startsWith("SAVEPOINT")) { expect(snapshot).toBeDefined(); return { rows: [] }; }
      if (/^(SET LOCAL|RELEASE SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.includes("current_schema() AS schema")) return { rows: [{ schema: "public" }] };
      if (sql.includes("information_schema.columns")) return { rows: targetColumns };
      if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) return { rows: [{ tableName: queue, columnName: "id", ordinalPosition: 1 }] };
      if (sql.includes("tc.constraint_type = 'FOREIGN KEY'")) return { rows: [] };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ hasRows: options.otherRows ?? false }] };
      if (sql.startsWith('SELECT * FROM "public".')) {
        if (++inspections === 2) options.onRecheck?.(rows);
        return { rows: structuredClone(rows.slice(0, 5)) };
      }
      if (sql.startsWith("DELETE FROM")) {
        expect(locked).toBe(true);
        expect(snapshot).toBeDefined();
        expect(sql).toContain('"vaId" IS NULL AND "token" IS NULL AND "leaseUntil" IS NULL');
        const removed = structuredClone(rows);
        rows = [];
        return { rows: options.wrongDelete ? removed.slice(1) : removed };
      }
      if (sql.startsWith("INSERT INTO")) {
        if (options.failCopy) throw new Error("copy failure");
        const names = [...sql.split("VALUES")[0].matchAll(/"([^"]+)"/g)].map(m => m[1]).slice(2);
        for (let i = 0; i < values.length; i += names.length)
          rows.push(Object.fromEntries(names.map((name, j) => [name, values[i + j]])));
        return { rows: [] };
      }
      if (sql.startsWith("SELECT ") && sql.includes('FROM "public".')) {
        if (options.failReconciliation) throw new Error("reconciliation failure");
        const result = structuredClone(rows);
        if (options.corruptDigest) result[0].token = "not-the-source-value";
        return { rows: result };
      }
      throw new Error(`Unexpected target SQL: ${sql}`);
    },
  };
  return { events, rows: () => rows, sourceRows };
}

afterEach(() => vi.restoreAllMocks());

describe("bootstrap seed replacement in the actual transfer transaction (mock drivers)", () => {
  it("previews the exact seed without deletion and reports it separately", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runMysqlPostgresMigration(["preflight"], env);
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.bootstrapSeedTables).toEqual([queue]);
    expect(report.nonEmptyTargetTables).toEqual([]);
    expect(report.writesPerformed).toBe(false);
    expect(f.rows()).toEqual(seeds());
    expect(f.events.some(sql => sql.startsWith("DELETE") || sql === "BEGIN")).toBe(false);
  });

  it("rechecks under lock, replaces only defaults and reconciles every source row", async () => {
    const f = fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runMysqlPostgresMigration(["copy", "--execute"], env);
    expect(f.rows()).toEqual(f.sourceRows);
    const index = (prefix: string) => f.events.findIndex(sql => sql.startsWith(prefix));
    expect(index("BEGIN")).toBeLessThan(index("LOCK TABLE"));
    expect(index("LOCK TABLE")).toBeLessThan(index("SAVEPOINT"));
    expect(index("SAVEPOINT")).toBeLessThan(index("DELETE"));
    expect(index("DELETE")).toBeLessThan(index("INSERT"));
    expect(index("INSERT")).toBeLessThan(index("COMMIT"));
    expect(f.events.filter(sql => sql.startsWith('SELECT * FROM "public".'))).toHaveLength(2);
  });

  it.each([
    ["missing", seeds().slice(1)],
    ["extra", [...seeds(), { id: 5, vaId: null, token: null, leaseUntil: null }]],
    ["worker", seeds().map(row => ({ ...row, vaId: 8 }))],
    ["token", seeds().map(row => ({ ...row, token: "changed" }))],
    ["active lease", seeds().map(row => ({ ...row, leaseUntil: "2099-01-01" }))],
    ["expired lease", seeds().map(row => ({ ...row, leaseUntil: "2000-01-01" }))],
  ])("rejects %s seed rows without deleting anything", async (_, rows) => {
    const f = fixture({ rows: rows as Row[] });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow("Preflight failed");
    expect(f.rows()).toEqual(rows);
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(false);
    expect(f.events).toContain("ROLLBACK");
  });

  it("still rejects arbitrary nonempty target tables", async () => {
    const f = fixture({ otherRows: true });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow("Preflight failed");
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(false);
  });

  it("keeps seeds and schema rejection when the source queue table is absent", async () => {
    const f = fixture({ sourceAbsent: true });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow(`PostgreSQL has unexpected table ${queue}`);
    expect(f.rows()).toEqual(seeds());
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(false);
    await expect(removeQueueBootstrap(drivers.target, columns, false)).rejects.toThrow("requires the source table");
  });

  it("rejects changes racing the lock acquisition", async () => {
    const f = fixture({ onLock: rows => { rows[0].token = "new-lease"; } });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow("Preflight failed");
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(false);
  });

  it.each(["changed", "missing", "extra"])("revalidates %s rows after preflight before deletion", async mode => {
    const f = fixture({ onRecheck: rows => {
      if (mode === "changed") rows[0].token = "unexpected-change";
      if (mode === "missing") rows.pop();
      if (mode === "extra") rows.push({ id: 5, vaId: null, token: null, leaseUntil: null });
    } });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow("bootstrap changed");
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(false);
    expect(f.events).toContain("ROLLBACK");
  });

  it.each(["copy", "reconciliation", "digest", "delete result"])("rolls back seed removal on %s failure", async failure => {
    const f = fixture({ failReconciliation: failure === "reconciliation", wrongDelete: failure === "delete result",
      failCopy: failure === "copy", corruptDigest: failure === "digest" });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow();
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(true);
    expect(f.events).toContain("ROLLBACK");
    expect(f.events).not.toContain("COMMIT");
    expect(f.rows()).toEqual(seeds());
  });

  it("rolls back failures immediately after BEGIN", async () => {
    const f = fixture({ failSetup: true });
    await expect(runMysqlPostgresMigration(["copy", "--execute"], env)).rejects.toThrow("setup failure");
    expect(f.events).toContain("ROLLBACK");
  });

  it("continues to allow a truly empty target", async () => {
    const f = fixture({ rows: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runMysqlPostgresMigration(["copy", "--execute"], env);
    expect(f.rows()).toEqual(f.sourceRows);
    expect(f.events.some(sql => sql.startsWith("DELETE"))).toBe(false);
  });

  it("requires explicit execute authorization before opening connections", async () => {
    const f = fixture();
    await expect(runMysqlPostgresMigration(["copy"], env)).rejects.toThrow("explicit --execute");
    expect(f.events).toEqual([]);
  });

  it("refuses seed removal outside a transaction before any delete", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SAVEPOINT")) throw new Error("no transaction");
      return { rows: [] };
    });
    await expect(removeQueueBootstrap({ query }, columns, true)).rejects.toThrow("no transaction");
    expect(query.mock.calls).toEqual([["SAVEPOINT queue_bootstrap_replacement"]]);
  });
});
