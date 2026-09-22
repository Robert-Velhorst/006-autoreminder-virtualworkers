import { getDb } from "../db";
import { atisCards, atisCardUnderstanding } from "../../drizzle/schema";
import { processCardUnderstanding } from "../services/atis-understanding";
import { eq, and, sql, isNull } from "drizzle-orm";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  const confirmationFlag = "--confirm-ai-reanalysis";
  if (!process.argv.includes(confirmationFlag)) {
    throw new Error(`Refusing AI reanalysis. Re-run with ${confirmationFlag} after reviewing the expected model usage.`);
  }

  const db = await getDb();
  if (!db) throw new Error("No db");

  console.log("Finding all active cards in active lists that need AI analysis...");

  const INACTIVE_KEYWORDS = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];
  const excludeInactiveSql = sql`LOWER(${atisCards.listName}) NOT LIKE '%done%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%completed%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%complete%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%archive%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%archived%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%info%'`;

  // Get cards that either have no understanding, or have understanding with <= 1 steps
  const cards = await db.select({
    id: atisCards.id,
    name: atisCards.name,
    listName: atisCards.listName,
    aptlssChecklist: atisCardUnderstanding.aptlssChecklist,
  })
    .from(atisCards)
    .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
    .where(and(
      eq(atisCards.isArchived, 0),
      excludeInactiveSql
    ));

  const cardsToAnalyze: typeof cards = [];
  for (const card of cards) {
    let needsAnalysis = false;
    if (!card.aptlssChecklist) {
      needsAnalysis = true;
    } else {
      try {
        const parsed = JSON.parse(card.aptlssChecklist);
        if (!Array.isArray(parsed) || parsed.length <= 1) {
          needsAnalysis = true;
        }
      } catch {
        needsAnalysis = true;
      }
    }
    if (needsAnalysis) {
      cardsToAnalyze.push(card);
    }
  }

  console.log(`Found ${cardsToAnalyze.length} cards needing AI analysis out of ${cards.length} active cards.`);

  // Analyze them sequentially to avoid rate limits
  for (let i = 0; i < cardsToAnalyze.length; i++) {
    const card = cardsToAnalyze[i];
    console.log(`[${i+1}/${cardsToAnalyze.length}] Analyzing card: ${card.name} (List: ${card.listName})...`);
    try {
      await processCardUnderstanding(card.id);
    } catch (e: any) {
      console.error(`Error analyzing card ${card.id}:`, e.message);
    }
    // Small delay to be gentle on API limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("Finished generating AI breakdowns for all active cards!");
  process.exit(0);
}

run().catch(console.error);
