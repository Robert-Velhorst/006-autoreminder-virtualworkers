import { describe, expect, it, vi } from "vitest";
import { verifyGeneratedRecords } from "./verify-generated-records.mjs";

const columns = [{ name: "reviewDigest", expression: "JSON_UNQUOTE(JSON_EXTRACT(snapshotJson, '$.implementationDigest'))" }];
function fixture(total, batches) {
  const query = vi.fn(async sql => {
    if (sql.startsWith("SELECT COUNT(*) AS total")) return [[{ total }]];
    if (sql.includes("COUNT(*) AS checked")) return [[batches.shift()]];
    return [[]];
  });
  return { query, beginTransaction: vi.fn(), rollback: vi.fn() };
}

describe("complete generated-record verification", () => {
  it("checks every batch with a covering index in a read-only snapshot", async () => {
    const db = fixture(102, [{ checked: 100, lastId: 130, mismatch0: 0 }, { checked: 2, lastId: 139, mismatch0: 0 }, { checked: 0, lastId: null, mismatch0: 0 }]);
    await expect(verifyGeneratedRecords(db, "runs", columns, "review_idx")).resolves.toEqual({ checked: 102, columns: 1 });
    const batches = db.query.mock.calls.filter(([sql]) => sql.includes("COUNT(*) AS checked"));
    expect(batches.map(([, params]) => params)).toEqual([[0], [130], [139]]);
    expect(batches.every(([sql]) => sql.includes("MAX_EXECUTION_TIME(25000)") && sql.includes("FORCE INDEX (`review_idx`)") && sql.includes("LIMIT 100") && !sql.includes("OFFSET"))).toBe(true);
    expect(db.beginTransaction).toHaveBeenCalledOnce();
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.query.mock.calls.at(-1)).toEqual(["SET SESSION TRANSACTION READ WRITE"]);
  });
  it("verifies empty tables explicitly", async () => {
    const db = fixture(0, [{ checked: 0, lastId: null, mismatch0: 0 }]);
    await expect(verifyGeneratedRecords(db, "runs", columns, "review_idx")).resolves.toEqual({ checked: 0, columns: 1 });
  });
  it.each([
    [1, { checked: 1, lastId: 1, mismatch0: 1 }, "Generated value mismatch"],
    [2, { checked: 0, lastId: null, mismatch0: 0 }, "coverage is incomplete"],
    [0, { checked: 1, lastId: 1, mismatch0: 0 }, "inventory changed"],
    [1, { checked: 1, lastId: 0, mismatch0: 0 }, "cursor did not advance"],
    [1, { checked: 101, lastId: 102, mismatch0: 0 }, "batch size"],
    [1, { checked: 1, lastId: 1 }, "Generated value mismatch"],
  ])("rejects invalid or incomplete results and releases the transaction", async (total, batch, message) => {
    const db = fixture(total, [batch]);
    await expect(verifyGeneratedRecords(db, "runs", columns, "review_idx")).rejects.toThrow(message);
    expect(db.rollback).toHaveBeenCalledOnce();
  });
  it("rolls back server query failures rather than continuing with partial proof", async () => {
    const db = fixture(1, []);
    const error = new Error("maximum statement execution time exceeded");
    db.query.mockImplementation(async sql => {
      if (sql.includes("COUNT(*) AS checked")) throw error;
      return sql.startsWith("SELECT COUNT(*) AS total") ? [[{ total: 1 }]] : [[]];
    });
    await expect(verifyGeneratedRecords(db, "runs", columns, "review_idx")).rejects.toBe(error);
    expect(db.rollback).toHaveBeenCalledOnce();
  });
  it.each(["runs;DROP", "runs`", "runs name", ""])("rejects invalid identifiers before database work: %s", async name => {
    const db = fixture(0, []);
    await expect(verifyGeneratedRecords(db, name, columns, "review_idx")).rejects.toThrow("identifier");
    expect(db.query).not.toHaveBeenCalled();
  });
});
