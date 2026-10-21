import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyBrowserCollectorImport } from "./operator-data-transfer-ownership.mjs";
import {
  prepareTransferRow, quoteIdentifier, sameTransferRecord, sourceIdentity,
  redactSensitiveSettings, transferIdentity, transferOperatorRecords, validateTargetIdentity,
} from "./operator-data-transfer-utils.mjs";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";

const collector = {
  id: 8,
  vaId: 2,
  collectorId: "collector-a",
  captureSequence: 7,
  collectorLabel: "Worker browser",
  totalTabs: 2,
  pinnedTabs: 0,
  windowCount: 1,
  tabsJson: "[]",
};

describe("browser collector data-transfer ownership", () => {
  it("allows a new collector row", () => {
    expect(classifyBrowserCollectorImport([], collector)).toEqual({ action: "insert" });
  });

  it("refuses to transfer a collector to another worker", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, vaId: 4 })).toMatchObject({
      action: "conflict",
      reason: "collector belongs to a different worker",
    });
  });

  it("refuses a primary-key collision with a different collector", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, collectorId: "collector-b" })).toMatchObject({
      action: "conflict",
      reason: "row ID or collector ID belongs to another collector",
    });
  });

  it("skips older and identical exports without rewinding freshness", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, captureSequence: 6 })).toMatchObject({
      action: "skip",
      reason: "exported browser snapshot is older than the target",
    });
    expect(classifyBrowserCollectorImport([collector], collector)).toMatchObject({
      action: "skip",
      reason: "identical collector snapshot already exists",
    });
  });

  it("rejects different data at the same sequence and accepts a newer sequence", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, tabsJson: "[{}]" })).toMatchObject({
      action: "conflict",
      reason: "same collector sequence contains different data",
    });
    expect(classifyBrowserCollectorImport([collector], { ...collector, captureSequence: 8 })).toMatchObject({
      action: "update",
      existing: collector,
    });
  });
});

