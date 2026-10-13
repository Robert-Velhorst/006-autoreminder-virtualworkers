import { randomUUID } from "node:crypto";
import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateMySQLDrizzleJson } from "drizzle-kit/api";
import * as schema from "../drizzle/schema";

const folder = new URL("../drizzle/meta/", import.meta.url);
const previous = JSON.parse(readFileSync(new URL("0049_snapshot.json", folder), "utf8"));
const current = JSON.parse(JSON.stringify(await generateMySQLDrizzleJson(schema)));
const target = new URL("0050_snapshot.json", folder);

if (existsSync(target)) {
  const snapshot = JSON.parse(readFileSync(target, "utf8"));
  strictEqual(snapshot.prevId, previous.id);
  deepStrictEqual(snapshot.tables, current.tables);
  deepStrictEqual(snapshot.views, current.views);
} else {
  current.id = randomUUID();
  current.prevId = previous.id;
  writeFileSync(target, JSON.stringify(current, null, 2) + "\n", { flag: "wx" });
}
