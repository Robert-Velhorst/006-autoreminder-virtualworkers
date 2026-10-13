import { readFile, writeFile } from "node:fs/promises";
import { generateMySQLDrizzleJson } from "drizzle-kit/api";
import * as schema from "../schema.ts";

if (!process.argv.includes("--write")) throw new Error("Explicit --write required");
const previous = JSON.parse(await readFile(new URL("../meta/0045_snapshot.json", import.meta.url), "utf8"));
const target = new URL("../meta/0046_snapshot.json", import.meta.url);
const snapshot = await generateMySQLDrizzleJson(schema, previous.id);
try { snapshot.id = JSON.parse(await readFile(target, "utf8")).id; }
catch (error) { if (error.code !== "ENOENT") throw error; }
await writeFile(target, JSON.stringify(snapshot, null, 2) + "\n");
console.log("Generated additive review-index snapshot; no database accessed");
