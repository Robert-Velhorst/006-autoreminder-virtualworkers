import { getDb } from "../db";
import { atisCards, atisCardUnderstanding } from "../../drizzle/schema.postgres";
import { eq, desc } from "drizzle-orm";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  const db = await getDb();
  if (!db) throw new Error("No db");

  const recent = await db.select({
    id: atisCardUnderstanding.id,
    cardId: atisCardUnderstanding.cardId,
    updatedAt: atisCardUnderstanding.updatedAt,
    aptlssChecklist: atisCardUnderstanding.aptlssChecklist
  })
    .from(atisCardUnderstanding)
    .orderBy(desc(atisCardUnderstanding.updatedAt))
    .limit(10);

  console.log("Recent understandings:");
  for (const r of recent) {
    let steps = 0;
    if (r.aptlssChecklist) {
      try {
        steps = JSON.parse(r.aptlssChecklist).length;
      } catch {}
    }
    console.log(`  - Card ID: ${r.cardId}, Updated: ${r.updatedAt}, Steps: ${steps}`);
  }
  process.exit(0);
}

run().catch(console.error);
