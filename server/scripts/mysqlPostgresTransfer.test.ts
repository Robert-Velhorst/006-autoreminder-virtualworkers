import { describe, expect, it } from "vitest";
import {
  canonicalizeCell,
  isCanonicalQueueBootstrap,
  getSequenceReset,
  getSchemaDifferences,
  orderTablesByDependencies,
  quoteMySqlIdentifier,
  quotePostgresIdentifier,
  transformSourceValue,
} from "./mysqlPostgresTransferCore";

describe("MySQL to PostgreSQL transfer safeguards", () => {
  const queueColumns = [
    { name: "id", dataType: "integer", nullable: false },
    { name: "vaId", dataType: "integer", nullable: true },
    { name: "token", dataType: "character varying", nullable: true },
    { name: "leaseUntil", dataType: "timestamp without time zone", nullable: true },
  ];
  const seeds = () => [1, 2, 3, 4].map(id => ({ id, vaId: null, token: null, leaseUntil: null }));

  it("recognizes only the exact complete unleased bootstrap rows and column shape", () => {
    expect(isCanonicalQueueBootstrap(seeds().reverse(), queueColumns)).toBe(true);
    for (const rows of [
      [], seeds().slice(1), [...seeds(), { id: 5, vaId: null, token: null, leaseUntil: null }],
      [seeds()[0], seeds()[0], ...seeds().slice(2)],
      seeds().map(row => ({ ...row, id: String(row.id) })),
      seeds().map(row => ({ ...row, unknown: null })),
      seeds().map(({ token, ...row }) => row),
      seeds().map(row => ({ ...row, vaId: 0 })),
      seeds().map(row => ({ ...row, token: "" })),
      seeds().map(row => ({ ...row, leaseUntil: "2000-01-01" })),
      seeds().map(row => ({ ...row, leaseUntil: "2099-01-01" })),
    ]) expect(isCanonicalQueueBootstrap(rows, queueColumns)).toBe(false);
    for (const columns of [
      queueColumns.slice(1), [...queueColumns, { name: "extra", dataType: "integer", nullable: true }],
      queueColumns.map(c => c.name === "id" ? { ...c, dataType: "bigint" } : c),
      queueColumns.map(c => c.name === "token" ? { ...c, nullable: false } : c),
      queueColumns.map(c => ({ ...c, generated: true })),
      [queueColumns[0], queueColumns[0], ...queueColumns.slice(2)],
    ]) expect(isCanonicalQueueBootstrap(seeds(), columns)).toBe(false);
  });

  it('allows only the two nullable canonical timer additions, never arbitrary parity drift', () => {
    const source = new Map([['time_entries', [{ name: 'vaId', dataType: 'int' }]]]);
    const canonical = [
      { name: 'vaId', dataType: 'integer' },
      { name: 'trackedUserId', dataType: 'integer', nullable: true },
      { name: 'trackedProfileId', dataType: 'integer', nullable: true },
    ];
    expect(getSchemaDifferences(source, new Map([['time_entries', canonical]]), new Set())).toEqual([]);
    for (const change of [
      { name: 'trackedUserId', dataType: 'integer', nullable: false },
      { name: 'trackedUserId', dataType: 'text', nullable: true },
      { name: 'unexpectedOwner', dataType: 'integer', nullable: true },
    ]) {
      expect(getSchemaDifferences(source, new Map([['time_entries', [canonical[0], change]]]), new Set()))
        .toContain(`PostgreSQL has unexpected column time_entries.${change.name}`);
    }
    expect(getSchemaDifferences(new Map([['other_table', []]]),
      new Map([['other_table', [canonical[1]]]]), new Set()))
      .toContain('PostgreSQL has unexpected column other_table.trackedUserId');
  });
  it("quotes only simple identifiers", () => {
    expect(quoteMySqlIdentifier("task_items")).toBe("`task_items`");
    expect(quotePostgresIdentifier("task_items")).toBe('"task_items"');
    expect(() => quoteMySqlIdentifier("items; DROP TABLE users")).toThrow(
      "Unsafe"
    );
    expect(() => quotePostgresIdentifier('items"; DROP TABLE users')).toThrow(
      "Unsafe"
    );
  });

  it("requires exact table and column parity except explicitly new target tables", () => {
    const source = new Map([
      [
        "users",
        [
          { name: "id", dataType: "int" },
          { name: "email", dataType: "varchar" },
        ],
      ],
    ]);
    const target = new Map([
      [
        "users",
        [
          { name: "id", dataType: "integer" },
          { name: "email", dataType: "text" },
        ],
      ],
      ["new_feature", [{ name: "id", dataType: "integer" }]],
    ]);
    expect(
      getSchemaDifferences(source, target, new Set(["new_feature"]))
    ).toEqual([]);
    expect(
      getSchemaDifferences(
        source,
        new Map([
          [
            "users",
            [
              { name: "id", dataType: "integer" },
              { name: "legacy", dataType: "text" },
            ],
          ],
          ["unexpected", [{ name: "id", dataType: "integer" }]],
        ]),
        new Set(["new_feature"])
      )
    ).toEqual([
      "PostgreSQL has unexpected column users.legacy",
      "PostgreSQL has unexpected table unexpected",
      "PostgreSQL is missing expected new table new_feature",
      "PostgreSQL is missing users.email",
    ]);
  });

  it("refuses generated columns instead of attempting to write them", () => {
    expect(
      getSchemaDifferences(
        new Map([
          [
            "source_table",
            [{ name: "computed", dataType: "int", generated: true }],
          ],
        ]),
        new Map([
          ["source_table", [{ name: "computed", dataType: "integer" }]],
        ]),
        new Set()
      )
    ).toEqual([
      "MySQL generated column source_table.computed cannot be copied",
    ]);

    expect(
      getSchemaDifferences(
        new Map([["source_table", [{ name: "computed", dataType: "int" }]]]),
        new Map([
          [
            "source_table",
            [{ name: "computed", dataType: "integer", generated: true }],
          ],
        ]),
        new Set()
      )
    ).toEqual([
      "PostgreSQL generated column source_table.computed cannot be copied",
    ]);
  });

  it("sets identity sequences safely when imported IDs are empty or non-positive", () => {
    expect(getSequenceReset(null, false)).toEqual({
      value: "1",
      isCalled: false,
    });
    expect(getSequenceReset("0", true)).toEqual({
      value: "1",
      isCalled: false,
    });
    expect(getSequenceReset("-4", true)).toEqual({
      value: "1",
      isCalled: false,
    });
    expect(getSequenceReset("29", true)).toEqual({
      value: "29",
      isCalled: true,
    });
  });

  it("preserves source counters beyond surviving rows without rounding big integers", () => {
    expect(getSequenceReset("29", true, "100")).toEqual({ value: "100", isCalled: false });
    expect(getSequenceReset(null, false, "100")).toEqual({ value: "100", isCalled: false });
    expect(getSequenceReset("29", true, "30")).toEqual({ value: "29", isCalled: true });
    expect(getSequenceReset("9007199254740993", true, "9007199254740999")).toEqual({ value: "9007199254740999", isCalled: false });
    expect(() => getSequenceReset("29", true, "20")).toThrow("precedes copied rows");
    for (const invalid of ["", "0", "-1", "1.5", "1e3", " 100", "01"])
      expect(() => getSequenceReset(null, false, invalid)).toThrow("Invalid source");
  });

  it("orders parent tables before dependent tables and rejects cycles", () => {
    expect(
      orderTablesByDependencies(
        ["child", "parent", "independent"],
        [{ table: "child", dependsOn: "parent" }]
      )
    ).toEqual(["independent", "parent", "child"]);
    expect(() =>
      orderTablesByDependencies(
        ["a", "b"],
        [
          { table: "a", dependsOn: "b" },
          { table: "b", dependsOn: "a" },
        ]
      )
    ).toThrow("Foreign-key cycle");
  });

  it("normalizes MySQL booleans and fails closed on unsupported values", () => {
    expect(transformSourceValue(1, "boolean", "users.enabled")).toBe(true);
    expect(transformSourceValue("0", "boolean", "users.enabled")).toBe(false);
    expect(() => transformSourceValue(2, "boolean", "users.enabled")).toThrow(
      "users.enabled"
    );
  });

  it("rejects zero dates and canonicalizes JSON and timestamps", () => {
    expect(() =>
      transformSourceValue(
        "0000-00-00 00:00:00",
        "timestamp",
        "tasks.createdAt"
      )
    ).toThrow("zero date");
    expect(
      canonicalizeCell(
        { z: 1, a: [true, "x"] },
        "json",
        "text",
        "evidence.payload"
      )
    ).toBe('{"a":[true,"x"],"z":1}');
    expect(
      canonicalizeCell(
        "2026-10-14T12:30:00.120000",
        "datetime",
        "timestamp without time zone",
        "tasks.dueAt"
      )
    ).toBe("2026-10-14 12:30:00.12");
  });
});
