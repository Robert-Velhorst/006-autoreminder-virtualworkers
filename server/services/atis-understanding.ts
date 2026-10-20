/**
 * ATIS AI Task Understanding Service
 * 
 * Uses AI to analyze Trello cards and generate:
 * - Task goal and deliverable
 * - Entity extraction (people, organizations, systems, documents)
 * - Complexity assessment
 * - Time estimation
 * - APTLSS checklist generation
 */

import { getDb } from '../db';
import { 
  atisCards, 
  atisAttachments, 
  atisComments,
  atisCardUnderstanding,
  atisBoards,
  type ATISCard,
  type ATISAttachment,
  type ATISComment,
} from '../../drizzle/schema.postgres';
import { eq, isNull, and, sql, desc } from 'drizzle-orm';
import { invokeLLM } from '../_core/llm';
import { ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader, type ScheduledJobTransaction } from '../scheduledJobRuntime';

// atis-understanding uses the same LLM provider chain as the rest of the app:
// GROQ_API_KEY (free) → OPENAI_API_KEY → BUILT_IN_FORGE_API_KEY
// No Forge-specific hardcoding needed.

interface CardContext {
  card: ATISCard;
  boardName: string;
  attachments: ATISAttachment[];
  comments: ATISComment[];
}

interface TaskUnderstanding {
  goal: string;
  deliverable: string;
  taskType: string;
  entities: {
    people: string[];
    organizations: string[];
    cases: string[];
    systems: string[];
    documents: string[];
  };
  deadlines: Array<{ date: string; source: string; description: string }>;
  estimatedMinutes: number;
  dependencies: string[];
  produces: string[];
  domain: string;
  complexity: 'simple' | 'medium' | 'complex';
  clarityScore: number;
  missingInfo: string[];
  confidenceScore: number;
  aptlssChecklist: APTLSSItem[];
}

interface APTLSSItem {
  name: string;
  estimatedMinutes: number;
  priority: 'A' | 'P' | 'T' | 'L' | 'S';
  dependencies?: string[];
}

interface UnderstandingProgress {
  current: number;
  total: number;
  cardName: string;
  status: 'processing' | 'success' | 'failed';
}

type ProgressCallback = (progress: UnderstandingProgress) => void | Promise<void>;

async function assertUnderstandingOwnership(context?: ScheduledJobContext, transaction?: ScheduledJobOwnershipReader): Promise<void> {
  if (!context) return;
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
  await context.assertOwnership(transaction);
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
}

function rethrowUnderstandingCancellation(error: unknown, context?: ScheduledJobContext): void {
  if (context && (error instanceof ScheduledJobLeaseLostError || (error instanceof Error && error.name === 'AbortError'))) throw error;
}

interface InterviewGuidance {
  goal?: string;
  deliverable?: string;
  successCriteria?: string[];
}

/**
 * Build full context for a card including attachments and comments
 */
async function buildCardContext(cardId: number): Promise<CardContext | null> {
  const db = await getDb();
  if (!db) return null;

  // Get the card
  const [card] = await db.select()
    .from(atisCards)
    .where(eq(atisCards.id, cardId))
    .limit(1);

  if (!card) return null;

  // Get board name
  const [board] = await db.select()
    .from(atisBoards)
    .where(eq(atisBoards.id, card.boardId))
    .limit(1);

  // Get attachments
  const attachments = await db.select()
    .from(atisAttachments)
    .where(eq(atisAttachments.cardId, cardId));

  // Get comments (most recent first)
  const comments = await db.select()
    .from(atisComments)
    .where(eq(atisComments.cardId, cardId))
    .orderBy(desc(atisComments.commentDate))
    .limit(15); // Keep to 15 most recent to stay within token limits

  return {
    card,
    boardName: board?.name || 'Unknown Board',
    attachments,
    comments,
  };
}

/**
 * Format card context into a prompt for AI analysis
 */
