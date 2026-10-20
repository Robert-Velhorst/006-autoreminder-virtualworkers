import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveSettings } from "./operator-data-transfer-utils.mjs";
import {
  canonicalColumnValue, prepareTransferRow, sameTransferRecord, sequenceRestartValue,
  sourceIdentity, transferIdentity, transferOperatorRecords, validateTransferPayload,
} from "./operator-data-transfer-utils.mjs";
import { TABLES, exportOperatorData, parseTransferArguments, verifyExport } from "./operator-data-transfer.mjs";

const identity = transferIdentity(2, 1, 3);
const target = {
  workerUserId: 2, workerProfileId: 3, founderUserId: 1, workerOpenId: "worker-fixture", founderOpenId: "founder-fixture",
  trelloMemberId: "trello-fixture", workerRole: "worker", founderRole: "admin", workerStatus: "active",
};
const definitions = [{ name: "time_entries", keys: ["id"] }, { name: "card_states", keys: ["vaId", "cardId"] }];
const column = (column_name, data_type = "integer", extra = {}) => ({
  column_name, data_type, is_nullable: "NO", column_default: null, is_identity: "NO", ...extra,
});
const columns = {
  time_entries: [column("id", "integer", { is_identity: "YES" }), column("vaId"), column("founderId"), column("notes", "text")],
  card_states: [column("id", "integer", { is_identity: "YES" }), column("vaId"), column("cardId", "text"), column("state", "jsonb")],
  app_settings: [column("id", "integer", { is_identity: "YES" }), column("vaId", "integer", { is_nullable: "YES" }), column("key", "character varying"), column("value", "text")],
};
const entry = { id: 8, vaId: 2, founderId: 1, notes: "synthetic source" };
const card = { id: 9, vaId: 2, cardId: "card-fixture", state: { b: 2, a: 1 } };
function payload(tables = { time_entries: [entry], card_states: [] }) {
  return {
    format: "joyce-operator-export-v2", credentialOmissions: [], identities: [sourceIdentity(target)], skipped: [], tables,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
  };
}

// Strict query-contract fixture: no driver, network, filesystem, or database access.
function database(options = {}) {
  const state = {
    tables: { time_entries: [], card_states: [], ...structuredClone(options.tables || {}) },
    sequences: {
      time_entries: { last: "1", called: false }, card_states: { last: "1", called: false },
      ...structuredClone(options.sequences || {}),
    },
  };
  const queries = [];
  let snapshot;
  let locked = false;
  let readOnly = false;
  const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });
  return { state, queries, async query(text, values = []) {
    const sql = text.trim().replace(/\s+/g, " ");
    queries.push({ sql, values });
    if (sql.startsWith("BEGIN")) {
      snapshot = structuredClone(state);
      readOnly = sql.includes("READ ONLY");
      return result([]);
    }
    if (sql === "ROLLBACK") {
      if (snapshot) Object.assign(state, snapshot);
      snapshot = undefined;
      return result([]);
    }
    if (sql === "COMMIT") {
      assert.equal(readOnly, false);
      snapshot = undefined;
      return result([]);
    }
    if (sql.startsWith("SET LOCAL")) return result([]);
    if (sql.startsWith("LOCK TABLE")) {
      assert.equal(readOnly, false);
      assert.match(sql, /ACCESS EXCLUSIVE MODE$/);
      locked = true;
      return result([]);
    }
    if (sql.includes("FROM va_profiles p")) return result(options.target ?? [target]);
    if (sql.includes("FROM information_schema.columns")) return result(options.columns?.[values[0]] ?? columns[values[0]] ?? []);
    if (sql.startsWith("SELECT * FROM")) {
      const table = /^SELECT \* FROM "(\w+)"/.exec(sql)[1];
      const clauses = sql.slice(sql.indexOf(" WHERE ") + 7).split(" OR ");
      return result(state.tables[table].filter(row => clauses.some(clause => {
        const predicates = [...clause.matchAll(/"(\w+)" = \$(\d+)/g)];
        assert.ok(predicates.length);
        return predicates.every(([, key, index]) => String(row[key]) === String(values[Number(index) - 1]));
      })));
    }
    if (sql.startsWith("INSERT INTO")) {
      assert.equal(readOnly, false);
      assert.equal(locked, true);
      assert.doesNotMatch(sql, /ON CONFLICT|UPDATE/);
      const [, table, list] = /^INSERT INTO "(\w+)" \(([^)]+)\)/.exec(sql);
      const names = [...list.matchAll(/"(\w+)"/g)].map(match => match[1]);
      const row = Object.fromEntries(names.map((name, index) => [name, values[index]]));
      assert.equal(state.tables[table].some(existing => existing.id === row.id), false);
      const stored = options.coerce ? options.coerce(row) : row;
      state.tables[table].push(stored);
      return result([stored]);
    }
    if (sql.includes("FROM pg_class c")) {
      assert.equal(locked, true);
      const table = values[0];
      return result([{ schema: "public", name: `${table}_id_seq`, increment: "1", cache: "1", cycle: false,
        maximum: "2147483647", ...options.sequenceMetadata?.[table] }]);
    }
    const sequence = /"public"\."(\w+)_id_seq"/.exec(sql)?.[1];
    if (sql.startsWith("ALTER SEQUENCE")) {
      assert.equal(readOnly, false);
      assert.equal(locked, true);
      if (sql.endsWith("CACHE 1") && options.allocateBeforeSequenceLock) {
        state.sequences[sequence] = { last: "900", called: true };
      }
      const restart = /RESTART WITH (\d+)$/.exec(sql);
      if (restart) state.sequences[sequence] = { last: restart[1], called: false };
      return result([]);
    }
    if (sql.startsWith("SELECT last_value")) {
      const stateValue = state.sequences[sequence];
      return result([{ last_value: stateValue.last, is_called: stateValue.called }]);
    }
    if (sql.startsWith("SELECT MAX")) {
      const table = /FROM "(\w+)"$/.exec(sql)[1];
      const ids = state.tables[table].map(row => BigInt(row.id));
      return result([{ maximum: ids.length ? ids.reduce((a, b) => a > b ? a : b).toString() : null }]);
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  } };
}

