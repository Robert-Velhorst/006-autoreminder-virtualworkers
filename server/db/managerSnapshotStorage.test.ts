import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { alias } from "drizzle-orm/pg-core";
import { aptlssManagerRuns } from "../../drizzle/schema.postgres.ts";
import { requireIsolatedPostgresTestDatabase } from "../../shared/isolatedPostgresTestDatabase.mjs";
import { managerTimingPredictions } from "../aptlssManagerTiming.ts";
import {
  encodeManagerSnapshotStorage as encode, decodeManagerSnapshotStorage as decode,
  MANAGER_SNAPSHOT_MAX_BYTES as MAX, MANAGER_SNAPSHOT_STORAGE_KEY as KEY,
} from "./managerSnapshotStorage.ts";

vi.mock("node:zlib", async importOriginal => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, brotliDecompressSync: vi.fn(actual.brotliDecompressSync) };
});

const padding = "synthetic snapshot evidence ".repeat(4000);
const action = { cardId: "card", stepIds: [2, 1, 2], minutes: { low: 0, likely: 2, high: 4, samples: 99 }, private: "omitted" };
const source = (fields: Record<string, unknown> = {}) => JSON.stringify({ padding, ...fields });
const packed = () => JSON.parse(encode(source({ implementationDigest: "abc", interventions: [{ severity: "urgent" }], actions: [action] })));
const change = (mutate: (value: any) => void) => {
  const value = packed(); mutate(value); return JSON.stringify(value);
};
function envelopeFor(bytes: Buffer, fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    [KEY]: { version: 1, codec: "brotli", byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), base64: brotliCompressSync(bytes).toString("base64") },
    interventions: [], actions: [], ...fields,
  });
}

const projectionCases = [
  {}, { implementationDigest: null }, { implementationDigest: "abc" },
  ...[0, true, ["digest"], { digest: "value" }].map(implementationDigest => ({ implementationDigest })),
  { interventions: [] }, { interventions: null },
  { interventions: [{ severity: "urgent" }, { severity: "normal" }, { severity: "urgent" }] },
  { interventions: [{ severity: "Urgent" }, { severity: "normal" }] },
  { interventions: [{ severity: ["urgent"] }] }, { interventions: { severity: "urgent" } },
  { actions: [action, null, {}, { ...action, stepIds: [0] }, { ...action, minutes: { low: 4, likely: 2, high: 1 } }, { ...action, cardId: "second", stepIds: [] }] },
  { actions: JSON.stringify([action]) }, { actions: "invalid" }, { actions: null },
];