function formatContextForAI(
  context: CardContext,
  extractedContent?: ExtractedContent,
  interviewGuidance?: InterviewGuidance
): string {
  const { card, boardName, attachments, comments } = context;

  let prompt = `# Task Card Analysis

## Card Information
- **Board**: ${boardName}
- **List**: ${card.listName || 'Unknown'}
- **Title**: ${card.name}
- **Description**: ${card.description || 'No description provided'}
- **Due Date**: ${card.dueDate ? new Date(card.dueDate).toLocaleDateString() : 'Not set'}
- **Labels**: ${card.labels || 'None'}

## Attachments (${attachments.length} total)
`;

  if (attachments.length > 0) {
    for (const att of attachments.slice(0, 20)) { // Limit to 20 attachments
      prompt += `- ${att.filename || att.url} (${att.fileType || 'unknown type'})`;
      const extracted = extractedContent?.attachments?.find(a => a.attachmentId === att.id);
      if (extracted?.content) {
        prompt += `\n  Content preview: ${extracted.content.substring(0, 1000)}${extracted.content.length > 1000 ? '...' : ''}`;
      } else if (att.extractedContent) {
        prompt += `\n  Content preview: ${att.extractedContent.substring(0, 500)}...`;
      }
      prompt += '\n';
    }
  } else {
    prompt += 'No attachments\n';
  }

  prompt += `\n## Comments (${comments.length} total, showing most recent)\n`;

  if (comments.length > 0) {
    for (const comment of comments.slice(0, 15)) { // Limit to 15 comments
      const date = comment.commentDate ? new Date(comment.commentDate).toLocaleDateString() : 'Unknown date';
      prompt += `- [${date}] ${comment.authorName || 'Unknown'}: ${comment.text?.substring(0, 300) || ''}${(comment.text?.length || 0) > 300 ? '...' : ''}\n`;
    }
  } else {
    prompt += 'No comments\n';
  }

  // Add chatbot conversations if available
  if (extractedContent?.chatbotConversations && extractedContent.chatbotConversations.length > 0) {
    prompt += `\n## Chatbot Conversations (${extractedContent.chatbotConversations.length} found)\n`;
    prompt += `These are AI assistant conversations that provide context on how to complete this task:\n\n`;
    for (const conv of extractedContent.chatbotConversations.slice(0, 3)) { // Limit to 3 conversations
      prompt += `### ${conv.platform.toUpperCase()}: ${conv.title}\n`;
      prompt += `${conv.content.substring(0, 2000)}${conv.content.length > 2000 ? '...' : ''}\n\n`;
    }
  }

  if (interviewGuidance?.goal || interviewGuidance?.deliverable || interviewGuidance?.successCriteria?.length) {
    prompt += `\n## Goal Interview Guidance\n`;
    if (interviewGuidance.goal) {
      prompt += `- Clarified Goal: ${interviewGuidance.goal}\n`;
    }
    if (interviewGuidance.deliverable) {
      prompt += `- Clarified Deliverable: ${interviewGuidance.deliverable}\n`;
    }
    if (interviewGuidance.successCriteria?.length) {
      prompt += `- Success Criteria:\n`;
      for (const criterion of interviewGuidance.successCriteria) {
        prompt += `  - ${criterion}\n`;
      }
    }
    prompt += `Use this interview guidance as the strongest signal when it conflicts with vague card text.\n`;
  }

  return prompt;
}

interface ExtractedContent {
  attachments?: Array<{
    attachmentId: number;
    content: string;
    wordCount: number;
  }>;
  chatbotConversations?: Array<{
    platform: string;
    title: string;
    content: string;
  }>;
}

/**
 * Call AI to analyze the card and generate understanding
 */