describe("redactSensitiveSettings", () => {
  it("redacts secret-bearing values but keeps non-secret settings", () => {
    const rows = [
      { key: "ai_groq_key", value: "provider-secret" },
      { key: "refresh_token", value: "refresh-secret" },
      { key: "browserTabCollectorToken", value: "collector-secret" },
      { key: "openaiKey", value: "openai-secret" },
      { key: "oauth-client-secret", value: "oauth-secret" },
      { key: "dbPassword", value: "database-secret" },
      { key: "working_hours", value: "09:00-17:00" },
      { key: "keyboard_shortcuts", value: "Ctrl+K" },
    ].map((row, index) => ({ id: index + 1, vaId: null, ...row }));
    const result = redactSensitiveSettings(rows);
    assert.deepEqual(result.rows, rows.slice(6));
    assert.equal(result.credentialOmissions.length, 6);
    assert.deepEqual(result.credentialOmissions.map(row => row.key), rows.slice(0, 6).map(row => row.key));
    assert.ok(result.credentialOmissions.every(row => !Object.hasOwn(row, "value") && row.vaId === null));
    assert.equal(JSON.stringify(result).includes("provider-secret"), false);
    assert.equal(rows[0].value, "provider-secret");
  });
});

describe("operator transfer CLI and source validation", () => {
  const args = ["import", "--worker-user-id", "2", "--founder-user-id", "1", "--worker-profile-id", "3"];
  it("defaults to dry-run and requires explicit, unambiguous execution", () => {
    assert.equal(parseTransferArguments(args).execute, false);
    assert.equal(parseTransferArguments([...args, "--dry-run"]).execute, false);
    assert.equal(parseTransferArguments([...args, "--execute"]).execute, true);
    for (const suffix of [["--execute", "--dry-run"], ["--execute", "--execute"], ["--exectue"], ["--target"]]) {
      assert.throws(() => parseTransferArguments([...args, ...suffix]));
    }
    assert.throws(() => parseTransferArguments(["reconcile", ...args.slice(1), "--execute"]));
  });
  it("requires positive safe worker and founder IDs for both import and reconcile", () => {
    for (const id of [undefined, "", "0", "-1", "3.1", "3x", "9007199254740992"]) {
      assert.throws(() => transferIdentity(id, 1, 3));
      assert.throws(() => transferIdentity(2, id, 3));
    }
    assert.deepEqual(parseTransferArguments(["reconcile", ...args.slice(1)]).identity, identity);
  });
  it("rejects skipped, omitted, unknown, count-mismatched and identity-unbound exports before any query", async () => {
    const incomplete = [];
    let p = payload(); p.skipped = ["missing"]; incomplete.push(p);
    p = payload(); delete p.tables.card_states; incomplete.push(p);
    p = payload(); p.counts.time_entries = 2; incomplete.push(p);
    p = payload(); p.tables.unknown = []; incomplete.push(p);
    p = payload(); delete p.identities; incomplete.push(p);
    p = payload(); p.identities.push(sourceIdentity({ ...target, workerUserId: 4 })); incomplete.push(p);
    p = payload(); p.identities[0].founderUserId = 99; incomplete.push(p);
    for (const value of incomplete) {
      const db = database();
      await assert.rejects(transferOperatorRecords(db, value, definitions, { identity, execute: true }));
      assert.equal(db.queries.length, 0);
    }
  });
  it("verifies export integrity without mutating the loaded export", async () => {
    const { createHash } = await import("node:crypto");
    const p = payload();
    p.digest = createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const before = structuredClone(p);
    assert.equal(verifyExport(p), p);
    assert.deepEqual(p, before);
    p.tables.time_entries[0] = { ...entry, notes: "tampered" };
    assert.throws(() => verifyExport(p), /digest/);
  });
  it("rejects missing and different source owners rather than filling or retaining IDs", () => {
    for (const row of [{ ...entry, vaId: 3 }, { ...entry, vaId: 4 }, { ...entry, founderId: 2 }, { ...entry, vaId: null }, { ...entry, founderId: undefined }]) {
      assert.throws(() => prepareTransferRow(row, columns.time_entries, identity, "time_entries"));
    }
    assert.deepEqual(prepareTransferRow(entry, columns.time_entries, identity, "time_entries"), entry);
    assert.throws(() => prepareTransferRow({ ...entry, ignored: "must not drop" }, columns.time_entries, identity, "time_entries"), /Unmapped/);
  });
});