describe("strict operator recovery identity and snapshot policy", () => {
  const identity = transferIdentity(2, 1, 3);
  const target = {
    workerUserId: 2, workerProfileId: 3, founderUserId: 1, workerOpenId: "worker-fixture", founderOpenId: "founder-fixture",
    trelloMemberId: "trello-fixture", workerRole: "worker", founderRole: "admin", workerStatus: "active",
  };

  it("binds matching numeric IDs to the actual source worker and founder principals", () => {
    const source = sourceIdentity(target);
    expect(() => validateTargetIdentity(source, [target], identity)).not.toThrow();
    for (const change of [
      { workerOpenId: "another-worker" }, { founderOpenId: "another-founder" },
      { trelloMemberId: "another-trello-member" }, { founderUserId: 2 }, { workerUserId: 4 }, { workerProfileId: 2 },
      { founderRole: "worker" }, { workerStatus: "inactive" },
    ]) {
      expect(() => validateTargetIdentity(source, [{ ...target, ...change }], identity)).toThrow(/mismatch/);
    }
    expect(() => validateTargetIdentity(source, [], identity)).toThrow(/missing or ambiguous/);
    expect(() => validateTargetIdentity(source, [target, target], identity)).toThrow(/missing or ambiguous/);
  });

  it("does not silently remap non-null source worker/founder IDs or invent missing ownership", () => {
    const metadata = [
      { column_name: "vaId", data_type: "integer" },
      { column_name: "founderId", data_type: "integer" },
      { column_name: "trackedUserId", data_type: "integer", is_nullable: "YES" },
      { column_name: "trackedProfileId", data_type: "integer", is_nullable: "YES" },
    ];
    expect(prepareTransferRow({ vaId: "2", founderId: "1" }, metadata, identity, "time_entries"))
      .toEqual({ vaId: "2", founderId: "1", trackedUserId: null, trackedProfileId: null });
    expect(prepareTransferRow({ vaId: 4, founderId: 1 }, metadata, identity, 'time_entries'))
      .toEqual({ vaId: 4, founderId: 1, trackedUserId: null, trackedProfileId: null });
    expect(prepareTransferRow({ vaId: null, founderId: 1, trackedUserId: 2, trackedProfileId: 3 }, metadata, identity, 'time_entries'))
      .toMatchObject({ trackedUserId: 2, trackedProfileId: 3 });
    for (const row of [{ vaId: 2, founderId: 2 }, { vaId: 2 },
      { vaId: 2, founderId: 1, trackedUserId: 3 }, { vaId: 2, founderId: 1, trackedUserId: 2, trackedProfileId: 2 },
      { vaId: 2, founderId: 1, trackedProfileId: 3 }]) {
      expect(() => prepareTransferRow(row, metadata, identity, "time_entries")).toThrow();
    }
  });

  it("requires exact collector content including timestamps, not a freshness-based skip or overwrite", () => {
    const expected = { ...collector, sourceCapturedAt: "2026-10-21 12:00:00" };
    const metadata = Object.keys(expected).map(column_name => ({
      column_name,
      data_type: column_name === "sourceCapturedAt" ? "timestamp without time zone"
        : typeof expected[column_name] === "number" ? "integer" : "text",
    }));
    expect(sameTransferRecord(expected, expected, metadata)).toBe(true);
    for (const change of [
      { captureSequence: 6 }, { captureSequence: 8 }, { sourceCapturedAt: "2026-10-21 12:01:00" },
      { vaId: 4 }, { tabsJson: "[{}]" }, { collectorLabel: "different browser" },
    ]) {
      expect(sameTransferRecord(expected, { ...expected, ...change }, metadata)).toBe(false);
    }
  });

  it("refuses production, remote, operational and connection-override URLs before native test setup", () => {
    const safe = "postgresql://fixture:fixture@127.0.0.1:5432/recovery_test?sslmode=disable";
    expect(() => requireIsolatedPostgresTestDatabase(safe, true)).toThrow();
    for (const value of [undefined, safe.replace("127.0.0.1", "database.example.com"),
      safe.replace("recovery_test", "production"), `${safe}&options=-csearch_path=public`]) {
      expect(() => requireIsolatedPostgresTestDatabase(value)).toThrow();
    }
    expect(requireIsolatedPostgresTestDatabase(safe)).toBe(safe);
  });
});