async function analyzeWithAI(
  context: CardContext,
  extractedContent?: ExtractedContent,
  interviewGuidance?: InterviewGuidance,
  jobContext?: ScheduledJobContext
): Promise<TaskUnderstanding> {
  const contextText = formatContextForAI(context, extractedContent, interviewGuidance);

  const systemPrompt = `You are an expert task analyst for a Virtual Assistant management system. Your job is to analyze Trello cards and extract structured information to help VAs understand and complete tasks efficiently.

Analyze the provided card information and return a JSON object with the following structure:
{
  "goal": "Clear, concise statement of what this task is trying to achieve (1-2 sentences)",
  "deliverable": "Specific, tangible output that marks this task as complete",
  "taskType": "One of: communication, research, creation, meeting, review, admin, finance, legal, technical, personal",
  "entities": {
    "people": ["Names of people mentioned or involved"],
    "organizations": ["Companies, agencies, institutions mentioned"],
    "cases": ["Case numbers, reference numbers, ticket IDs"],
    "systems": ["Software, platforms, tools mentioned"],
    "documents": ["Specific documents referenced"]
  },
  "deadlines": [{"date": "YYYY-MM-DD", "source": "where this deadline came from", "description": "what's due"}],
  "estimatedMinutes": 30,
  "dependencies": ["What must happen before this task can be completed"],
  "produces": ["What completing this task enables or produces"],
  "domain": "Area of work (e.g., HR, Finance, Legal, IT, Personal, Business)",
  "complexity": "simple|medium|complex",
  "clarityScore": 7,
  "missingInfo": ["Information that would help complete this task but is not provided"],
  "confidenceScore": 85,
  "aptlssChecklist": [
    {"name": "[L] Learn - Review attached documents and context to understand the scope", "estimatedMinutes": 15, "priority": "L"},
    {"name": "[P] Process - Draft the initial response or plan based on findings", "estimatedMinutes": 20, "priority": "P"},
    {"name": "[T] Task - Execute the technical configuration or main work", "estimatedMinutes": 45, "priority": "T"},
    {"name": "[A] Action - Notify the Founder or client for review", "estimatedMinutes": 5, "priority": "A"}
  ],
  "suggestedTags": ["tag1", "tag2"],
  "isActionable": true,
  "reasonNotActionable": "If false, why?"
}

APTLSS Categorization Guide (CRITICAL - YOU MUST PREFIX EVERY STEP NAME EXACTLY LIKE THIS):
- [P] Process (Priority P): Drafting, reading, processing information, analyzing, structuring, planning.
- [T] Task (Priority T): Executing concrete work, uploading, configuring, building, fixing, doing.
- [A] Action (Priority A): Communication, notifying a team member, sending an email, requesting approval, meetings.
- [L] Learn (Priority L): Reviewing attachments, researching, learning new context, gathering data, reading documentation.

CHECKLIST GENERATION - CRITICAL RULES (TO MATCH MANUS AI V2 QUALITY):
1. GRANULARITY IS MANDATORY: You MUST generate between 15 to 20 highly detailed, granular steps. Never return just 3 or 4 broad steps.
2. CATEGORY PREFIX: Every single step "name" MUST begin with its exact category prefix (e.g., "[P] Process - ", "[T] Task - ", "[A] Action - ", or "[L] Learn - ").
3. TIME ESTIMATES: Break down large chunks of work into 10-30 minute increments. Do not create single steps taking 180m without breaking them down.
4. ACTUALLY NEEDED: Generate steps based on WHAT IS ACTUALLY NEEDED to complete the task properly.

You MUST include steps for:
1. COMMUNICATION THREADS: Every person/party mentioned in comments or attachments who needs to be:
   - Notified of progress or completion
   - Responded to (if they asked questions)
   - Updated on status changes
   - Confirmed with before proceeding

2. COMMITMENTS & PROMISES: Any explicit or implicit promises made in:
   - Card description
   - Comments ("I will...", "We'll send...", "Let me check...")
   - Attachments (email threads, chat logs)
   - Referenced documents

3. STAKEHOLDER AWARENESS: Ensure ALL parties are informed:
   - Who initiated this task?
   - Who is waiting for the outcome?
   - Who needs to approve or review?
   - Who might be affected by the result?

4. DEPENDENCIES & PREREQUISITES:
   - What information needs to be gathered first?
   - What approvals are needed?
   - What other tasks must complete before this one?

5. QUALITY GATES:
   - Review steps before sending/publishing
   - Verification that requirements are met
   - Double-check critical details

6. FOLLOW-UP ACTIONS:
   - What happens after the main task is done?
   - Who needs to be notified of completion?
   - What documentation needs to be updated?

Guidelines:
- Be specific and actionable - each step should be completable in one sitting
- Estimate time realistically based on actual work required
- Extract ALL entities mentioned in the card, comments, and attachments
- If information is unclear, note it in missingInfo
- Confidence score should reflect how well you understand what needs to be done
- DO NOT limit steps to a fixed number - include EVERYTHING needed for proper completion
- Include notification/communication steps even if they seem minor

Return ONLY valid JSON, no markdown formatting or explanation.`;

  await assertUnderstandingOwnership(jobContext);
  try {
    const result = await invokeLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this Trello card and generate a structured task understanding:\n\n${contextText}` },
      ],
      maxTokens: 4000, // Increased from 1500 — checklist with 5-10 steps needs ~2000-3500 tokens
      responseFormat: { type: 'json_object' },
    });

    await assertUnderstandingOwnership(jobContext);
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in AI response');

    // Parse the JSON response - handle markdown code blocks
    let jsonContent = typeof content === 'string' ? content.trim() : JSON.stringify(content);
    if (jsonContent.startsWith('```json')) jsonContent = jsonContent.slice(7);
    else if (jsonContent.startsWith('```')) jsonContent = jsonContent.slice(3);
    if (jsonContent.endsWith('```')) jsonContent = jsonContent.slice(0, -3);
    jsonContent = jsonContent.trim();

    // Try to parse the JSON — if truncated (common with low token limits), attempt recovery
    let parsed: TaskUnderstanding;
    try {
      parsed = JSON.parse(jsonContent) as TaskUnderstanding;
    } catch (parseError) {
      // If JSON is truncated, try to repair by finding the last complete aptlssChecklist item
      // This handles the case where the AI response is cut off mid-array
      const truncatedMatch = jsonContent.match(/("aptlssChecklist"\s*:\s*\[[\s\S]*?\])\s*[,}]/);
      if (truncatedMatch) {
        // Re-attempt with a repaired JSON ending
        try {
          const repaired = jsonContent.substring(0, jsonContent.lastIndexOf('}')) + '}';
          parsed = JSON.parse(repaired) as TaskUnderstanding;
          console.warn('[ATIS Understanding] Repaired truncated JSON response');
        } catch {
          throw parseError; // Fall through to error handler
        }
      } else {
        throw parseError;
      }
    }

    return parsed;
  } catch (error: any) {
    rethrowUnderstandingCancellation(error, jobContext);
    await assertUnderstandingOwnership(jobContext);
    console.error('[ATIS Understanding] AI analysis error:', error);

    // Return a safe default on error
    return {
      goal: `Complete task: ${context.card.name}`,
      deliverable: 'Task completion',
      taskType: 'admin',
      entities: { people: [], organizations: [], cases: [], systems: [], documents: [] },
      deadlines: [],
      estimatedMinutes: 30,
      dependencies: [],
      produces: [],
      domain: 'General',
      complexity: 'medium',
      clarityScore: 3,
      missingInfo: ['AI analysis failed - manual review recommended'],
      confidenceScore: 20,
      aptlssChecklist: [
        { name: `Review and complete: ${context.card.name.substring(0, 50)}`, estimatedMinutes: 30, priority: 'T' }
      ],
    };
  }
}