describe("exact content comparison", () => {
  it("normalizes only typed database representations without losing precision", () => {
    assert.equal(canonicalColumnValue("00012.3400", column("amount", "numeric")), "12.34");
    assert.equal(canonicalColumnValue("9007199254740993", column("id", "bigint")), "9007199254740993");
    assert.throws(() => canonicalColumnValue(9007199254740992, column("id", "bigint")), /Unsafe/);
    assert.equal(canonicalColumnValue(0, column("flag", "boolean")), false);
    assert.throws(() => canonicalColumnValue("false-ish", column("flag", "boolean")));
    const time = column("at", "timestamp without time zone");
    assert.equal(canonicalColumnValue("2026-10-21T12:00:00.1", time), "2026-10-21 12:00:00.100000");
    assert.throws(() => canonicalColumnValue("2026-10-21T12:00:00Z", time));
    assert.throws(() => canonicalColumnValue("2026-02-30 12:00:00", time));
    assert.throws(() => canonicalColumnValue("2026-10-21 25:00:00", time));
    assert.equal(sameTransferRecord(card, { ...card, state: '{"a":1,"b":2}' }, columns.card_states), true);
    assert.equal(sameTransferRecord(card, { ...card, state: '{"a":1,"b":3}' }, columns.card_states), false);
    assert.equal(sameTransferRecord(entry, { ...entry, notes: "different" }, columns.time_entries), false);
  });
});

