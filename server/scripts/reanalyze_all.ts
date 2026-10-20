import { getDb } from "../db";
import { atisCards, atisCardUnderstanding } from "../../drizzle/schema.postgres";
import { processCardUnderstanding } from "../services/atis-understanding";
import { eq } from "drizzle-orm";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  const confirmationFlag = "--confirm-ai-reanalysis";
  if (!process.argv.includes(confirmationFlag)) {
    throw new Error(`Refusing bulk AI reanalysis. Re-run with ${confirmationFlag} after reviewing the expected model usage.`);
  }

  const db = await getDb();
  if (!db) throw new Error("No db");

  console.log("Getting all active cards...");
  const cards = await db.select().from(atisCards).where(eq(atisCards.isArchived, 0));
  
  console.log(`Found ${cards.length} active cards.`);

  console.log("Clearing all existing AI understandings so they regenerate with the new format...");
  await db.delete(atisCardUnderstanding);

  for (let i = 0; i < cards.length; i++) {
    console.log(`[${i+1}/${cards.length}] Re-analyzing card: ${cards[i].name}...`);
    try {
      await processCardUnderstanding(cards[i].id);
    } catch (e: any) {
      console.error(`Error on card ${cards[i].id}:`, e.message);
    }
  }

  console.log("Finished generating detailed AI breakdowns for all cards!");
  process.exit(0);
}

run().catch(console.error);