/**
 * Save understanding to database
 */
async function saveUnderstanding(cardId: number, cardTrelloId: string, understanding: TaskUnderstanding, context?: ScheduledJobContext): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const data = {
    cardId,
    cardTrelloId,
    goal: understanding.goal,
    deliverable: understanding.deliverable,
    taskType: understanding.taskType,
    entities: JSON.stringify(understanding.entities),
    deadlines: JSON.stringify(understanding.deadlines),
    estimatedMinutes: understanding.estimatedMinutes,
    dependencies: JSON.stringify(understanding.dependencies),
    produces: JSON.stringify(understanding.produces),
    domain: understanding.domain,
    complexity: understanding.complexity,
    clarityScore: understanding.clarityScore,
    missingInfo: JSON.stringify(understanding.missingInfo),
    confidenceScore: understanding.confidenceScore,
    aptlssChecklist: JSON.stringify(understanding.aptlssChecklist || []),
    status: 'complete' as const,
    generatedAt: new Date(),
  };

  const persist = async (connection: NonNullable<Awaited<ReturnType<typeof getDb>>> | ScheduledJobTransaction) => {
    // The ownership lock is held on this connection through transaction commit.
    await assertUnderstandingOwnership(context, connection);
    const [existing] = await connection.select().from(atisCardUnderstanding)
      .where(eq(atisCardUnderstanding.cardId, cardId)).limit(1);
    await assertUnderstandingOwnership(context, connection);
    if (existing) {
      await connection.update(atisCardUnderstanding).set(data)
        .where(eq(atisCardUnderstanding.cardId, cardId));
    } else {
      await connection.insert(atisCardUnderstanding).values(data);
    }
    await assertUnderstandingOwnership(context, connection);
  };
  if (context) await db.transaction(persist);
  else await persist(db);
}

