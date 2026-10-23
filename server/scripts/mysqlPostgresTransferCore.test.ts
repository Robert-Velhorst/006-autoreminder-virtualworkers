import { describe, expect, it } from "vitest";
import { getSchemaDifferences, getTransferPairs, LEGACY_UPGRADE_COLUMNS, LEGACY_REPLY_ALIASES,
  OPTIONAL_FEATURE_TABLES, insertRowBytes, isCanonicalManagerGeneratedColumn,
  isNullLegacyUpgradeSelfReference, orderTablesByDependencies, foldIdenticalLegacyReplyAliases, type ColumnShape } from "./mysqlPostgresTransferCore";

describe("exact duplicate legacy reply alias preservation", () => {
  const old: ColumnShape = { name: "lastNonJoyceText", dataType: "text", columnType: "text" };
  const current = { ...old, name: "lastNonWorkerText" };
  const source = new Map([["reply_threads", [old, current]]]);
  it("folds only byte-identical checked aliases without mutating source metadata", async () => {
    const calls: string[][] = [];
    const result = await foldIdenticalLegacyReplyAliases(source, async (...names) => {
      calls.push(names); return { rows: "33", different: "0" };
    });
    expect(calls).toEqual([[old.name, current.name]]);
    expect(result.columns.get("reply_threads")).toEqual([current]);
    expect(result.folded).toEqual([{ oldName: old.name, currentName: current.name, rows: "33" }]);
    expect(source.get("reply_threads")).toEqual([old, current]);
  });
  it.each(["1", "33", "", "unknown"])("rejects different or missing comparison %s", async different => {
    await expect(foldIdenticalLegacyReplyAliases(source, async () => ({ rows: "33", different }))).rejects.toThrow("aliases differ");
  });
  it("rejects missing row-count evidence and retains unproved collisions", async () => {
    await expect(foldIdenticalLegacyReplyAliases(source, async () => ({ rows: "", different: "0" }))).rejects.toThrow("comparison is incomplete");
    const result = await foldIdenticalLegacyReplyAliases(new Map([["reply_threads", [old, { ...current, dataType: "varchar" }]]]), async () => { throw new Error("must not compare incompatible types"); });
    expect(result.folded).toEqual([]);
    expect(getSchemaDifferences(result.columns, new Map([["reply_threads", [current]]]), new Set())).toContain("MySQL alias collision in reply_threads");
  });
  it("does not fold source-only aliases or other tables", async () => {
    const result = await foldIdenticalLegacyReplyAliases(new Map([["reply_threads", [old]], ["other", [old, current]]]), async () => { throw new Error("unexpected comparison"); });
    expect(result.folded).toEqual([]);
  });
});

describe("legacy NULL-only self-reference dependencies", () => {
  const edge = { table: "payment_cycles", dependsOn: "payment_cycles", columns: ["predecessorCycleId"] };
  const id: ColumnShape = { name: "id", dataType: "integer", nullable: false };
  const added: ColumnShape = { name: "predecessorCycleId", dataType: "integer", nullable: true, columnDefault: null };
  const source = new Map([[edge.table, [id]]]);
  const target = new Map([[edge.table, [id, added]]]);
  it("ignores only a known absent-source column inserted as exact NULL", () => {
    expect(isNullLegacyUpgradeSelfReference(edge, source, target)).toBe(true);
    expect(getTransferPairs(edge.table, [id], [id, added]).find(p => p.target.name === added.name)?.defaultValue).toBeNull();
  });
  it("retains source-present references even when nullable", () => {
    expect(isNullLegacyUpgradeSelfReference(edge, new Map([[edge.table, [id, added]]]), target)).toBe(false);
    expect(() => orderTablesByDependencies([edge.table], [edge])).toThrow("Foreign-key cycle");
  });
  it.each([
    { nullable: false }, { columnDefault: "1" }, { generated: true },
    { identity: true }, { dataType: "text" }, { generationExpression: "1" },
  ])("rejects changed post-migration shape %j", change => {
    expect(isNullLegacyUpgradeSelfReference(edge, source,
      new Map([[edge.table, [id, { ...added, ...change }]]]))).toBe(false);
  });
  it("retains unknown, mixed-column, missing-column and external references", () => {
    for (const changed of [
      { ...edge, columns: ["unknown"] }, { ...edge, columns: [added.name, "id"] },
      { ...edge, columns: [] }, { ...edge, columns: [added.name, added.name] },
      { ...edge, dependsOn: "other" },
    ]) expect(isNullLegacyUpgradeSelfReference(changed, source, target)).toBe(false);
    expect(isNullLegacyUpgradeSelfReference(edge, new Map(), target)).toBe(false);
    expect(isNullLegacyUpgradeSelfReference(edge, source, new Map())).toBe(false);
    expect(() => orderTablesByDependencies(["a", "b"], [
      { table: "a", dependsOn: "b" }, { table: "b", dependsOn: "a" },
    ])).toThrow("Foreign-key cycle");
  });
});

