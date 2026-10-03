import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  fingerprintRecords,
  fingerprintTable,
  fingerprintWholeTable,
} from "./operational-record-fingerprint.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const legacy = (rows, columns) => ({
  columns,
  count: rows.length,
  hash: hash(
    rows
      .map(row => hash(JSON.stringify(columns.map(column => row[column]))))
      .sort()
      .join("\n")
  ),
});

describe("native original-column rehearsal validation", () => {
  const originalArgv = process.argv;
  const original = () => ({ history: { columns: ["id"], count: 1, hash: legacy([{ id: 1 }], ["id"]).hash } });

  afterEach(() => {
    process.argv = originalArgv;
    vi.doUnmock("node:fs");
    vi.doUnmock("mysql2");
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function rehearse({ mode = "verify", baseline = original(), rows = [{ id: 1 }],
    columns = ["id", "added"], tables = ["__drizzle_migrations", "history", "added_table"],
    streamFailure = false, baselineText } = {}) {
    vi.resetModules();
    const files = {
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => baselineText ?? JSON.stringify(baseline)),
      writeFileSync: vi.fn(),
    };
    const db = {
      query: vi.fn(async sql => {
        if (sql === "SET SESSION TRANSACTION READ ONLY") return [{}];
        if (sql.includes("information_schema.tables")) return [tables.map(name => ({ name }))];
        if (sql.startsWith("SHOW COLUMNS")) return [columns.map(Field => ({ Field }))];
        throw new Error("Unexpected mock SQL");
      }),
      beginTransaction: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    };
    const connection = { promise: () => db, query: vi.fn() };
    const createConnection = vi.fn(config => {
      connection.query.mockImplementation(() => ({ stream: () => Readable.from((async function* () {
        for (const row of rows) {
          yield Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
            key === "numberValue"
              ? config.typeCast({ type: "LONGLONG", string: () => value }, () => { throw new Error("Unexpected fallback"); })
              : value]));
        }
        if (streamFailure) throw new Error("Fixture stream interrupted");
      })()) }));
      return connection;
    });
    vi.doMock("node:fs", () => ({ default: files }));
    vi.doMock("mysql2", () => ({ default: { createConnection } }));
    vi.stubEnv("APTLSS_REHEARSAL_DATABASE_URL", "mysql://fixture:fixture@127.0.0.1:33317/aptlss_pilot_rehearsal");
    process.argv = ["node", "aptlss-pilot-rehearsal.mjs", mode, ".local/pilot/test-checkpoint.json"];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let error;
    try { await import("./aptlss-pilot-rehearsal.mjs"); }
    catch (caught) { error = caught; }
    return { files, db, connection, createConnection, log, error };
  }

  it.each([
    null, false, "checkpoint", 1, [], {},
    { __drizzle_migrations: { columns: ["id"], count: 0, hash: hash("") } },
    { history: null }, { history: [] }, { history: {} },
    { history: { columns: [], count: 1, hash: hash("row") } },
    { history: { columns: ["id", "id"], count: 1, hash: hash("row") } },
    { history: { columns: [""], count: 1, hash: hash("row") } },
    { history: { columns: ["bad\0"], count: 1, hash: hash("row") } },
    { history: { columns: [1], count: 1, hash: hash("row") } },
    { history: { columns: ["id"], count: "1", hash: hash("row") } },
    { history: { columns: ["id"], count: -1, hash: hash("row") } },
    { history: { columns: ["id"], count: 1.5, hash: hash("row") } },
    { history: { columns: ["id"], count: Number.MAX_SAFE_INTEGER + 1, hash: hash("row") } },
    { history: { columns: ["id"], count: 1, hash: "invalid" } },
    { history: { columns: ["id"], count: 0, hash: hash("row") } },
    { history: { columns: ["id"], count: 1, hash: hash("") } },
    { history: { columns: ["id"], count: 1, hash: hash("row"), passed: true } },
    { "bad\0table": { columns: ["id"], count: 1, hash: hash("row") } },
  ])("rejects an invalid baseline before connecting or writing proof: %#", async baseline => {
    const result = await rehearse({ baseline });
    expect(result.error?.message).toMatch(/checkpoint/);
    expect(result.createConnection).not.toHaveBeenCalled();
    expect(result.files.writeFileSync).not.toHaveBeenCalled();
    expect(result.log).not.toHaveBeenCalled();
  });

  it("preserves genuine original-column checkpoints despite additive tables and columns", async () => {
    const result = await rehearse({ rows: [{ id: 1, added: "outside original scope" }] });
    expect(result.error).toBeUndefined();
    expect(result.connection.query).toHaveBeenCalledOnce();
    expect(result.connection.query).toHaveBeenCalledWith("SELECT `id` FROM `history`");
    expect(result.createConnection.mock.calls[0][0]).toMatchObject({ supportBigNumbers: true, bigNumberStrings: true });
    const proof = JSON.parse(result.files.writeFileSync.mock.calls[0][1]);
    expect(proof).toMatchObject({ passed: true, originalTables: 1,
      scope: "legacy-original-columns", fullDataPreservationVerified: false, applicationRollbackVerified: false });
    expect(JSON.parse(result.log.mock.calls[0][0])).toMatchObject({ preserved: true,
      scope: "legacy-original-columns", fullDataPreservationVerified: false, applicationRollbackVerified: false });
    expect(result.db.rollback).toHaveBeenCalledOnce();
    expect(result.db.end).toHaveBeenCalledOnce();
  });

  it("retains small BIGINT numeric hashes and nulls from genuine legacy checkpoints", async () => {
    const rows = [{ numberValue: 42 }, { numberValue: -42 }, { numberValue: Number.MAX_SAFE_INTEGER }, { numberValue: null }];
    const baseline = { history: legacy(rows, ["numberValue"]) };
    const result = await rehearse({ baseline, columns: ["numberValue"], rows: rows.map(row => ({ numberValue: row.numberValue === null ? null : String(row.numberValue) })) });
    expect(result.error).toBeUndefined();
    const typeCast = result.createConnection.mock.calls[0][0].typeCast;
    const next = vi.fn(() => "unchanged");
    expect(typeCast({ type: "VAR_STRING" }, next)).toBe("unchanged");
    expect(next).toHaveBeenCalledOnce();
  });

  it("distinguishes adjacent unsigned64 values through capture and verify without a database", async () => {
    const first = "18446744073709551614", second = "18446744073709551615";
    expect(Number(first)).toBe(Number(second));
    const captured = await rehearse({ mode: "capture", tables: ["__drizzle_migrations", "history"], columns: ["numberValue"], rows: [{ numberValue: first }] });
    expect(captured.error).toBeUndefined();
    const baseline = JSON.parse(captured.files.writeFileSync.mock.calls[0][1]);
    expect(baseline.history).toEqual(legacy([{ numberValue: first }], ["numberValue"]));
    expect(JSON.parse(captured.log.mock.calls.at(-1)[0])).toMatchObject({ captured: true,
      scope: "legacy-original-columns", fullDataPreservationVerified: false, applicationRollbackVerified: false });
    const unchanged = await rehearse({ baseline, columns: ["numberValue"], rows: [{ numberValue: first }] });
    expect(unchanged.error).toBeUndefined();
    const result = await rehearse({ baseline, columns: ["numberValue"], rows: [{ numberValue: second }] });
    expect(result.error?.message).toMatch(/Original records changed/);
    expect(result.files.writeFileSync).not.toHaveBeenCalled();
    expect(result.db.rollback).toHaveBeenCalledOnce();
  });

  it("accepts a genuine empty table but never an empty capture inventory", async () => {
    const valid = await rehearse({ baseline: { history: legacy([], ["id"]) }, rows: [] });
    expect(valid.error).toBeUndefined();
    const empty = await rehearse({ mode: "capture", tables: ["__drizzle_migrations"] });
    expect(empty.error?.message).toMatch(/nonempty/);
    expect(empty.files.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before connecting or writing proof", async () => {
    const result = await rehearse({ baselineText: '{"history":' });
    expect(result.error).toBeInstanceOf(SyntaxError);
    expect(result.createConnection).not.toHaveBeenCalled();
    expect(result.files.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not bless a legacy baseline that already rounded an unsafe integer", async () => {
    const value = "18446744073709551614";
    const baseline = { history: legacy([{ numberValue: Number(value) }], ["numberValue"]) };
    const result = await rehearse({ baseline, columns: ["numberValue"], rows: [{ numberValue: value }] });
    expect(result.error?.message).toMatch(/Original records changed/);
    expect(result.files.writeFileSync).not.toHaveBeenCalled();
  });

  it.each(["constructor", "__proto__"])("treats table name %s as data rather than inherited properties", async table => {
    const baseline = JSON.parse(JSON.stringify(Object.fromEntries([[table, original().history]])));
    const result = await rehearse({ baseline, tables: [table] });
    expect(result.error).toBeUndefined();
    expect(result.connection.query).toHaveBeenCalledWith(`SELECT \`id\` FROM \`${table}\``);
  });

  it.each([
    { tables: ["__drizzle_migrations"] },
    { columns: ["different"] },
    { rows: [{ id: 2 }] },
    { rows: [{ id: 1 }, { id: 1 }] },
    { streamFailure: true },
  ])("fails closed on missing originals, changes and interrupted streams: %#", async override => {
    const result = await rehearse(override);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.files.writeFileSync).not.toHaveBeenCalled();
    expect(result.log).not.toHaveBeenCalled();
    expect(result.db.rollback).toHaveBeenCalledOnce();
    expect(result.db.end).toHaveBeenCalledOnce();
  });
});