/**
 * Load extracted content for a card (attachments and chatbot conversations)
 */
async function loadExtractedContent(cardId: number): Promise<ExtractedContent | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  try {
    // Load extracted attachment content
    const attachmentsResult = await db.execute(sql`
      SELECT id, "extractedContent"
      FROM atis_attachments
      WHERE "cardId" = ${cardId}
        AND extractionStatus = 'success'
        AND extractedContent IS NOT NULL
    `);
    const attachments = attachmentsResult.rows.map((a: any) => ({
      attachmentId: a.id,
      content: a.extractedContent || '',
      wordCount: 0,
    }));

    // Load chatbot conversations (table may not exist in all deployments)
    let chatbotConversations: Array<{ platform: string; title: string; content: string }> = [];
    try {
      const conversationsResult = await db.execute(sql`
        SELECT platform, title, full_content
        FROM atis_chatbot_conversations
        WHERE card_id = ${cardId}
      `);
      chatbotConversations = conversationsResult.rows.map((c: any) => ({
        platform: c.platform,
        title: c.title || 'Untitled',
        content: c.full_content || '',
      }));
    } catch {
      // Table doesn't exist — skip silently
    }

    if (attachments.length === 0 && chatbotConversations.length === 0) {
      return undefined;
    }

    return { attachments, chatbotConversations };
  } catch (error) {
    console.error('[ATIS Understanding] Error loading extracted content:', error);
    return undefined;
  }
}

/**
 * Process a single card with AI understanding
 */
export async function processCardUnderstanding(
  cardId: number,
  interviewGuidanceOrContext?: InterviewGuidance | ScheduledJobContext
): Promise<TaskUnderstanding | null> {
  const jobContext = interviewGuidanceOrContext && 'assertOwnership' in interviewGuidanceOrContext
    ? interviewGuidanceOrContext : undefined;
  const interviewGuidance = interviewGuidanceOrContext && !('assertOwnership' in interviewGuidanceOrContext)
    ? interviewGuidanceOrContext : undefined;
  await assertUnderstandingOwnership(jobContext);
  const context = await buildCardContext(cardId);
  await assertUnderstandingOwnership(jobContext);
  if (!context) {
    console.error(`[ATIS Understanding] Card ${cardId} not found`);
    return null;
  }

  console.log(`[ATIS Understanding] Analyzing card: ${context.card.name.substring(0, 50)}...`);

  // Load extracted content (attachments and chatbot conversations)
  const extractedContent = await loadExtractedContent(cardId);
  if (extractedContent) {
    const attachCount = extractedContent.attachments?.length || 0;
    const convCount = extractedContent.chatbotConversations?.length || 0;
    console.log(`[ATIS Understanding] Including ${attachCount} extracted attachments, ${convCount} chatbot conversations`);
  }

  const understanding = await analyzeWithAI(context, extractedContent, interviewGuidance, jobContext);
  await saveUnderstanding(cardId, context.card.trelloId, understanding, jobContext);

  return understanding;
}

/**
 * Process all cards that don't have understanding yet
 */