describe("canonical global settings and explicit credential restoration", () => {
  const settingsDefinitions = [{ name: "app_settings", keys: ["key"] }];
  const global = { id: 7, vaId: null, key: "working_hours", value: "09:00-17:00" };
  const secret = { id: 8, vaId: 2, key: "refresh_token", value: "synthetic-source-secret" };
  const settingsPayload = () => {
    const redacted = redactSensitiveSettings([global, secret]);
    const value = payload({ app_settings: redacted.rows });
    value.counts.app_settings = 2;
    value.credentialOmissions = redacted.credentialOmissions;
    return value;
  };
  const fixture = () => database({ tables: { app_settings: [{ ...secret, value: "synthetic-target-secret" }] },
    sequences: { app_settings: { last: "1", called: false } } });

  it("uses users.id=2, not profile.id=3, and permits explicit NULL scope only for canonical app_settings", () => {
    assert.deepEqual(identity, { workerUserId: 2, founderUserId: 1, workerProfileId: 3 });
    assert.deepEqual(sourceIdentity(target), { ...identity, workerPrincipal: sourceIdentity(target).workerPrincipal,
      founderPrincipal: sourceIdentity(target).founderPrincipal, trelloPrincipal: sourceIdentity(target).trelloPrincipal });
    assert.deepEqual(prepareTransferRow(global, columns.app_settings, identity, "app_settings"), global);
    assert.throws(() => prepareTransferRow({ ...entry, vaId: null }, columns.time_entries.map(item => ({ ...item, is_nullable: "YES" })), identity, "time_entries"));
    assert.throws(() => prepareTransferRow({ ...entry, vaId: 3 }, columns.time_entries, identity, "time_entries"));
    assert.throws(() => prepareTransferRow({ ...global, vaId: 2 }, columns.app_settings, identity, "unreviewed_table"), /Unreviewed/);
    assert.throws(() => prepareTransferRow({ ...global, vaId: undefined }, columns.app_settings, identity, "app_settings"));
    assert.throws(() => prepareTransferRow({ ...global, value: null }, columns.app_settings, identity, "app_settings"), /Null required/);
  });

  it("allows data-only import with acknowledgement but never overwrites secrets or claims migration completion", async () => {
    const value = settingsPayload();
    const db = fixture();
    await assert.rejects(transferOperatorRecords(db, value, settingsDefinitions, { identity, execute: true }), /Acknowledge/);
    assert.equal(db.queries.length, 0);
    const report = await transferOperatorRecords(db, value, settingsDefinitions, { identity, execute: true, acknowledgeCredentialOmissions: true });
    assert.equal(report.success, false);
    assert.equal(report.applied, true);
    assert.equal(report.dataCheckPassed, true);
    assert.equal(report.completion, "private-credential-restoration-required");
    assert.deepEqual(report.tables.app_settings, { source: 2, credentialOmissions: 1, inserted: 1, identical: 0, wouldInsert: 0 });
    assert.deepEqual(db.state.tables.app_settings, [{ ...secret, value: "synthetic-target-secret" }, global]);
    assert.equal(JSON.stringify(value).includes(secret.value), false);
    const reconciled = await transferOperatorRecords(db, value, settingsDefinitions, { identity, reconcile: true, acknowledgeCredentialOmissions: true });
    assert.equal(reconciled.success, false);
    assert.equal(reconciled.tables.app_settings.identical, 1);
    assert.equal(reconciled.credentialOmissions.length, 1);
    assert.equal(parseTransferArguments(["import", "--worker-user-id", "2", "--founder-user-id", "1", "--worker-profile-id", "3", "--acknowledge-credential-omissions"]).acknowledgeCredentialOmissions, true);
  });

  it("accounts for every omission and rejects hidden credentials, unknown reasons, altered scopes and manifest collisions", () => {
    const invalid = [];
    let p = settingsPayload(); p.credentialOmissions[0].value = "must-not-be-here"; invalid.push(p);
    p = settingsPayload(); p.credentialOmissions[0].reason = "unknown"; invalid.push(p);
    p = settingsPayload(); p.credentialOmissions[0].vaId = 3; invalid.push(p);
    p = settingsPayload(); p.credentialOmissions[0].table = "time_entries"; invalid.push(p);
    p = settingsPayload(); p.credentialOmissions[0].id = global.id; invalid.push(p);
    p = settingsPayload(); p.counts.app_settings = 1; invalid.push(p);
    p = settingsPayload(); p.tables.app_settings.push({ ...secret, value: null }); invalid.push(p);
    for (const value of invalid) assert.throws(() => validateTransferPayload(value, settingsDefinitions, identity));
    const nested = redactSensitiveSettings([{ ...global, key: "integration_config", value: JSON.stringify({ nested: { apiKey: "hidden-fixture-secret" } }) }]);
    assert.equal(nested.rows.length, 0);
    assert.equal(nested.credentialOmissions.length, 1);
    assert.equal(JSON.stringify(nested).includes("hidden-fixture-secret"), false);
  });
});

