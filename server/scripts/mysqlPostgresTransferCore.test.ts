import { describe, expect, it } from "vitest";
import { getSchemaDifferences, insertRowBytes, isCanonicalManagerGeneratedColumn, type ColumnShape } from "./mysqlPostgresTransferCore";

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