const table = "aptlss_manager_runs";
const pgDigest: ColumnShape = {
  name: "reviewDigest", dataType: "character varying", generated: true,
  generationExpression: `(("snapshotJson")::jsonb ->> 'implementationDigest'::text)`,
};
const pgUrgent: ColumnShape = {
  name: "reviewUrgent", dataType: "boolean", generated: true,
  generationExpression: `(("snapshotJson")::jsonb @> '{"interventions": [{"severity": "urgent"}]}'::jsonb)`,
};

describe("fail-closed generated review column compatibility", () => {
  const escapedSource = [
    { name: "reviewDigest", dataType: "varchar", columnType: "varchar(64)", generated: true,
      generationExpression: "json_unquote(json_extract(`snapshotJson`,_utf8mb4\\'$.implementationDigest\\'))" },
    { name: "reviewUrgent", dataType: "tinyint", columnType: "tinyint(1)", generated: true,
      generationExpression: "coalesce(json_contains(json_extract(`snapshotJson`,_utf8mb4\\'$.interventions[*].severity\\'),_utf8mb4\\'\"urgent\"\\'),0)" },
  ];

  it("accepts the exact actual MySQL escaped metadata expressions", () => {
    expect(getSchemaDifferences(new Map([[table, escapedSource]]), new Map([[table, [pgDigest, pgUrgent]]]), new Set())).toEqual([]);
  });

  it.each([
    [0, "implementationDigest", "implementationdigest"],
    [0, "implementationDigest", "implementationDigest_utf8mb4"],
    [0, "implementationDigest", "otherDigest"],
    [1, "severity", "Severity"],
    [1, "urgent", "URGENT"],
    [1, "urgent", "urgent "],
    [1, ",0)", ",1)"],
    [1, "[*]", "[0]"],
  ] as const)("rejects modified escaped literals/operators %s %s", (index, from, to) => {
    const source = escapedSource[index];
    expect(isCanonicalManagerGeneratedColumn(table, { ...source,
      generationExpression: source.generationExpression.replace(from, to) }, "mysql")).toBe(false);
  });
  it("accepts schema expressions and PostgreSQL information_schema casts", () => {
    for (const column of [pgDigest, pgUrgent]) {
      expect(isCanonicalManagerGeneratedColumn(table, column, "postgres")).toBe(true);
      expect(isCanonicalManagerGeneratedColumn("other_table", column, "postgres")).toBe(false);
    }
    const source = [pgDigest, pgUrgent].map(c => ({ ...c, generated: false }));
    expect(getSchemaDifferences(new Map([[table, source]]), new Map([[table, [pgDigest, pgUrgent]]]), new Set())).toEqual([]);
  });

  it.each([
    { generationExpression: null },
    { generationExpression: `("snapshotJson"::jsonb ->> 'otherDigest'::text)` },
    { generationExpression: `("snapshotJson"::jsonb ->> 'implementationDigest'::varchar)` },
    { generationExpression: `("snapshotJson"::jsonb ->> 'implementationDigest'::text) || ''` },
    { generationExpression: `("snapshotJson"::jsonb ->> 'implementationdigest'::text)` },
    { generationExpression: `("snapshotJson"::jsonb ->> 'implementationDigest'::text)'` },
    { generationExpression: `(snapshotJson::jsonb ->> 'implementationDigest'::text)` },
    { name: "arbitraryGenerated" },
    { dataType: "text" },
    { columnType: "varchar(128)" },
  ])("rejects noncanonical metadata %j", change => {
    const column = { ...pgDigest, ...change };
    expect(isCanonicalManagerGeneratedColumn(table, column, "postgres")).toBe(false);
    expect(getSchemaDifferences(new Map([[table, [{ ...column, generated: false }]]]), new Map([[table, [column]]]), new Set()).join(" ")).toContain("generated column");
  });

  it("requires a canonical generated target for a generated source", () => {
    const source: ColumnShape = {
      name: "reviewDigest", dataType: "varchar", columnType: "varchar(64)", generated: true,
      generationExpression: "json_unquote(json_extract(`snapshotJson`,_utf8mb4'$.implementationDigest'))",
    };
    expect(isCanonicalManagerGeneratedColumn(table, source, "mysql")).toBe(true);
    const differences = (s: ColumnShape, t: ColumnShape) => getSchemaDifferences(new Map([[table, [s]]]), new Map([[table, [t]]]), new Set());
    expect(differences(source, pgDigest)).toEqual([]);
    expect(differences(source, { ...pgDigest, generated: false }).join(" ")).toContain("MySQL generated");
    expect(differences({ ...source, generationExpression: "1" }, pgDigest).join(" ")).toContain("MySQL generated");
    expect(isCanonicalManagerGeneratedColumn(table, {
      ...source, generationExpression: "json_unquote(json_extract(`snapshotJson`,_utf8mb4'$.implementationDigest_utf8mb4'))",
    }, "mysql")).toBe(false);
  });

  it("still rejects missing generated counterpart columns", () => {
    expect(getSchemaDifferences(new Map([[table, []]]), new Map([[table, [pgDigest]]]), new Set())).toContain(`PostgreSQL has unexpected column ${table}.reviewDigest`);
  });

  it("rejects arbitrary generated columns even on an allowed target-only table", () => {
    expect(getSchemaDifferences(new Map(), new Map([["new_table", [pgDigest]]]), new Set(["new_table"])))
      .toContain("PostgreSQL generated column new_table.reviewDigest cannot be copied");
  });

  it("accounts for UTF-8, buffers, nulls, and parameter overhead", () => {
    expect(insertRowBytes(["\u20ac", Buffer.alloc(7), null, 123])).toBe(4 * 16 + 3 + 7 + 3);
  });
});

