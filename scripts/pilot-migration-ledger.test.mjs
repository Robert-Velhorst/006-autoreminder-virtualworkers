import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readRehearsalMigrationLedger } from "./pilot-migration-ledger.mjs";

const roots = [];
const ledger = [
  { hash: "a".repeat(64), created_at: 1 },
  { hash: "b".repeat(64), created_at: 2 },
];
const name = "backup-2026-10-01T00-00-00-000Z.json";
function fixture(value, file = name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-ledger-test-"));
  roots.push(root);
  const directory = path.join(root, ".local/pilot");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
it("retains the historical source ledger without rewriting it", () => {
  expect(
    readRehearsalMigrationLedger(fixture(ledger, "applied-migrations.json"))
  ).toEqual(ledger);
});
it("reads current identities from the current backup, not the historical ledger", () => {
  const root = fixture({ sourceMigrations: ledger });
  fs.writeFileSync(
    path.join(root, ".local/pilot/applied-migrations.json"),
    JSON.stringify([ledger[0]])
  );
  expect(readRehearsalMigrationLedger(root, name)).toEqual(ledger);
});
it("normalizes numeric MySQL timestamps without changing the hash", () => {
  expect(
    readRehearsalMigrationLedger(
      fixture({
        sourceMigrations: ledger.map(entry => ({
          ...entry,
          created_at: String(entry.created_at),
        })),
      }),
      name
    )
  ).toEqual(ledger);
});
it.each([
  "../backup-2026.json",
  "backup-2026.json/other",
  "",
  "applied-migrations.json",
  "C:\\backup-2026.json",
])("rejects an unsafe or wrong manifest name %s", value => {
  expect(() =>
    readRehearsalMigrationLedger(fixture({ sourceMigrations: ledger }), value)
  ).toThrow("basename");
});
it.each([
  null,
  [],
  {},
  { sourceMigrations: [] },
  { sourceMigrations: [ledger[1], ledger[0]] },
  { sourceMigrations: [ledger[0], ledger[0]] },
  { sourceMigrations: [{ hash: "invalid", created_at: 1 }] },
  { sourceMigrations: [{ hash: ledger[0].hash, created_at: null }] },
  { sourceMigrations: [{ hash: ledger[0].hash, created_at: "" }] },
])("rejects missing or corrupt captured identities %#", value => {
  expect(() => readRehearsalMigrationLedger(fixture(value), name)).toThrow();
});
it("does not aggregate an oversized manifest", () => {
  const root = fixture({ sourceMigrations: ledger });
  fs.appendFileSync(path.join(root, ".local/pilot", name), " ".repeat(65537));
  expect(() => readRehearsalMigrationLedger(root, name)).toThrow("bounded");
});
