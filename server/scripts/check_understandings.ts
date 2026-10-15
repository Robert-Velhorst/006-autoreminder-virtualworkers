import { getDb } from "../db";
import { atisCards, atisCardUnderstanding } from "../../drizzle/schema.postgres";
import { eq, sql } from "drizzle-orm";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  const db = await getDb();
  if (!db) throw new Error("No db");

  // Get total active cards
  const activeCards = await db.select().from(atisCards).where(eq(atisCards.isArchived, 0));
  console.log(`Total active cards in DB: ${activeCards.length}`);

  // Get active cards in active lists
  const INACTIVE_KEYWORDS = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];
  const activeCardsInActiveLists = activeCards.filter(card => {
    if (!card.listName) return true;
    const normalized = card.listName.toLowerCase().trim();
    return !INACTIVE_KEYWORDS.some(kw => normalized === kw || normalized.includes(kw));
  });
  console.log(`Active cards in active lists: ${activeCardsInActiveLists.length}`);

  // Get understandings
  const understandings = await db.select().from(atisCardUnderstanding);
  console.log(`Total understandings in DB: ${understandings.length}`);

  let emptyChecklists = 0;
  let singleStepChecklists = 0;
  let multiStepChecklists = 0;

  for (const u of understandings) {
    if (!u.aptlssChecklist) {
      emptyChecklists++;
    } else {
      try {
        const parsed = JSON.parse(u.aptlssChecklist);
        if (parsed.length <= 1) {
          singleStepChecklists++;
        } else {
          multiStepChecklists++;
        }
      } catch (e) {
        emptyChecklists++;
      }
    }
  }

  console.log(`Understandings with empty checklist: ${emptyChecklists}`);
  console.log(`Understandings with 1 step checklist: ${singleStepChecklists}`);
  console.log(`Understandings with >1 steps checklist: ${multiStepChecklists}`);
  process.exit(0);
}

run().catch(console.error);