describe("bounded lossless manager snapshot storage", () => {
  it("retains exact UTF-8 bytes, whitespace, duplicate keys, number spelling, escapes and Unicode", () => {
    const text = ' \n{ "n":1e2, "n":100.00, "escaped":"\\u0061", "unicode":"\u00e9 \u6f22\u5b57 \ud83d\ude80", "padding":' + JSON.stringify(padding) + ' }\r\n\t';
    const stored = encode(text);
    expect(Buffer.byteLength(stored)).toBeLessThan(Buffer.byteLength(text));
    expect(decode(stored)).toBe(text);
    expect(Buffer.from(decode(stored))).toEqual(Buffer.from(text));
    const metadata = JSON.parse(stored)[KEY];
    expect(metadata.base64).toBe(brotliCompressSync(Buffer.from(text), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    }).toString("base64"));
  });

  it.each(["", "not JSON", "{broken", "[]", "null", "42", '"text"', '{"small":true}', '{"x":"\ud800"}'])("keeps ordinary legacy text and small snapshots unchanged (%#)", text => {
    expect(encode(text)).toBe(text);
    expect(decode(text)).toBe(text);
  });

  it.each(projectionCases)("preserves SQL-visible review and timing projections (%#)", fields => {
    const text = source(fields);
    const stored = JSON.parse(encode(text));
    const original = JSON.parse(text);
    expect(stored.implementationDigest).toEqual(original.implementationDigest);
    const urgent = (v: any) => Array.isArray(v.interventions) && v.interventions.some((i: any) => i?.severity === "urgent");
    expect(urgent(stored)).toBe(urgent(original));
    expect(managerTimingPredictions(stored.actions)).toEqual(managerTimingPredictions(original.actions));
    expect(decode(JSON.stringify(stored))).toBe(text);
    if (Object.hasOwn(stored, KEY)) {
      expect(stored.actions).toEqual(managerTimingPredictions(original.actions));
      expect(stored.interventions).toEqual(urgent(original) ? [{ severity: "urgent" }] : []);
      expect(stored).not.toHaveProperty("padding");
    }
  });

  it.each([0, true, ["digest"], { digest: "value" }])("does not risk changing SQL ->> conversion of a non-string digest (%#)", implementationDigest => {
    const text = source({ implementationDigest });
    expect(encode(text)).toBe(text);
  });

  it("keeps nested markers and marker text as data, but rejects any top-level reserved member", () => {
    const text = source({ nested: { [KEY]: { version: 999 } }, description: KEY });
    expect(decode(encode(text))).toBe(text);
    expect(decode(source({ nested: { [KEY]: true } }))).toContain("nested");
    for (const value of [null, false, "ordinary marker", {}, { version: 2 }]) {
      const ambiguous = source({ [KEY]: value });
      expect(() => encode(ambiguous)).toThrow();
      expect(() => decode(ambiguous)).toThrow();
    }
    const nestedEnvelope = envelopeFor(Buffer.from(JSON.stringify(packed())));
    expect(() => decode(nestedEnvelope)).toThrow();
  });

  it.each([
    (e: any) => { e[KEY].version = 2; },
    (e: any) => { e[KEY].codec = "gzip"; },
    (e: any) => { e[KEY].sha256 = "0".repeat(64); },
    (e: any) => { e[KEY].sha256 = "G".repeat(64); },
    (e: any) => { e[KEY].byteLength++; },
    (e: any) => { e[KEY].byteLength--; },
    (e: any) => { e[KEY].byteLength = MAX + 1; },
    (e: any) => { e[KEY].byteLength = -1; },
    (e: any) => { e[KEY].byteLength = 1.5; },
    (e: any) => { e[KEY].byteLength = "12"; },
    (e: any) => { e[KEY].extra = true; },
    (e: any) => { delete e[KEY].codec; },
    (e: any) => { e.implementationDigest = "changed"; },
    (e: any) => { delete e.implementationDigest; },
    (e: any) => { e.interventions = []; },
    (e: any) => { e.interventions.push({ severity: "normal" }); },
    (e: any) => { e.actions[0].minutes.likely++; },
    (e: any) => { e.actions[0].private = "extra"; },
    (e: any) => { e.actions = []; },
    (e: any) => { e.extra = true; },
    (e: any) => { e[KEY].base64 = ""; },
    (e: any) => { e[KEY].base64 += "\n"; },
    (e: any) => { e[KEY].base64 = "Zh=="; }, // Nonzero unused pad bits.
    (e: any) => { e[KEY].base64 = "AA-_"; },
    (e: any) => { e[KEY].base64 = "A==="; },
    (e: any) => { e[KEY].base64 = Buffer.from(e[KEY].base64, "base64").subarray(0, -1).toString("base64"); },
    (e: any) => { e[KEY].base64 = Buffer.concat([Buffer.from(e[KEY].base64, "base64"), Buffer.from([0])]).toString("base64"); },
    (e: any) => { const b = Buffer.from(e[KEY].base64, "base64"); b[0] ^= 0xff; e[KEY].base64 = b.toString("base64"); },
  ])("fails closed on corrupt metadata, payload or projections (%#)", mutate => {
    expect(() => decode(change(mutate))).toThrow("Invalid manager snapshot storage");
  });

  it("rejects truncated envelopes, including escaped reserved member names", () => {
    const text = JSON.stringify(packed());
    expect(() => decode(text.slice(0, -1))).toThrow();
    expect(() => decode('{"\\u0024managerSnapshotStorage":')).toThrow();
    expect(() => encode('{"$managerSnapshotStorage":')).toThrow();
  });

  it.each([Buffer.from([0xff, 0xfe]), Buffer.from("not JSON"), Buffer.from("[]"), Buffer.from("null")])("rejects invalid UTF-8 and nonobject decompressed payloads (%#)", bytes => {
    expect(() => decode(envelopeFor(bytes))).toThrow();
  });

  it("bounds source and stored UTF-8 bytes, including legacy text", () => {
    const exact = "x".repeat(MAX);
    expect(encode(exact)).toBe(exact);
    expect(decode(exact)).toBe(exact);
    for (const oversized of [exact + "x", "\u00e9".repeat(MAX / 2 + 1)]) {
      expect(() => encode(oversized)).toThrow();
      expect(() => decode(oversized)).toThrow();
    }
    const text = '{"padding":"' + "x".repeat(MAX - 14) + '"}';
    expect(Buffer.byteLength(text)).toBe(MAX);
    expect(decode(encode(text))).toBe(text);
  }, 15000);

  it("rejects a bomb at the declared output ceiling, not merely by a later hash check", () => {
    const bytes = Buffer.alloc(MAX + 1, 0x20);
    const bomb = JSON.parse(envelopeFor(bytes));
    bomb[KEY].byteLength = MAX;
    expect(() => decode(JSON.stringify(bomb))).toThrow();
    const native = vi.mocked(brotliDecompressSync);
    expect(native.mock.calls.at(-1)?.[1]).toMatchObject({ maxOutputLength: MAX, info: true });
    expect(native.mock.results.at(-1)).toMatchObject({ type: "throw", value: { code: "ERR_BUFFER_TOO_LARGE" } });
    const smallLie = packed(); smallLie[KEY].byteLength = 16;
    expect(() => decode(JSON.stringify(smallLie))).toThrow();
    expect(native.mock.calls.at(-1)?.[1]).toMatchObject({ maxOutputLength: 16 });
  }, 15000);
});