describe("explicit legacy upgrade manifest", () => {
  // Independent observed metadata shapes. No private file or source records are needed.
  const observed: Record<string, Record<string, string>> = {
    aptlss_manager_state: { currentCheckId: "integer", historyScopeHash: "varchar(64)" },
    aptlss_manager_updates: { reportKind: "varchar(24)", actionId: "varchar(256)", assessmentRunId: "integer", requestKey: "varchar(36)" },
    browser_tab_states: { captureSequence: "bigint", sourceCapturedAt: "timestamp" },
    digest_jobs: { windowKey: "varchar(96)", deliveryPhase: "varchar(24)", recipientEmail: "text", subject: "text", html: "text",
      payloadHash: "varchar(64)", attemptId: "varchar(64)", attemptCount: "integer", attemptedAt: "timestamp", nextAttemptAt: "timestamp",
      providerReceipt: "text", reconciledAt: "timestamp", reconciledBy: "integer", reconciliationNote: "text" },
    payment_cycles: { predecessorCycleId: "integer" },
    scheduled_jobs: { approvedByUserId: "integer", approvedSessionEpoch: "bigint", approvedAt: "timestamp", approvalHash: "varchar(64)" },
    time_entries: { trackedUserId: "integer", trackedProfileId: "integer" },
    users: { sessionEpoch: "bigint" },
  };
  const defaults: Record<string, string> = { reportKind: "'update'::character varying", captureSequence: "0", attemptCount: "0", sessionEpoch: "1" };
  const cases = Object.entries(observed).flatMap(([table, fields]) => Object.entries(fields).map(([name, type]) => ({ table, column: {
    name, dataType: type.startsWith("varchar") ? "character varying" : type === "timestamp" ? "timestamp without time zone" : type,
    columnType: type, nullable: !(name in defaults), columnDefault: defaults[name] ?? null, generated: false,
  } })));

  it("covers exactly all 30 observed additions", () => {
    expect(LEGACY_UPGRADE_COLUMNS.map(c => `${c.table}.${c.name}:${c.type}`).sort())
      .toEqual(cases.map(({ table, column: c }) => `${table}.${c.name}:${c.columnType}`).sort());
    expect(cases).toHaveLength(30);
  });

  it.each(cases)("accepts only the exact shape of $table.$column.name", ({ table, column }) => {
    const differences = (c: ColumnShape) => getSchemaDifferences(new Map([[table, []]]), new Map([[table, [c]]]), new Set());
    expect(differences(column)).toEqual([]);
    for (const change of [
      { nullable: !column.nullable }, { dataType: "unknown" }, { generated: true },
      { generationExpression: "1" }, { identity: true }, { columnDefault: "now()" },
      { name: `${column.name}Unknown` },
      ...(column.columnType.startsWith("varchar") ? [{ columnType: "varchar(999)" }] : []),
      ...(column.columnDefault !== null ? [{ columnDefault: null }, { columnDefault: "'context'::character varying" }, { columnDefault: "999" }] : []),
    ]) expect(differences({ ...column, ...change }).length).toBeGreaterThan(0);
    expect(getSchemaDifferences(new Map([["unrelated", []]]), new Map([["unrelated", [column]]]), new Set()).length).toBeGreaterThan(0);
    const pairs = getTransferPairs(table, [], [column]);
    expect(pairs[0].defaultValue).toBe(column.nullable ? null : column.name === "reportKind" ? "update" : column.name === "sessionEpoch" ? 1 : 0);
    // A source-present field always wins, even if the target has a migration default.
    expect(getTransferPairs(table, [column], [column])[0]).not.toHaveProperty("defaultValue");
  });

  it.each(Object.entries(LEGACY_REPLY_ALIASES))("maps %s and rejects old/new collisions", (oldName, newName) => {
    const old = { name: oldName, dataType: "text" };
    const current = { ...old, name: newName };
    expect(getTransferPairs("reply_threads", [old], [current])[0]).toEqual({ source: old, target: current });
    expect(() => getTransferPairs("reply_threads", [old, current], [current])).toThrow("alias collision");
    expect(() => getTransferPairs("reply_threads", [old], [old, current])).toThrow("alias collision");
    expect(() => getTransferPairs("other", [old], [current])).toThrow("missing");
  });

  it("allows only named optional tables and still copies source-present feature tables", () => {
    const names = ["aptlss_manager_checks", "assignment_events", "atis_analysis_items", "atis_analysis_requests", "atis_chatbot_conversations",
      "atis_checklist_sync", "digest_job_items", "financial_ledger_events", "revoked_sessions", "worker_lifecycle_audit"];
    expect([...OPTIONAL_FEATURE_TABLES].sort()).toEqual(names.sort());
    const target = new Map(names.map(name => [name, [] as ColumnShape[]]));
    expect(getSchemaDifferences(new Map(), target, new Set())).toEqual([]);
    expect(getSchemaDifferences(target, target, new Set(names))).toEqual([]);
    expect(getSchemaDifferences(new Map(), new Map([["unknown", []]]), new Set())).toContain("PostgreSQL has unexpected table unknown");
    expect(getSchemaDifferences(new Map([["unknown", []]]), new Map(), new Set())).toContain("PostgreSQL is missing table unknown");
    expect(getSchemaDifferences(new Map([["atis_checklist_completion", []]]), new Map([["atis_checklist_completion", []]]), new Set(["atis_checklist_completion"]))).toEqual([]);
  });
});
