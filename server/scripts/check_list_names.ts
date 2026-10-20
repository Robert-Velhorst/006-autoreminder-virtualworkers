import { getDb } from "../db";
import { atisCards } from "../../drizzle/schema.postgres";
import { eq } from "drizzle-orm";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  const db = await getDb();
  if (!db) throw new Error("No db");

  const cards = await db.select().from(atisCards);
  const listNames = new Map<string, number>();

  for (const card of cards) {
    const list = card.listName || "NULL";
    listNames.set(list, (listNames.get(list) || 0) + 1);
  }

  console.log("List Name counts in DB:");
  for (const [list, count] of listNames.entries()) {
    console.log(`  - "${list}": ${count}`);
  }
  process.exit(0);
}

run().catch(console.error);