describe("operator import/reconciliation transactions", () => {
  it("reviews in a read-only snapshot without inserts, DDL or sequence consumption", async () => {
    const db = database();
    const p = payload();
    const before = structuredClone(p);
    const report = await transferOperatorRecords(db, p, definitions, { identity });
    assert.equal(report.mode, "dry-run");
    assert.equal(report.applied, false);
    assert.equal(report.tables.time_entries.wouldInsert, 1);
    assert.deepEqual(p, before);
    assert.deepEqual(db.state.tables.time_entries, []);
    assert.match(db.queries[0].sql, /READ ONLY$/);
    assert.equal(db.queries.at(-1).sql, "ROLLBACK");
    assert.ok(db.queries.every(({ sql }) => !/INSERT|UPDATE|DELETE|ALTER|LOCK TABLE|nextval|setval/.test(sql)));
  });
  it("inserts, verifies returned content, repairs sequences and commits after all repairs", async () => {
    const db = database();
    const report = await transferOperatorRecords(db, payload(), definitions, { identity, execute: true });
    assert.equal(report.success, true);
    assert.equal(report.applied, true);
    assert.equal(report.tables.time_entries.inserted, 1);
    assert.deepEqual(db.state.tables.time_entries, [entry]);
    assert.deepEqual(db.state.sequences.time_entries, { last: "9", called: false });
    const sql = db.queries.map(query => query.sql);
    assert.ok(sql.findIndex(value => value.startsWith("LOCK TABLE")) < sql.findIndex(value => value.startsWith("SELECT p.id")));
    assert.ok(sql.findIndex(value => value.endsWith("CACHE 1")) < sql.findIndex(value => value.startsWith("SELECT last_value")));
    assert.equal(sql.at(-1), "COMMIT");
    assert.ok(sql.some(value => /RETURNING \*/.test(value)));
    assert.ok(sql.every(value => !/setval|nextval\(/.test(value)));
  });
  it("does not rewind a sequence allocated before its DDL lock", async () => {
    const db = database({ allocateBeforeSequenceLock: true });
    await transferOperatorRecords(db, payload(), definitions, { identity, execute: true });
    assert.equal(db.state.sequences.time_entries.last, "901");
  });
  it("accepts exactly matching records as verified idempotent records, without updates", async () => {
    const db = database({ tables: { time_entries: [entry] } });
    const report = await transferOperatorRecords(db, payload(), definitions, { identity, execute: true });
    assert.equal(report.tables.time_entries.identical, 1);
    assert.equal(report.tables.time_entries.inserted, 0);
    assert.equal(db.state.sequences.time_entries.last, "9");
    assert.ok(db.queries.every(({ sql }) => !/INSERT INTO|UPDATE /.test(sql)));
  });
  it("rejects unrelated same-ID rows, ownership collisions, natural-key and split-key collisions", async () => {
    const cases = [
      { tables: { time_entries: [{ ...entry, notes: "independently initialized" }] } },
      { tables: { time_entries: [{ ...entry, founderId: 99 }] } },
      { tables: { time_entries: [{ ...entry, vaId: 99 }] } },
    ];
    for (const test of cases) {
      const db = database(test);
      await assert.rejects(transferOperatorRecords(db, payload(), definitions, { identity, execute: true }), /collision/);
      assert.equal(db.queries.at(-1).sql, "ROLLBACK");
    }
    for (const rows of [[{ ...card, id: 20 }], [{ ...card, cardId: "other" }], [{ ...card, id: 20 }, { ...card, cardId: "other" }]]) {
      const db = database({ tables: { card_states: rows } });
      await assert.rejects(transferOperatorRecords(db, payload({ time_entries: [], card_states: [card] }), definitions, { identity, execute: true }), /collision/);
    }
  });
  it("rolls back earlier inserts when any later source ownership, key or schema is invalid", async () => {
    for (const second of [{ ...entry, id: 10, vaId: 99 }, { ...entry }, { vaId: 2, founderId: 1, notes: "missing id" }]) {
      const db = database();
      await assert.rejects(transferOperatorRecords(db, payload({ time_entries: [entry, second], card_states: [] }), definitions, { identity, execute: true }));
      assert.deepEqual(db.state.tables.time_entries, []);
    }
    const db = database({ columns: { card_states: [] } });
    await assert.rejects(transferOperatorRecords(db, payload(), definitions, { identity, execute: true }), /Target table missing/);
    assert.deepEqual(db.state.tables.time_entries, []);
  });
  it("refuses database coercion or triggers that change inserted source content", async () => {
    const db = database({ coerce: row => ({ ...row, notes: "changed" }) });
    await assert.rejects(transferOperatorRecords(db, payload(), definitions, { identity, execute: true }), /Inserted content/);
    assert.deepEqual(db.state.tables.time_entries, []);
  });
  it("rolls back both inserted rows and earlier sequence repairs if a later sequence is unsupported", async () => {
    const db = database({ sequenceMetadata: { card_states: { cache: "10" } } });
    await assert.rejects(transferOperatorRecords(db, payload({ time_entries: [entry], card_states: [card] }), definitions, { identity, execute: true }), /Unsupported identity sequence/);
    assert.ok(db.queries.some(({ sql }) => sql.endsWith("RESTART WITH 9")));
    assert.deepEqual(db.state.tables, { time_entries: [], card_states: [] });
    assert.deepEqual(db.state.sequences.time_entries, { last: "1", called: false });
    assert.equal(db.queries.at(-1).sql, "ROLLBACK");
  });
  it("reconciles keys and content, never accepts unrelated or merely numerous target records", async () => {
    const valid = database({ tables: { time_entries: [entry, { ...entry, id: 99, notes: "unrelated" }] } });
    const report = await transferOperatorRecords(valid, payload(), definitions, { identity, reconcile: true });
    assert.equal(report.tables.time_entries.identical, 1);
    assert.match(valid.queries[0].sql, /READ ONLY/);
    assert.ok(valid.queries.every(({ sql }) => !sql.includes("COUNT(*)")));
    for (const rows of [[{ ...entry, id: 99 }, { ...entry, id: 100 }], [{ ...entry, notes: "wrong content" }]]) {
      const db = database({ tables: { time_entries: rows } });
      await assert.rejects(transferOperatorRecords(db, payload(), definitions, { identity, reconcile: true }));
      assert.equal(db.queries.at(-1).sql, "ROLLBACK");
    }
  });
  it("rejects exhausted identity sequences without committing rows", async () => {
    const db = database({ sequenceMetadata: { time_entries: { maximum: "8" } } });
    await assert.rejects(transferOperatorRecords(db, payload(), definitions, { identity, execute: true }), /exhausted/);
    assert.deepEqual(db.state.tables.time_entries, []);
  });
});

describe("identity sequence arithmetic", () => {
  it("handles uncalled, ahead, empty and bigint high-water marks without rewinding", () => {
    assert.equal(sequenceRestartValue("8", "1", false), "9");
    assert.equal(sequenceRestartValue("8", "100", true), "101");
    assert.equal(sequenceRestartValue("8", "100", false), "100");
    assert.equal(sequenceRestartValue(null, "1", false), "1");
    assert.equal(sequenceRestartValue("9007199254740993", "1", true), "9007199254740994");
  });
});

describe("source export preservation", () => {
  function mysqlFixture(missing = false) {
    const queries = [];
    return { queries, async query(sql, values) {
      queries.push(sql);
      if (sql.includes("information_schema.tables")) return [[{ count: missing && values[0] === "card_states" ? 0 : 1 }]];
      if (sql.startsWith("SELECT *")) return [[{ key: "working_hours", value: "09:00" }].filter(() => sql.includes("app_settings"))];
      if (sql.includes("FROM va_profiles")) return [[target]];
      return [[]];
    } };
  }
  it("uses a read-only source snapshot, fingerprints and exclusive private output writes", async () => {
    const db = mysqlFixture();
    let saved;
    const report = await exportOperatorData(db, "synthetic-export.json", {
      async mkdir() {}, async writeFile(_output, content, options) {
        assert.equal(options.flag, "wx");
        assert.equal(options.mode, 0o600);
        saved = content;
      },
    });
    assert.equal(report.success, true);
    assert.match(db.queries[2], /CONSISTENT SNAPSHOT, READ ONLY/);
    const exported = verifyExport(JSON.parse(saved));
    assert.deepEqual(exported.identities, [sourceIdentity(target)]);
    assert.equal(saved.includes(target.workerOpenId), false);
    assert.equal(saved.includes(target.founderOpenId), false);
    assert.equal(exported.skipped.length, 0);
    assert.equal(Object.keys(exported.tables).length, TABLES.length);
  });
  it("never overwrites a retained export and never labels skipped source tables successful", async () => {
    await assert.rejects(exportOperatorData(mysqlFixture(), "retained-export.json", {
      async mkdir() {}, async writeFile() { throw Object.assign(new Error("exists"), { code: "EEXIST" }); },
    }), { code: "EEXIST" });
    const report = await exportOperatorData(mysqlFixture(true), "incomplete-export.json", {
      async mkdir() {}, async writeFile() {},
    });
    assert.equal(report.success, false);
    assert.deepEqual(report.skipped, ["card_states"]);
  });
});
