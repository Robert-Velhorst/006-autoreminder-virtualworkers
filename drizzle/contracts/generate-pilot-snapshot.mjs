import { readFile, writeFile } from "node:fs/promises";
import { generateMySQLDrizzleJson } from "drizzle-kit/api";
import * as schema from "../schema.ts";

// Offline metadata generation only. No config, credentials, database or migrator.
const previous = JSON.parse(await readFile(new URL("../meta/0031_snapshot.json", import.meta.url), "utf8"));
const target = new URL("../meta/0045_snapshot.json", import.meta.url);
const snapshot = await generateMySQLDrizzleJson(schema, previous.id);
if (!process.argv.includes("--write")) {
  throw new Error("Use node --import tsx drizzle/contracts/generate-pilot-snapshot.mjs --write");
}
try {
  const existing = JSON.parse(await readFile(target, "utf8"));
  snapshot.id = existing.id;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(target, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8" });
console.log("Generated 0045 snapshot using drizzle-kit: " + Object.keys(snapshot.tables).length + " tables");