// Opt-in only. Never load .env or fall back to operational DATABASE_URL.
const testUrl = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("operator transfer native isolated PostgreSQL transactions", () => {
  let database;
  let schema;
  let schemaCreated;
  let connectionString;
  const identity = transferIdentity(2, 1, 3);
  const principal = {
    workerUserId: 2, workerProfileId: 3, founderUserId: 1, workerOpenId: "synthetic-worker", founderOpenId: "synthetic-founder",
    trelloMemberId: "synthetic-trello-member",
  };
  const definitions = [{ name: "time_entries", keys: ["id"] }, { name: "card_states", keys: ["vaId", "cardId"] }, { name: "app_settings", keys: ["key"] }];
  const entry = { id: 8, vaId: 2, founderId: 1, notes: "synthetic source" };
  const card = { id: 9, vaId: 2, cardId: "synthetic-card", state: { b: 2, a: 1 } };
  const payload = (entries = [entry], cards = [], settings = []) => ({
    format: "joyce-operator-export-v2", credentialOmissions: [], identities: [sourceIdentity(principal)], skipped: [],
    tables: structuredClone({ time_entries: entries, card_states: cards, app_settings: settings }),
    counts: { time_entries: entries.length, card_states: cards.length, app_settings: settings.length },
  });
  const transfer = (data, options = {}) => transferOperatorRecords(database, data, definitions, { identity, ...options });
  const entrySequence = async () => (await database.query(
    'SELECT last_value::text AS value, is_called AS called FROM time_entries_id_seq')).rows[0];
  const nextEntry = async () => (await database.query(
    `INSERT INTO time_entries ("vaId", "founderId", notes) VALUES (2, 1, 'synthetic next insert') RETURNING id`)).rows[0].id;

  beforeEach(async () => {
    schemaCreated = false;
    database = undefined;
    connectionString = requireIsolatedPostgresTestDatabase(testUrl, process.env.NODE_ENV === "production");
    schema = `operator_transfer_${randomUUID().replaceAll("-", "")}`;
    database = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    await database.connect();
    await database.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    // No public search-path fallback: every application table and sequence is disposable.
    await database.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    expect((await database.query("SELECT current_schema() AS schema")).rows[0].schema).toBe(schema);
    await database.query(`
      CREATE TABLE users (id integer PRIMARY KEY, "openId" text NOT NULL UNIQUE, role text NOT NULL);
      CREATE TABLE va_profiles (id integer PRIMARY KEY, "userId" integer NOT NULL REFERENCES users(id),
        "founderId" integer NOT NULL REFERENCES users(id), status text NOT NULL, "trelloMemberId" text);
      CREATE TABLE time_entries (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        "vaId" integer, "trackedUserId" integer REFERENCES users(id),
        "trackedProfileId" integer REFERENCES va_profiles(id), "founderId" integer NOT NULL REFERENCES users(id), notes text NOT NULL);
      CREATE TABLE card_states (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        "vaId" integer NOT NULL REFERENCES users(id), "cardId" text NOT NULL, state jsonb NOT NULL,
        UNIQUE ("vaId", "cardId"));
      CREATE TABLE app_settings (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        "vaId" integer REFERENCES users(id), key varchar(128) NOT NULL UNIQUE, value text NOT NULL,
        "updatedAt" timestamp NOT NULL DEFAULT now());
      INSERT INTO users VALUES (1, 'synthetic-founder', 'admin'), (2, 'synthetic-worker', 'worker');
      INSERT INTO va_profiles VALUES (3, 2, 1, 'active', 'synthetic-trello-member');
    `);
  });

  afterEach(async () => {
    if (!database) return;
    try {
      if (schemaCreated) {
        // Cleanup is confined to the schema this test successfully created.
        if (!/^operator_transfer_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe test cleanup schema");
        await database.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      }
    } finally {
      await database.end();
    }
  });

  it("dry-run leaves rows and sequence allocation untouched; committed import supports the next ordinary insert", async () => {
    expect(await transfer(payload())).toMatchObject({ success: true, applied: false, mode: "dry-run",
      tables: { time_entries: { wouldInsert: 1, inserted: 0 } } });
    expect((await database.query("SELECT * FROM time_entries")).rows).toEqual([]);
    expect(await entrySequence()).toEqual({ value: "1", called: false });
    expect(await transfer(payload(), { execute: true })).toMatchObject({ success: true, applied: true,
      timerIdentityComplete: false, completion: 'timer-identity-review-required',
      tables: { time_entries: { requiresIdentityReview: 1 } } });
    expect((await database.query('SELECT "vaId","trackedUserId","trackedProfileId" FROM time_entries')).rows)
      .toEqual([{ vaId: 2, trackedUserId: null, trackedProfileId: null }]);
    expect(await entrySequence()).toEqual({ value: "9", called: false });
    expect(await nextEntry()).toBe(9);
    expect(await transfer(payload(), { reconcile: true })).toMatchObject({ success: true, applied: false,
      tables: { time_entries: { source: 1, identical: 1 } } });
  });

  it('preserves an orphaned legacy numeric ID as unreviewed provenance, never account ownership', async () => {
    const legacy = { ...entry, vaId: 99 };
    expect(await transfer(payload([legacy]), { execute: true })).toMatchObject({
      dataCheckPassed: true, timerIdentityComplete: false, completion: 'timer-identity-review-required',
      tables: { time_entries: { requiresIdentityReview: 1 } },
    });
    expect((await database.query('SELECT "vaId","trackedUserId","trackedProfileId" FROM time_entries')).rows)
      .toEqual([{ vaId: 99, trackedUserId: null, trackedProfileId: null }]);
    expect(await transfer(payload([legacy]), { reconcile: true })).toMatchObject({
      timerIdentityComplete: false, tables: { time_entries: { identical: 1 } },
    });
  });

  it("rolls back an earlier insert on a later natural-key/record-ID collision without overwriting the target", async () => {
    await database.query(`INSERT INTO card_states (id, "vaId", "cardId", state) VALUES (9, 2, 'independent-card', '{"keep":true}')`);
    await expect(transfer(payload([entry], [card]), { execute: true })).rejects.toThrow(/collision/);
    expect((await database.query("SELECT * FROM time_entries")).rows).toEqual([]);
    expect((await database.query("SELECT * FROM card_states")).rows).toEqual([
      { id: 9, vaId: 2, cardId: "independent-card", state: { keep: true } },
    ]);
    expect(await entrySequence()).toEqual({ value: "1", called: false });
  });

  it("rolls back rows AND an already-applied sequence restart if a later sequence cannot be repaired", async () => {
    await database.query("ALTER SEQUENCE card_states_id_seq CACHE 2");
    await expect(transfer(payload([entry], [card]), { execute: true })).rejects.toThrow(/Unsupported identity sequence: card_states/);
    expect((await database.query("SELECT * FROM time_entries")).rows).toEqual([]);
    expect((await database.query("SELECT * FROM card_states")).rows).toEqual([]);
    expect(await entrySequence()).toEqual({ value: "1", called: false });
    expect(await nextEntry()).toBe(1);
    await database.query("ALTER SEQUENCE card_states_id_seq CACHE 1");
    expect(await transfer(payload([entry], [card]), { execute: true })).toMatchObject({ success: true });
    expect(await nextEntry()).toBe(9);
  });

  it.each([
    { name: "stale", restart: null, consume: false, next: 9 },
    { name: "ahead and uncalled", restart: 100, consume: false, next: 100 },
    { name: "ahead and called", restart: 100, consume: true, next: 101 },
  ])("repairs an idempotent import without rewinding a $name sequence", async ({ restart, consume, next }) => {
    await database.query(`INSERT INTO time_entries (id, "vaId", "founderId", notes) VALUES ($1, $2, $3, $4)`,
      [entry.id, entry.vaId, entry.founderId, entry.notes]);
    if (restart) await database.query(`ALTER SEQUENCE time_entries_id_seq RESTART WITH ${restart}`);
    if (consume) await database.query("SELECT nextval('time_entries_id_seq')");
    expect(await transfer(payload(), { execute: true })).toMatchObject({ success: true,
      tables: { time_entries: { identical: 1, inserted: 0 } } });
    expect(await nextEntry()).toBe(next);
  });

  it("rejects independently initialized principal identities even when the numeric IDs match", async () => {
    await database.query(`UPDATE users SET "openId" = 'synthetic-different-worker' WHERE id = 2`);
    await expect(transfer(payload(), { execute: true })).rejects.toThrow(/principal or ownership mismatch/);
    expect((await database.query("SELECT * FROM time_entries")).rows).toEqual([]);
    expect(await entrySequence()).toEqual({ value: "1", called: false });
  });

  it("requires operational user ID 2, never profile ID 3, while preserving canonical global NULL settings", async () => {
    await expect(transfer(payload([{ ...entry, trackedUserId: 3 }]), { execute: true })).rejects.toThrow(/owner mismatch/);
    const global = { id: 12, vaId: null, key: "working_hours", value: "09:00-17:00" };
    expect(await transfer(payload([entry], [], [global]), { execute: true })).toMatchObject({ success: true, applied: true });
    expect((await database.query('SELECT "vaId", "founderId" FROM time_entries WHERE id = 8')).rows)
      .toEqual([{ vaId: 2, founderId: 1 }]);
    expect((await database.query('SELECT "vaId", value FROM app_settings WHERE id = 12')).rows)
      .toEqual([{ vaId: null, value: global.value }]);
    expect(await transfer(payload([entry], [], [global]), { reconcile: true })).toMatchObject({ success: true });
  });

  it("imports acknowledged nonsecret settings without NULL writes or credential erasure, reporting incomplete restoration", async () => {
    await database.query(`INSERT INTO app_settings (id, "vaId", key, value) VALUES (20, 2, 'refresh_token', 'synthetic-target-secret')`);
    const redacted = redactSensitiveSettings([
      { id: 20, vaId: 2, key: "refresh_token", value: "synthetic-source-secret" },
      { id: 21, vaId: null, key: "working_hours", value: "09:00-17:00" },
    ]);
    const data = payload([], [], redacted.rows);
    data.credentialOmissions = redacted.credentialOmissions;
    data.counts.app_settings = 2;
    expect(JSON.stringify(data)).not.toContain("synthetic-source-secret");
    await expect(transfer(data, { execute: true })).rejects.toThrow(/Acknowledge/);
    expect(await transfer(data, { execute: true, acknowledgeCredentialOmissions: true })).toMatchObject({
      success: false, applied: true, dataCheckPassed: true, completion: "private-credential-restoration-required",
      tables: { app_settings: { source: 2, inserted: 1, credentialOmissions: 1 } },
    });
    expect((await database.query("SELECT value FROM app_settings WHERE id = 20")).rows[0].value).toBe("synthetic-target-secret");
    expect((await database.query("SELECT count(*)::int AS count FROM app_settings WHERE value IS NULL")).rows[0].count).toBe(0);
    expect(await transfer(data, { reconcile: true, acknowledgeCredentialOmissions: true })).toMatchObject({
      success: false, applied: false, dataCheckPassed: true, completion: "private-credential-restoration-required",
      tables: { app_settings: { identical: 1, credentialOmissions: 1 } },
    });
  });

  it("detects split natural-key/primary-key collisions and source omissions instead of accepting target row counts", async () => {
    await database.query(`INSERT INTO card_states (id, "vaId", "cardId", state) VALUES
      (9, 2, 'other-card', '{}'), (10, 2, 'synthetic-card', '{"a":1,"b":2}')`);
    await expect(transfer(payload([], [card]), { execute: true })).rejects.toThrow(/collision/);
    expect((await database.query("SELECT count(*)::int AS count FROM card_states")).rows[0].count).toBe(2);
    await database.query(`INSERT INTO time_entries (id, "vaId", "founderId", notes) VALUES
      (20, 2, 1, 'unrelated one'), (21, 2, 1, 'unrelated two')`);
    await expect(transfer(payload(), { reconcile: true })).rejects.toThrow(/Source record missing/);
    await database.query(`INSERT INTO time_entries (id, "vaId", "founderId", notes) VALUES (8, 2, 1, 'wrong content')`);
    await expect(transfer(payload(), { reconcile: true })).rejects.toThrow(/collision/);
  });

  it("waits for an ordinary table writer and rejects its newly committed conflicting row", async () => {
    const importer = new Client({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    let result;
    try {
      await importer.connect();
      const importerPid = (await importer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await database.query("BEGIN");
      await database.query(`INSERT INTO time_entries (id, "vaId", "founderId", notes) VALUES (8, 2, 1, 'concurrent conflicting writer')`);
      let settled = false;
      result = transferOperatorRecords(importer, payload(), definitions, { identity, execute: true })
        .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const observation = await database.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [importerPid]);
        if (observation.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(settled).toBe(false);
      await database.query("COMMIT");
      expect(await result).toMatchObject({ error: { message: expect.stringContaining("collision") } });
      expect((await database.query("SELECT notes FROM time_entries WHERE id = 8")).rows[0].notes)
        .toBe("concurrent conflicting writer");
    } finally {
      await database.query("ROLLBACK");
      if (result) await result;
      await importer.end();
    }
  }, 15000);
});