describe("streamed operational record fingerprints", () => {
  it("preserves the distinct native row-object hash format", async () => {
    const rows = [
      { id: 2, payload: null },
      { id: 1, payload: "retained" },
      { id: 2, payload: null },
    ];
    const stream = vi.fn(() => Readable.from(rows));
    const connection = { query: vi.fn(() => ({ stream })) };
    const actual = await fingerprintWholeTable(connection, "native`history");
    expect(actual).toEqual({
      count: rows.length,
      hash: hash(
        rows
          .map(row => hash(JSON.stringify(row)))
          .sort()
          .join("\n")
      ),
    });
    expect(connection.query).toHaveBeenCalledWith(
      "SELECT * FROM `native``history`"
    );
    expect(stream).toHaveBeenCalledWith({ highWaterMark: 1 });
  });
  it("matches existing manifests including column order and duplicate records", async () => {
    const rows = [
      { id: 3, data: null, text: "bericht" },
      {
        id: 1,
        data: Buffer.from([0, 127, 255]),
        text: "\u00e9\u4e2d\ud83d\udce8",
      },
      { id: 3, data: null, text: "bericht" },
      { id: 2, data: new Date("2026-09-30T22:00:00Z"), text: "line\nnext" },
    ];
    const columns = ["text", "id", "data"];
    expect(await fingerprintRecords(Readable.from(rows), columns)).toEqual(
      legacy(rows, columns)
    );
    expect(
      await fingerprintRecords(Readable.from([...rows].reverse()), columns)
    ).toEqual(legacy(rows, columns));
  });

  it("preserves the empty-table hash", async () => {
    expect(await fingerprintRecords(Readable.from([]), ["id"])).toEqual(
      legacy([], ["id"])
    );
  });

  it("consumes each payload before advancing to the next record", async () => {
    const row = { id: 0, payload: "" };
    const expected = [];
    async function* rows() {
      for (let id = 0; id < 32; id++) {
        row.id = id;
        row.payload = `${id}:` + "x".repeat(1024 * 1024);
        expected.push(hash(JSON.stringify([row.id, row.payload])));
        yield row;
      }
    }
    const actual = await fingerprintRecords(rows(), ["id", "payload"]);
    expect(actual.count).toBe(32);
    expect(actual.hash).toBe(hash(expected.sort().join("\n")));
  });

  it("detects altered values and preserves duplicate multiplicity", async () => {
    const one = await fingerprintRecords([{ id: 1 }], ["id"]);
    expect(await fingerprintRecords([{ id: 2 }], ["id"])).not.toEqual(one);
    expect(
      await fingerprintRecords([{ id: 1 }, { id: 1 }], ["id"])
    ).not.toEqual(one);
  });

  it.each([[], ["id", "id"], [""], ["id\0"]])(
    "rejects invalid column lists %j",
    async columns => {
      await expect(fingerprintRecords([], columns)).rejects.toThrow(
        /column|identifier/i
      );
    }
  );

  it.each([null, {}, { other: 1 }])(
    "does not silently fingerprint missing columns: %j",
    async row => {
      await expect(fingerprintRecords([row], ["id"])).rejects.toThrow(
        /missing/i
      );
    }
  );

  it("does not return a partial manifest after a stream failure", async () => {
    async function* broken() {
      yield { id: 1 };
      throw new Error("Fixture read interrupted");
    }
    await expect(fingerprintRecords(broken(), ["id"])).rejects.toThrow(
      "Fixture read interrupted"
    );
  });

  it("quotes identifiers and bounds the source stream buffer", async () => {
    const stream = vi.fn(() => Readable.from([{ "a`b": 1 }]));
    const query = vi.fn(() => ({ stream }));
    expect(await fingerprintTable({ query }, "table`name", ["a`b"])).toEqual(
      legacy([{ "a`b": 1 }], ["a`b"])
    );
    expect(query).toHaveBeenCalledWith("SELECT `a``b` FROM `table``name`");
    expect(stream).toHaveBeenCalledWith({ highWaterMark: 1 });
  });

  it("keeps the original column selection if the caller changes its array", async () => {
    const columns = ["id"];
    async function* rows() {
      columns[0] = "other";
      yield { id: 1, other: 2 };
    }
    expect(await fingerprintRecords(rows(), columns)).toEqual(
      legacy([{ id: 1 }], ["id"])
    );
  });

  it("rejects an invalid selection before issuing any database query", () => {
    const query = vi.fn();
    expect(() => fingerprintTable({ query }, "records", ["id", "id"])).toThrow(
      /unique/
    );
    expect(() => fingerprintTable({ query }, "bad\0table", ["id"])).toThrow(
      /identifier/
    );
    expect(query).not.toHaveBeenCalled();
  });
});