describe("integrated Drizzle driver boundary (synthetic adapter, no database)", () => {
  it("decodes nested and aliased typed columns without decoding raw timing SQL", async () => {
    const text = source({ actions: [action] });
    const stored = encode(text);
    const db = drizzle(async () => ({ rows: [[stored]] }));
    const [nested] = await db.select({ run: { snapshotJson: aptlssManagerRuns.snapshotJson } }).from(aptlssManagerRuns);
    expect(nested.run.snapshotJson).toBe(text);
    const columns = Object.keys(getTableColumns(aptlssManagerRuns));
    const wholeTable = drizzle(async () => ({ rows: [columns.map(key =>
      key === "snapshotJson" ? stored : key === "id" ? 1 : null)] }));
    const [whole] = await wholeTable.select({ run: aptlssManagerRuns }).from(aptlssManagerRuns);
    expect(whole.run.snapshotJson).toBe(text);
    const reviewedRun = alias(aptlssManagerRuns, "reviewed_run");
    const [aliased] = await db.select({ run: { snapshotJson: reviewedRun.snapshotJson } }).from(reviewedRun);
    expect(aliased.run.snapshotJson).toBe(text);
    const raw = drizzle(async () => ({ rows: [[JSON.parse(stored).actions]] }));
    const [timing] = await raw.select({ actions: sql<unknown>`${aptlssManagerRuns.snapshotJson}::jsonb -> 'actions'` }).from(aptlssManagerRuns);
    expect(timing.actions).toEqual(managerTimingPredictions([action]));
    const untyped = await db.execute(sql`SELECT "snapshotJson" FROM aptlss_manager_runs`);
    expect(untyped).toEqual([[stored]]); // pg-proxy execute returns raw rows, without fromDriver.
  });

  it("encodes typed writes and returning reads through the integrated customType", async () => {
    const text = source({ actions: [action] });
    let driverParameters: unknown[] = [];
    const db = drizzle(async (_query, params) => {
      driverParameters = params;
      return { rows: [[encode(text)]] };
    });
    const [returned] = await db.insert(aptlssManagerRuns).values({
      vaId: 1, inputHash: "synthetic", trigger: "manual", snapshotJson: text,
    }).returning({ snapshotJson: aptlssManagerRuns.snapshotJson });
    expect(driverParameters).toContain(encode(text));
    expect(driverParameters).not.toContain(text);
    expect(returned.snapshotJson).toBe(text);
  });
});

// Optional real-SQL proof, using the repository's isolated database safety gate.
describe.skipIf(!process.env.APTLSS_TEST_DATABASE_URL)("snapshot storage actual PostgreSQL projection parity", () => {
  it("retains generated review expressions and timing SQL across every projection case", async () => {
    const connectionString = requireIsolatedPostgresTestDatabase(process.env.APTLSS_TEST_DATABASE_URL, process.env.NODE_ENV === "production");
    const db = new Client({ connectionString, connectionTimeoutMillis: 10000 });
    await db.connect();
    try {
      for (const fields of projectionCases) {
        const text = source(fields);
        const query = `SELECT value::jsonb ->> 'implementationDigest' AS digest,
          value::jsonb @> '{"interventions":[{"severity":"urgent"}]}'::jsonb AS urgent,
          CASE WHEN pg_input_is_valid(value, 'jsonb') THEN value::jsonb -> 'actions' ELSE NULL END AS actions
          FROM unnest($1::text[]) WITH ORDINALITY AS snapshots(value, position) ORDER BY position`;
        const { rows } = await db.query(query, [[text, encode(text)]]);
        expect(rows[1].digest).toEqual(rows[0].digest);
        expect(rows[1].urgent).toEqual(rows[0].urgent);
        expect(managerTimingPredictions(rows[1].actions)).toEqual(managerTimingPredictions(rows[0].actions));
      }
    } finally { await db.end(); }
  }, 30000);
});