export async function processAllCardsUnderstanding(
  onProgress?: ProgressCallback,
  limit?: number,
  context?: ScheduledJobContext
): Promise<{ processed: number; failed: number }> {
  await assertUnderstandingOwnership(context);
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const INACTIVE_KEYWORDS = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];
  const excludeInactiveSql = sql`LOWER(${atisCards.listName}) NOT LIKE '%done%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%completed%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%complete%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%archive%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%archived%' 
    AND LOWER(${atisCards.listName}) NOT LIKE '%info%'`;

  // Get cards WITHOUT understanding (non-archived only)
  const cardsWithoutUnderstanding = await db.select({
    id: atisCards.id,
    trelloId: atisCards.trelloId,
    name: atisCards.name,
  })
    .from(atisCards)
    .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
    .where(and(
      isNull(atisCardUnderstanding.id),
      eq(atisCards.isArchived, 0),
      excludeInactiveSql
    ))
    .limit(limit || 1000);

  // Also get cards with fallback/error understandings (confidence < 30 = AI analysis failed previously)
  // These were saved with the error fallback (1 step) due to the old 1500 token limit
  const cardsWithFallbackUnderstanding = await db.select({
    id: atisCards.id,
    trelloId: atisCards.trelloId,
    name: atisCards.name,
  })
    .from(atisCards)
    .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
    .where(and(
      eq(atisCards.isArchived, 0),
      sql`${atisCardUnderstanding.confidenceScore} < 30`,
      excludeInactiveSql
    ))
    .limit(Math.floor((limit || 1000) / 2)); // Allow up to half the limit for re-processing

  // Merge and deduplicate by card ID
  const allCardIds = new Set<number>();
  const allCards: { id: number; trelloId: string; name: string }[] = [];
  for (const card of [...cardsWithoutUnderstanding, ...cardsWithFallbackUnderstanding]) {
    if (!allCardIds.has(card.id)) {
      allCardIds.add(card.id);
      allCards.push(card);
    }
  }

  console.log(`[ATIS Understanding] Found ${cardsWithoutUnderstanding.length} unanalyzed + ${cardsWithFallbackUnderstanding.length} low-confidence cards to process (${allCards.length} total)`);


  let processed = 0;
  let failed = 0;

  for (let i = 0; i < allCards.length; i++) {
    await assertUnderstandingOwnership(context);
    const card = allCards[i];

    if (onProgress) {
      await onProgress({
        current: i + 1,
        total: allCards.length,
        cardName: card.name,
        status: 'processing',
      });
    }

    let status: 'success' | 'failed';
    try {
      await processCardUnderstanding(card.id, context);
      processed++;
      status = 'success';

      console.log(`[ATIS Understanding] [${i + 1}/${allCards.length}] Processed: ${card.name.substring(0, 50)}...`);
    } catch (error: any) {
      rethrowUnderstandingCancellation(error, context);
      await assertUnderstandingOwnership(context);
      failed++;
      status = 'failed';
      console.error(`[ATIS Understanding] Failed to process card ${card.id}:`, error.message);

    }
    await assertUnderstandingOwnership(context);
    if (onProgress) await onProgress({ current: i + 1, total: allCards.length, cardName: card.name, status });

    // Rate limiting: wait 500ms between AI calls to avoid hitting API rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await assertUnderstandingOwnership(context);
  return { processed, failed };
}

/**
 * Get understanding statistics
 */
export async function getUnderstandingStats(): Promise<{
  totalCards: number;
  withUnderstanding: number;
  withoutUnderstanding: number;
  avgConfidence: number;
  avgClarity: number;
  byComplexity: { simple: number; medium: number; complex: number };
  byTaskType: Record<string, number>;
}> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [totalResult] = await db.select({ count: sql<number>`count(*)` })
    .from(atisCards)
    .where(eq(atisCards.isArchived, 0));

  const [withResult] = await db.select({ count: sql<number>`count(*)` })
    .from(atisCardUnderstanding);

  const [avgResult] = await db.select({
    avgConfidence: sql<number>`AVG(confidenceScore)`,
    avgClarity: sql<number>`AVG(clarityScore)`,
  }).from(atisCardUnderstanding);

  // Get complexity breakdown
  const complexityResults = await db.select({
    complexity: atisCardUnderstanding.complexity,
    count: sql<number>`count(*)`,
  })
    .from(atisCardUnderstanding)
    .groupBy(atisCardUnderstanding.complexity);

  const byComplexity = { simple: 0, medium: 0, complex: 0 };
  for (const row of complexityResults) {
    if (row.complexity && row.complexity in byComplexity) {
      byComplexity[row.complexity as keyof typeof byComplexity] = Number(row.count);
    }
  }

  // Get task type breakdown
  const taskTypeResults = await db.select({
    taskType: atisCardUnderstanding.taskType,
    count: sql<number>`count(*)`,
  })
    .from(atisCardUnderstanding)
    .groupBy(atisCardUnderstanding.taskType);

  const byTaskType: Record<string, number> = {};
  for (const row of taskTypeResults) {
    if (row.taskType) {
      byTaskType[row.taskType] = Number(row.count);
    }
  }

  return {
    totalCards: Number(totalResult?.count) || 0,
    withUnderstanding: Number(withResult?.count) || 0,
    withoutUnderstanding: (Number(totalResult?.count) || 0) - (Number(withResult?.count) || 0),
    avgConfidence: Math.round(avgResult?.avgConfidence || 0),
    avgClarity: Math.round(avgResult?.avgClarity || 0),
    byComplexity,
    byTaskType,
  };
}
