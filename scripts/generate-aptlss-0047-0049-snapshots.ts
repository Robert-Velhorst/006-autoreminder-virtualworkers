import { randomUUID } from "node:crypto";
import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateMySQLDrizzleJson } from "drizzle-kit/api";
import * as schema from "../drizzle/schema";

const folder = new URL("../drizzle/meta/", import.meta.url);
const prior = JSON.parse(readFileSync(new URL("0046_snapshot.json", folder), "utf8"));
const current = JSON.parse(JSON.stringify(await generateMySQLDrizzleJson(schema)));
const beforeDeadline = structuredClone(current);
delete beforeDeadline.tables.founder_decision_deadlines;
const indexOnly = structuredClone(beforeDeadline);
for (const column of ["outcome", "deadlineDate", "sourceEvidenceId", "sourceDescription"]) {
  delete indexOnly.tables.aptlss_manager_updates.columns[column];
}
const queuePath = new URL("0047_snapshot.json", folder);
const updatePath = new URL("0048_snapshot.json", folder);
const deadlinePath = new URL("0049_snapshot.json", folder);
if (existsSync(queuePath) || existsSync(updatePath)) {
  if (!existsSync(queuePath) || !existsSync(updatePath) || !existsSync(deadlinePath)) throw new Error("All APTLSS snapshots must exist together.");
  const queue = JSON.parse(readFileSync(queuePath, "utf8"));
  const update = JSON.parse(readFileSync(updatePath, "utf8"));
  const deadline = JSON.parse(readFileSync(deadlinePath, "utf8"));
  strictEqual(queue.prevId, prior.id);
  strictEqual(update.prevId, queue.id);
  strictEqual(deadline.prevId, update.id);
  deepStrictEqual(queue.tables, indexOnly.tables);
  deepStrictEqual(update.tables, beforeDeadline.tables);
  deepStrictEqual(deadline.tables, current.tables);
} else {
  indexOnly.id = randomUUID();
  indexOnly.prevId = prior.id;
  beforeDeadline.id = randomUUID();
  beforeDeadline.prevId = indexOnly.id;
  current.id = randomUUID();
  current.prevId = beforeDeadline.id;
  writeFileSync(queuePath, JSON.stringify(indexOnly, null, 2) + "\n", { flag: "wx" });
  writeFileSync(updatePath, JSON.stringify(beforeDeadline, null, 2) + "\n", { flag: "wx" });
  writeFileSync(deadlinePath, JSON.stringify(current, null, 2) + "\n", { flag: "wx" });
}
