import { encodeTrelloPathSegment } from '../utils/trello-path';
/**
 * ATIS API Routes
 * 
 * Endpoints for the Adaptive Task Intelligence System
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { 
  atisWorkspaces,
  atisBoards, 
  atisCards, 
  atisAttachments,
  atisComments,
  atisIngestionJobs,
  atisCardUnderstanding,
} from '../../drizzle/schema.postgres';
import { eq, desc, isNull, sql, and, inArray } from 'drizzle-orm';
import { getUnderstandingStats } from '../services/atis-understanding';
import { createAtisAnalysisPreview, confirmAtisAnalysisPreview, getAtisAnalysisJob, normalizeAtisAnalysisSelection, AtisAnalysisAdmissionError } from '../atisAnalysisAdmission';
import type { AtisAnalysisSelection } from '../../shared/atisAnalysis';
import { createChecklistSyncService } from '../services/trello-checklist-sync';
import { createAttachmentExtractor } from '../services/attachment-extractor';
import { createChatbotExtractor } from '../services/chatbot-extractor';
import { fetchWithRetry } from '../utils/retry';
import { fetchVerifiedTrelloBoardIds, TrelloBoardInventoryUnavailableError } from '../trelloBoardInventory';
import { atisRateLimiter } from '../middleware/rate-limiter';
import { parseLimitOffset } from '../utils/pagination';
import { normalizeChecklistSyncCardIds, toChecklistSyncCards } from '../atisChecklistSyncRows';
import { startAtisOperation, getAtisOperation, getActiveAtisOperations, AtisOperationRecoveryRequired, AtisOperationRequestConflict } from '../atisOperations';
import type { ScheduledJobContext, ScheduledJobTransaction } from '../scheduledJobRuntime';

const router = Router();
const INACTIVE_LIST_KEYWORDS = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];

type AuthenticatedAtisRequest = Request & {
  user?: {
    id: number;
    role: string;
  };
};

// ATIS powers the retained administrator portal and can trigger Trello and AI work.
// Keep it behind the same authenticated-admin boundary as the portal itself.
function requireAtisAdmin(req: AuthenticatedAtisRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - admin only' });
  }
  next();
}

router.use(requireAtisAdmin);

const analysisId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const analysisToken = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
const analysisGuidance = z.object({ goal: z.string().max(4000).optional(), deliverable: z.string().max(4000).optional(),
  successCriteria: z.array(z.string().trim().min(1).max(500)).max(20).optional() }).strict();
const analysisFields = {
  cardId: analysisId.optional(), cardIds: z.array(analysisId).min(1).max(1000).refine(ids => new Set(ids).size === ids.length).optional(),
  boardId: analysisId.optional(), forceAll: z.boolean().optional(), minConfidence: z.number().int().min(0).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(), afterCardId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), guidance: analysisGuidance.optional(),
};
const analysisSelection = z.object({ mode: z.enum(['single', 'pending', 'low_confidence', 'reanalyze', 'active_placeholders']),
  ...analysisFields }).strict().superRefine((value, issue) => {
    if (value.mode === 'single' ? value.cardId === undefined || value.cardIds !== undefined || value.boardId !== undefined
      || value.forceAll !== undefined || value.minConfidence !== undefined || value.afterCardId !== undefined
      : value.cardId !== undefined) issue.addIssue({ code: 'custom', message: 'Selection does not match its mode' });
  });
const legacyAnalysis = z.object({ ...analysisFields,
  boardId: z.union([analysisId, z.string().regex(/^\d+$/).transform(Number).pipe(analysisId)]).optional(),
  phase: z.literal('preview').optional(), interviewGoal: z.string().max(4000).optional(),
  interviewDeliverable: z.string().max(4000).optional(),
  interviewSuccessCriteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
}).strict();
const analysisConfirmation = z.object({ phase: z.literal('confirm'), previewId: analysisToken,
  requestKey: z.string().min(1).max(128).refine(value => value.trim() === value),
  acknowledgeInterruptedOperationId: analysisId.optional() }).strict();

function analysisFailure(res: Response, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid analysis request' });
  if (error instanceof AtisAnalysisAdmissionError) return res.status(error.status).json({ error: error.message, code: error.code });
  return operationFailure(res, error);
}

function analysisConfirmLimit(req: Request, res: Response, next: NextFunction) {
  return req.body?.phase === 'confirm' ? atisRateLimiter(req, res, next) : next();
}

function analysisStart(mode?: AtisAnalysisSelection['mode']) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const actor = (req as AuthenticatedAtisRequest).user!;
      if (req.params.cardId !== undefined && (!/^[1-9]\d*$/.test(req.params.cardId)
        || !Number.isSafeInteger(Number(req.params.cardId)))) return res.status(400).json({ error: 'Invalid card ID' });
      // The explicit preview endpoint cannot start work. Legacy confirmation
      // submits only the frozen preview identity, never a fresh filter selection.
      if (mode && req.body?.phase === 'confirm') {
        const { phase: _phase, previewId, ...confirmation } = analysisConfirmation.parse(req.body);
        return res.status(202).json({ analysis: await confirmAtisAnalysisPreview(actor.id, previewId, confirmation) });
      }
      let selection: AtisAnalysisSelection;
      if (!mode) {
        const explicit = z.object({ phase: z.literal('preview').optional(), selection: analysisSelection }).strict().parse(req.body);
        selection = explicit.selection;
      } else {
        const body = legacyAnalysis.parse(req.body ?? {});
        const { phase: _phase, interviewGoal, interviewDeliverable, interviewSuccessCriteria, ...fields } = body;
        if (fields.guidance && [interviewGoal, interviewDeliverable, interviewSuccessCriteria].some(value => value !== undefined)) {
          return res.status(400).json({ error: 'Use one guidance representation' });
        }
        const guidance = fields.guidance ?? ([interviewGoal, interviewDeliverable, interviewSuccessCriteria].some(value => value !== undefined)
          ? { goal: interviewGoal, deliverable: interviewDeliverable, successCriteria: interviewSuccessCriteria } : undefined);
        let cardId = fields.cardId;
        if (req.params.cardId !== undefined) {
          if (!/^[1-9]\d*$/.test(req.params.cardId)) return res.status(400).json({ error: 'Invalid card ID' });
          const pathId = analysisId.parse(Number(req.params.cardId));
          if (cardId !== undefined && cardId !== pathId) return res.status(400).json({ error: 'Conflicting card IDs' });
          cardId = pathId;
        }
        selection = analysisSelection.parse({ ...fields, mode: cardId === undefined ? mode : 'single', cardId,
          limit: fields.limit ?? (cardId !== undefined ? 1 : mode === 'low_confidence' ? 50 : 100), guidance });
      }
      return res.json({ preview: await createAtisAnalysisPreview(actor.id, normalizeAtisAnalysisSelection(selection)) });
    } catch (error) { return analysisFailure(res, error); }
  };
}

router.post('/understanding/preview', analysisStart());
router.get('/understanding/analyses/:id', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const id = analysisToken.parse(req.params.id);
    const analysis = await getAtisAnalysisJob((req as AuthenticatedAtisRequest).user!.id, id);
    return analysis ? res.json({ analysis }) : res.status(404).json({ error: 'Analysis not found' });
  } catch (error) { return analysisFailure(res, error); }
});

function operationFailure(res: Response, error: unknown) {
  if (error instanceof RangeError) return res.status(400).json({ error: 'acknowledgeInterruptedOperationId must be a positive integer' });
  if (error instanceof AtisOperationRecoveryRequired) {
    return res.status(409).json({ operation: error.operation, requestedNotStarted: true,
      error: 'Review interrupted work, then POST acknowledgeInterruptedOperationId matching this operation to start a replacement.' });
  }
  if (error instanceof AtisOperationRequestConflict) {
    return res.status(409).json({ operation: error.operation, requestedNotStarted: true, error: error.message });
  }
  return res.status(503).json({ error: 'ATIS status or start unavailable. Read active operations before retrying.' });
}

function recoveryAcknowledgement(body: any): number | undefined {
  const value = body?.acknowledgeInterruptedOperationId;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RangeError('Invalid recovery acknowledgement');
  return value;
}

router.get('/operations/active', async (_req: Request, res: Response) => {
  try { return res.json({ operations: await getActiveAtisOperations() }); }
  catch (error) { return operationFailure(res, error); }
});

router.get('/operations/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid operation ID' });
  try {
    const operation = await getAtisOperation(id);
    return operation ? res.json({ operation }) : res.status(404).json({ error: 'Operation not found' });
  } catch (error) { return operationFailure(res, error); }
});

function isInactiveListName(listName?: string | null) {
  if (!listName) return false;
  const normalized = listName.toLowerCase().trim();
  return INACTIVE_LIST_KEYWORDS.some((keyword) => normalized === keyword || normalized.includes(keyword));
}

function sendAtisFailure(res: Response, operation: string) {
  return res.status(500).json({ error: `Failed to ${operation}. Check the server logs or retry.` });
}

/**
 * GET /api/atis/stats
 * Get current ingestion statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const [workspaceResult] = await db.select({ count: sql<number>`count(*)` }).from(atisWorkspaces);
    const [boardResult] = await db.select({ count: sql<number>`count(*)` }).from(atisBoards);
    const [cardResult] = await db.select({ count: sql<number>`count(*)` }).from(atisCards);
    const [attachmentResult] = await db.select({ count: sql<number>`count(*)` }).from(atisAttachments);
    const [commentResult] = await db.select({ count: sql<number>`count(*)` }).from(atisComments);
    
    // Get pending attachments (not yet processed)
    const [pendingResult] = await db.select({ count: sql<number>`count(*)` })
      .from(atisAttachments)
      .where(eq(atisAttachments.extractionStatus, 'pending'));

    // Get cards without understanding
    const [cardsWithoutUnderstanding] = await db.select({ count: sql<number>`count(*)` })
      .from(atisCards);
    const [cardsWithUnderstanding] = await db.select({ count: sql<number>`count(*)` })
      .from(atisCardUnderstanding);

    // Get cards without due dates
    const [cardsWithoutDueDate] = await db.select({ count: sql<number>`count(*)` })
      .from(atisCards)
      .where(isNull(atisCards.dueDate));

    res.json({
      workspaces: Number(workspaceResult?.count) || 0,
      boards: Number(boardResult?.count) || 0,
      cards: Number(cardResult?.count) || 0,
      attachments: Number(attachmentResult?.count) || 0,
      comments: Number(commentResult?.count) || 0,
      pendingAttachments: Number(pendingResult?.count) || 0,
      cardsWithUnderstanding: Number(cardsWithUnderstanding?.count) || 0,
      cardsWithoutUnderstanding: (Number(cardsWithoutUnderstanding?.count) || 0) - (Number(cardsWithUnderstanding?.count) || 0),
      cardsWithoutDueDate: Number(cardsWithoutDueDate?.count) || 0,
    });
  } catch (error: any) {
    console.error('[ATIS] Stats error:', error);
    sendAtisFailure(res, 'load ATIS statistics');
  }
});

/**
 * GET /api/atis/jobs
 * Get list of ingestion jobs
 */
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const jobs = await db.select()
      .from(atisIngestionJobs)
      .orderBy(desc(atisIngestionJobs.createdAt))
      .limit(20);

    res.json(jobs);
  } catch (error: any) {
    console.error('[ATIS] Jobs error:', error);
    sendAtisFailure(res, 'load ingestion jobs');
  }
});

/**
 * GET /api/atis/workspaces
 * Get all ingested workspaces
 */
router.get('/workspaces', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const workspaces = await db.select()
      .from(atisWorkspaces)
      .orderBy(atisWorkspaces.name);

    res.json(workspaces);
  } catch (error: any) {
    console.error('[ATIS] Workspaces error:', error);
    sendAtisFailure(res, 'load workspaces');
  }
});

/**
 * GET /api/atis/boards
 * Get all ingested boards (optionally filtered by workspace)
 */
router.get('/boards', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const workspaceId = req.query.workspaceId ? parseInt(req.query.workspaceId as string) : undefined;

    let query = db.select().from(atisBoards);
    if (workspaceId) {
      query = query.where(eq(atisBoards.workspaceId, workspaceId)) as any;
    }
    
    const boards = await query.orderBy(atisBoards.name);

    res.json(boards);
  } catch (error: any) {
    console.error('[ATIS] Boards error:', error);
    sendAtisFailure(res, 'load boards');
  }
});

/**
 * GET /api/atis/cards
 * Get all ingested cards (optionally filtered by board)
 */
router.get('/cards', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const boardId = req.query.boardId ? parseInt(req.query.boardId as string) : undefined;
    const { limit, offset } = parseLimitOffset(req.query, { defaultLimit: 100, maxLimit: 200 });

    let query = db.select().from(atisCards);
    if (boardId) {
      query = query.where(eq(atisCards.boardId, boardId)) as any;
    }
    
    const cards = await query
      .orderBy(desc(atisCards.dueDate))
      .limit(limit)
      .offset(offset);

    res.json(cards);
  } catch (error: any) {
    console.error('[ATIS] Cards error:', error);
    sendAtisFailure(res, 'load cards');
  }
});

/**
 * GET /api/atis/cards/:id
 * Get a single card with all its data
 */
router.get('/cards/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const cardId = parseInt(req.params.id);

    const [card] = await db.select()
      .from(atisCards)
      .where(eq(atisCards.id, cardId))
      .limit(1);

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Get attachments
    const attachments = await db.select()
      .from(atisAttachments)
      .where(eq(atisAttachments.cardId, cardId));

    // Get comments
    const comments = await db.select()
      .from(atisComments)
      .where(eq(atisComments.cardId, cardId))
      .orderBy(desc(atisComments.commentDate));

    // Get understanding if exists
    const [understanding] = await db.select()
      .from(atisCardUnderstanding)
      .where(eq(atisCardUnderstanding.cardId, cardId))
      .limit(1);

    res.json({
      ...card,
      attachments,
      comments,
      understanding,
    });
  } catch (error: any) {
    console.error('[ATIS] Card error:', error);
    sendAtisFailure(res, 'load the card');
  }
});

/**
 * GET /api/atis/cards-without-due-date
 * Get all cards that don't have a due date
 */
router.get('/cards-without-due-date', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const cards = await db.select({
      id: atisCards.id,
      trelloId: atisCards.trelloId,
      name: atisCards.name,
      description: atisCards.description,
      url: atisCards.url,
      listName: atisCards.listName,
      boardId: atisCards.boardId,
      isArchived: atisCards.isArchived,
    })
      .from(atisCards)
      .where(isNull(atisCards.dueDate))
      .orderBy(atisCards.name);

    // Get board names for context
    const boardIds = Array.from(new Set(cards.map((c: any) => c.boardId)));
    
    if (boardIds.length > 0) {
      const boards = await db.select()
        .from(atisBoards);
      
      const boardMap = new Map(boards.map((b: any) => [b.id, b.name]));

      const cardsWithBoardNames = cards.map((c: any) => ({
        ...c,
        boardName: boardMap.get(c.boardId) || 'Unknown',
      }));

      return res.json(cardsWithBoardNames);
    }

    res.json(cards);
  } catch (error: any) {
    console.error('[ATIS] Cards without due date error:', error);
    sendAtisFailure(res, 'load cards without due dates');
  }
});

/**
 * GET /api/atis/understanding/stats
 * Get AI understanding statistics
 */
router.get('/understanding/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getUnderstandingStats();
    res.json(stats);
  } catch (error: any) {
    console.error('[ATIS] Understanding stats error:', error);
    sendAtisFailure(res, 'load understanding statistics');
  }
});

/**
 * POST /api/atis/understanding/process
 * Process cards with AI understanding
 */
router.post('/understanding/process', analysisConfirmLimit, analysisStart('pending'));

/**
 * GET /api/atis/card/:id/understanding
 * Get AI understanding for a specific card
 */
router.get('/card/:id/understanding', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const cardId = parseInt(req.params.id);

    const [understanding] = await db.select()
      .from(atisCardUnderstanding)
      .where(eq(atisCardUnderstanding.cardId, cardId))
      .limit(1);

    if (!understanding) {
      return res.status(404).json({ error: 'Understanding not found for this card' });
    }

    // Parse JSON fields
    res.json({
      ...understanding,
      entities: understanding.entities ? JSON.parse(understanding.entities) : null,
      deadlines: understanding.deadlines ? JSON.parse(understanding.deadlines) : null,
      dependencies: understanding.dependencies ? JSON.parse(understanding.dependencies) : null,
      produces: understanding.produces ? JSON.parse(understanding.produces) : null,
      missingInfo: understanding.missingInfo ? JSON.parse(understanding.missingInfo) : null,
    });
  } catch (error: any) {
    console.error('[ATIS] Card understanding error:', error);
    sendAtisFailure(res, 'load card understanding');
  }
});

/**
 * POST /api/atis/understanding/reprocess-failed
 * Reprocess cards with low confidence (fallback results)
 */
router.post('/understanding/reprocess-failed', analysisConfirmLimit, analysisStart('low_confidence'));

/**
 * POST /api/atis/understanding/reprocess/:cardId
 * Re-analyze a single card with AI (regenerate checklist & timeline)
 */
router.post('/understanding/reprocess/:cardId', analysisConfirmLimit, analysisStart('single'));

/**
 * POST /api/atis/cards/:trelloId/reingest
 * Re-ingest a single card from Trello (refresh data)
 */
router.post('/cards/:trelloId/reingest', async (req: Request, res: Response) => {
  try {
    const { trelloId } = req.params;
    const encodedTrelloId = encodeTrelloPathSegment(trelloId);
    if (!encodedTrelloId) {
      return res.status(400).json({ error: 'Invalid Trello card ID' });
    }
    const db = await getDb();
    
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    console.log(`[ATIS] Re-ingesting card ${trelloId} from Trello...`);

    // Fetch fresh card data from Trello
    const encodedCardId = encodeURIComponent(trelloId);
    const cardResponse = await fetchWithRetry(
      `https://api.trello.com/1/cards/${encodedCardId}?key=${apiKey}&token=${token}&checklists=all&attachments=true`,
      undefined,
      { maxRetries: 0, timeoutMs: 15_000 },
    );

    if (!cardResponse.ok) {
      const errorText = await cardResponse.text();
      throw new Error(`Trello API error: ${errorText}`);
    }

    const trelloCard = await cardResponse.json();

    // Find existing card in database
    const [existingCard] = await db.select()
      .from(atisCards)
      .where(eq(atisCards.trelloId, trelloId))
      .limit(1);

    if (!existingCard) {
      return res.status(404).json({ error: 'Card not found in ATIS database' });
    }

    // Update card data
    await db.update(atisCards)
      .set({
        name: trelloCard.name,
        description: trelloCard.desc || null,
        url: trelloCard.url,
        dueDate: trelloCard.due ? new Date(trelloCard.due) : null,
        labels: trelloCard.labels ? JSON.stringify(trelloCard.labels) : null,
        updatedAt: new Date(),
      })
      .where(eq(atisCards.id, existingCard.id));

    // Fetch and update comments
    const commentsResponse = await fetchWithRetry(
      `https://api.trello.com/1/cards/${encodedCardId}/actions?filter=commentCard&key=${apiKey}&token=${token}`,
      undefined,
      { maxRetries: 0, timeoutMs: 15_000 },
    );
    
    if (commentsResponse.ok) {
      const comments = await commentsResponse.json();
      
      // Delete existing comments and re-insert
      await db.delete(atisComments).where(eq(atisComments.cardId, existingCard.id));
      
      for (const comment of comments) {
        await db.insert(atisComments).values({
          cardId: existingCard.id,
          cardTrelloId: trelloId,
          trelloId: comment.id,
          text: comment.data?.text || '',
          authorId: comment.memberCreator?.id || null,
          authorName: comment.memberCreator?.fullName || 'Unknown',
          commentDate: new Date(comment.date),
        });
      }
    }

    console.log(`[ATIS] Successfully re-ingested card ${trelloId}`);

    res.json({
      success: true,
      cardId: existingCard.id,
      trelloId,
      name: trelloCard.name,
      commentsUpdated: true,
    });
  } catch (error: any) {
    console.error(`[ATIS] Failed to reingest card:`, error);
    sendAtisFailure(res, 'reingest the card');
  }
});

/**
 * GET /api/atis/cards/by-trello/:trelloId
 * Get ATIS card ID by Trello ID
 */
router.get('/cards/by-trello/:trelloId', async (req: Request, res: Response) => {
  try {
    const { trelloId } = req.params;
    const db = await getDb();
    
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const [card] = await db.select({ id: atisCards.id, name: atisCards.name })
      .from(atisCards)
      .where(eq(atisCards.trelloId, trelloId))
      .limit(1);

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json(card);
  } catch (error: any) {
    console.error(`[ATIS] Failed to get card by Trello ID:`, error);
    sendAtisFailure(res, 'load the Trello card');
  }
});

/**
 * POST /api/atis/sync
 * Full sync: fetch all boards + cards from Trello and upsert into atis_boards / atis_cards.
 * This must be called at least once before the timeline will show any data.
 */
router.post('/sync', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.TRELLO_API_KEY?.trim();
  const token  = process.env.TRELLO_TOKEN?.trim();
  if (!apiKey || !token) {
    return res.status(500).json({ error: 'Trello credentials not configured' });
  }

  try {
    const operation = await startAtisOperation({ kind: 'sync', ownerUserId: user.id,
      acknowledgeInterruptedOperationId: recoveryAcknowledgement(req.body),
    }, context => runAtisSync(apiKey, token, context));
    return res.status(202).json({ operation });
  } catch (error) { return operationFailure(res, error); }
});

async function runAtisSync(apiKey: string, token: string, context: ScheduledJobContext) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const fenced = <T,>(write: (tx: ScheduledJobTransaction) => Promise<T>) => db.transaction(async tx => {
    await context.assertOwnership(tx);
    const result = await write(tx);
    await context.assertOwnership(tx);
    return result;
  });
  const fetchOwned: typeof fetchWithRetry = async (url, init, options) => {
    const maxRetries = options?.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      await context.assertOwnership();
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options?.timeoutMs ?? 15_000)]);
      try {
        // Retry here so each individual provider attempt gets an awaited lease check.
        const response = await fetchWithRetry(url, { ...init, signal }, { ...options, maxRetries: 0 });
        await context.assertOwnership();
        if (attempt >= maxRetries || ![429, 500, 502, 503, 504].includes(response.status)) return response;
        await response.body?.cancel();
      } catch (error) {
        await context.assertOwnership();
        if (attempt >= maxRetries) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(10_000, 1000 * 2 ** attempt)));
    }
  };
    console.log('[ATIS Sync] Starting full Trello sync...');

    // ── 1. Fetch workspaces ──────────────────────────────────────────────────
    const wsRes = await fetchOwned(
      `https://api.trello.com/1/members/me/organizations?key=${apiKey}&token=${token}`,
      undefined, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 }
    );
    if (!wsRes.ok) throw new Error(`Trello workspaces error: ${await wsRes.text()}`);
    const workspaces: any[] = await wsRes.json();

    // Also include personal boards (not in any workspace)
    const personalBoardsRes = await fetchOwned(
      `https://api.trello.com/1/members/me/boards?filter=open&key=${apiKey}&token=${token}`,
      undefined, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 }
    );
    if (!personalBoardsRes.ok) throw new Error('Trello personal board inventory unavailable');
    const personalBoards: any[] = await personalBoardsRes.json();

    let totalBoards = 0;
    let totalCards  = 0;

    // ── 2. Upsert workspace boards ───────────────────────────────────────────
    const processedBoardIds = new Set<string>();

    const upsertBoard = async (board: any, workspaceId: number | null) => fenced(async tx => {
      if (processedBoardIds.has(board.id)) return null;
      processedBoardIds.add(board.id);

      const existing = await tx.select({ id: atisBoards.id })
        .from(atisBoards).where(eq(atisBoards.trelloId, board.id)).limit(1);

      if (existing.length > 0) {
        await tx.update(atisBoards)
          .set({ name: board.name, updatedAt: new Date() })
          .where(eq(atisBoards.trelloId, board.id));
        return existing[0].id;
      } else {
        const [inserted] = await tx.insert(atisBoards).values({
          trelloId: board.id,
          workspaceId,
          name: board.name,
          url: board.url || null,
          isOpen: 1,
        }).returning({ id: atisBoards.id });
        totalBoards++;
        return inserted.id;
      }
    });

    // Workspace boards
    for (const ws of workspaces) {
      await context.assertOwnership();
      const wsDbId = await fenced(async tx => {
      // Upsert workspace record
      const existingWs = await tx.select({ id: atisWorkspaces.id })
        .from(atisWorkspaces).where(eq(atisWorkspaces.trelloId, ws.id)).limit(1);

      let wsDbId: number;
      if (existingWs.length > 0) {
        wsDbId = existingWs[0].id;
      } else {
        const [insertedWs] = await tx.insert(atisWorkspaces).values({
          trelloId: ws.id,
          name: ws.displayName || ws.name,
          displayName: ws.displayName || null,
          url: ws.url || null,
        }).returning({ id: atisWorkspaces.id });
        wsDbId = insertedWs.id;
      }
      return wsDbId;
      });

      const boardsRes = await fetchOwned(
        `https://api.trello.com/1/organizations/${ws.id}/boards?filter=open&key=${apiKey}&token=${token}`,
        undefined, { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 10000 }
      );
      if (!boardsRes.ok) throw new Error('Trello workspace board inventory unavailable');
      const boards: any[] = await boardsRes.json();

      for (const board of boards) {
        if (board.prefs?.isTemplate) continue;
        await upsertBoard(board, wsDbId);
      }
    }

    // Personal boards (no workspace)
    for (const board of personalBoards) {
      if (board.prefs?.isTemplate) continue;
      await upsertBoard(board, null);
    }

    // ── 3. Fetch and upsert cards for every board ────────────────────────────
    const allBoards = await db.select().from(atisBoards);

    for (const board of allBoards) {
      const cardsRes = await fetchOwned(
        `https://api.trello.com/1/boards/${board.trelloId}/cards?filter=open&fields=id,name,desc,url,due,dueComplete,closed,idList,labels,idMembers,badges&key=${apiKey}&token=${token}`,
        undefined, { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 10000 }
      );
      if (!cardsRes.ok) throw new Error('Trello board cards unavailable');
      const cards: any[] = await cardsRes.json();

      // Fetch list names for this board
      const listsRes = await fetchOwned(
        `https://api.trello.com/1/boards/${board.trelloId}/lists?filter=open&key=${apiKey}&token=${token}`,
        undefined, { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 10000 }
      );
      const listMap = new Map<string, string>();
      if (!listsRes.ok) throw new Error('Trello board lists unavailable');
      if (listsRes.ok) {
        const lists: any[] = await listsRes.json();
        for (const l of lists) listMap.set(l.id, l.name);
      }

      for (const card of cards) {
        await context.assertOwnership();
        if (card.closed) continue;
        const listName = listMap.get(card.idList) || null;

        // Skip cards in inactive lists (Done, Completed, Archive, Info) at ingestion time
        if (isInactiveListName(listName)) continue;

        await fenced(async tx => {
        const existing = await tx.select({ id: atisCards.id })
          .from(atisCards).where(eq(atisCards.trelloId, card.id)).limit(1);

        const cardData = {
          boardId: board.id,
          boardTrelloId: board.trelloId,
          listId: card.idList || null,
          listName,
          name: card.name,
          description: card.desc || null,
          url: card.url || null,
          dueDate: card.due ? new Date(card.due) : null,
          dueComplete: card.dueComplete ? 1 : 0,
          isArchived: 0,
          isClosed: 0,
          labels: card.labels?.length ? JSON.stringify(card.labels) : null,
          memberIds: card.idMembers?.length ? JSON.stringify(card.idMembers) : null,
          checklistCount: card.badges?.checkItems || 0,
          attachmentCount: card.badges?.attachments || 0,
          commentCount: card.badges?.comments || 0,
          rawData: JSON.stringify(card),
          lastSyncedAt: new Date(),
        };

        if (existing.length > 0) {
          await tx.update(atisCards).set({ ...cardData, updatedAt: new Date() })
            .where(eq(atisCards.trelloId, card.id));
        } else {
          await tx.insert(atisCards).values({ trelloId: card.id, ...cardData });
          totalCards++;
        }

        });
      }
    }

    console.log(`[ATIS Sync] Done — ${totalBoards} new boards, ${totalCards} new cards`);

    const stats = await db.select({ count: sql<number>`count(*)` }).from(atisCards);
    const boardStats = await db.select({ count: sql<number>`count(*)` }).from(atisBoards);

    return {
      success: true,
      newBoards: totalBoards,
      newCards: totalCards,
      totalBoards: Number(boardStats[0]?.count) || 0,
      totalCards: Number(stats[0]?.count) || 0,
    };
}

/**
 * GET /api/atis/timeline-tasks
 * Get tasks for the dashboard timeline with AI understanding and checklists
 */
router.get('/timeline-tasks', async (req: Request, res: Response) => {
  const maxRetries = 3;
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { limit, offset } = parseLimitOffset(req.query, { defaultLimit: 50, maxLimit: 200 });

      const db = await getDb();
      if (!db) {
        return res.status(500).json({ error: 'Database not available' });
      }

      const apiKey = process.env.TRELLO_API_KEY?.trim();
      const token = process.env.TRELLO_TOKEN?.trim();
      if (!apiKey || !token) {
        throw new TrelloBoardInventoryUnavailableError();
      }

      const allowedTrelloBoardIds = await fetchVerifiedTrelloBoardIds(apiKey, token);
      if (allowedTrelloBoardIds.length === 0) {
        return res.json({
          scheduled: [],
          overflow: [],
          metrics: {
            totalScheduled: 0,
            totalOverflow: 0,
            totalScheduledMinutes: 0,
            totalOverflowMinutes: 0,
            dailyCapacityMinutes: 480,
            averageDailyLoad: 0,
          },
          pagination: {
            total: 0,
            limit,
            offset,
            hasMore: false,
          },
          filters: {
            filter: req.query.filter || 'upcoming',
            taskType: req.query.taskType,
            complexity: req.query.complexity,
            sortBy: req.query.sortBy || 'dueDate',
            sortOrder: req.query.sortOrder || 'asc',
          },
        });
      }

      const allowedAtisBoards = await db.select({
        id: atisBoards.id,
        trelloId: atisBoards.trelloId,
        name: atisBoards.name,
      })
        .from(atisBoards)
        .where(inArray(atisBoards.trelloId, allowedTrelloBoardIds));

      const allowedAtisBoardIds = allowedAtisBoards.map((board: any) => board.id);
      if (allowedAtisBoardIds.length === 0) {
        return res.json({
          scheduled: [],
          overflow: [],
          metrics: {
            totalScheduled: 0,
            totalOverflow: 0,
            totalScheduledMinutes: 0,
            totalOverflowMinutes: 0,
            dailyCapacityMinutes: 480,
            averageDailyLoad: 0,
          },
          pagination: {
            total: 0,
            limit,
            offset,
            hasMore: false,
          },
          filters: {
            filter: req.query.filter || 'upcoming',
            taskType: req.query.taskType,
            complexity: req.query.complexity,
            sortBy: req.query.sortBy || 'dueDate',
            sortOrder: req.query.sortOrder || 'asc',
          },
        });
      }

      const { 
        filter = 'upcoming', // upcoming, overdue, all, today
        taskType, // admin, creation, technical, etc.
        complexity, // simple, medium, complex
        sortBy = 'dueDate', // dueDate, estimatedTime, complexity
        sortOrder = 'asc',
      } = req.query;

      // Build query conditions
      const conditions = [
        eq(atisCards.isArchived, 0), // Only non-archived cards
        inArray(atisCards.boardId, allowedAtisBoardIds),
      ];

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

      // Get cards with their understanding
      const cards = await db.select({
      id: atisCards.id,
      trelloId: atisCards.trelloId,
      name: atisCards.name,
      description: atisCards.description,
      url: atisCards.url,
      listName: atisCards.listName,
      dueDate: atisCards.dueDate,
      boardId: atisCards.boardId,
      memberIds: atisCards.memberIds,
      // Understanding fields
      understandingId: atisCardUnderstanding.id,
      goal: atisCardUnderstanding.goal,
      deliverable: atisCardUnderstanding.deliverable,
      taskType: atisCardUnderstanding.taskType,
      complexity: atisCardUnderstanding.complexity,
      estimatedMinutes: atisCardUnderstanding.estimatedMinutes,
      confidenceScore: atisCardUnderstanding.confidenceScore,
      clarityScore: atisCardUnderstanding.clarityScore,
      entities: atisCardUnderstanding.entities,
      aptlssChecklist: atisCardUnderstanding.aptlssChecklist,
      analyzedAt: atisCardUnderstanding.updatedAt,
    })
      .from(atisCards)
      .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
      .where(and(...conditions))
      .orderBy(
        sortOrder === 'desc' 
          ? desc(atisCards.dueDate) 
          : atisCards.dueDate
      )
      .limit(limit)
      .offset(offset);

    const boardMap = new Map(allowedAtisBoards.map((b: any) => [b.id, b.name]));

    // Process and filter results
    const cardsNeedingAnalysis: number[] = [];
    let tasks = cards
      .filter((card: any) => !isInactiveListName(card.listName))
      .map((card: any) => {
      // Parse checklist JSON from stored aptlssChecklist or generate fallback
      let checklist: any[] = [];
      let hasStoredChecklist = false;
      
      // First try to parse stored aptlssChecklist from AI understanding
      if (card.aptlssChecklist) {
        try {
          const parsed = JSON.parse(card.aptlssChecklist);
          if (Array.isArray(parsed) && parsed.length > 0) {
            hasStoredChecklist = true;
            checklist = parsed.map((item: any) => ({
              step: item.name || item.step || item.description || 'Step',
              timeMinutes: item.estimatedMinutes || item.timeMinutes || item.time || 15,
              aptlssType: item.priority || item.aptlssType || item.type || 'T',
            }));
          }
        } catch (e) {
          console.warn('[ATIS] Failed to parse aptlssChecklist for card', card.id, e);
        }
      }
      
      // Fallback: generate simple checklist from goal if no stored checklist
      if (checklist.length === 0 && card.goal) {
        checklist = [{ step: card.goal, timeMinutes: card.estimatedMinutes || 30, aptlssType: 'T' }];
      }

      // A valid one-step result is complete data, not an implicit request to expand it.
      if (!hasStoredChecklist) {
        cardsNeedingAnalysis.push(card.id);
      }

      // Parse entities JSON
      let entities: any = null;
      if (card.entities) {
        try {
          entities = JSON.parse(card.entities);
        } catch (e) {
          entities = null;
        }
      }

      // Calculate status based on due date
      let status = 'pending';
      if (card.dueDate) {
        const due = new Date(card.dueDate);
        if (due < now) {
          status = 'overdue';
        } else if (due < todayEnd) {
          status = 'due_today';
        } else if (due < new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)) {
          status = 'due_this_week';
        }
      }

      return {
        id: card.id,
        atisCardId: card.id, // For sync operations
        cardId: card.trelloId, // Trello card ID for API calls
        trelloId: card.trelloId,
        name: card.name,
        description: card.description,
        url: card.url,
        listName: card.listName,
        boardName: boardMap.get(card.boardId) || 'Unknown',
        dueDate: card.dueDate,
        memberIds: (() => {
          try { return card.memberIds ? JSON.parse(card.memberIds) : []; }
          catch { return []; }
        })(),
        status,
        // AI Understanding
        hasUnderstanding: !!card.understandingId,
        goal: card.goal,
        deliverable: card.deliverable,
        taskType: card.taskType,
        complexity: card.complexity,
        estimatedMinutes: card.estimatedMinutes,
        confidenceScore: card.confidenceScore,
        clarityScore: card.clarityScore,
        entities,
        analyzedAt: card.analyzedAt,
        // APTLSS Checklist
        checklist: checklist.map((item: any, index: number) => ({
          id: `${card.id}-step-${index}`,
          step: item.step || item,
          timeMinutes: item.timeMinutes || item.time || 5,
          aptlssType: item.aptlssType || item.type || 'T',
          completed: false, // Will be tracked separately
        })),
        totalSteps: checklist.length,
        completedSteps: 0, // Will be updated from tracking
      };
    });

    // Deduplicate by card name - keep only one card per unique name
    // This handles cases where the same card exists in multiple boards (e.g., template copies)
    const seenCardNames = new Map<string, typeof tasks[0]>();
    tasks.forEach((task: any) => {
      const key = task.name.toLowerCase().trim();
      const existing = seenCardNames.get(key);
      // Keep the one with:
      // 1. AI understanding (prioritize analyzed cards)
      // 2. Higher id (more recent) if both have/don't have understanding
      if (!existing || 
          (task.hasUnderstanding && !existing.hasUnderstanding) ||
          (task.hasUnderstanding === existing.hasUnderstanding && task.id > existing.id)) {
        seenCardNames.set(key, task);
      }
    });
    tasks = Array.from(seenCardNames.values());

    // Apply filters
    if (filter === 'overdue') {
      tasks = tasks.filter((t: any) => t.status === 'overdue');
    } else if (filter === 'today') {
      tasks = tasks.filter((t: any) => t.status === 'due_today');
    } else if (filter === 'upcoming') {
      tasks = tasks.filter((t: any) => t.dueDate && new Date(t.dueDate) >= now);
    }

    if (taskType) {
      tasks = tasks.filter((t: any) => t.taskType === taskType);
    }

    if (complexity) {
      tasks = tasks.filter((t: any) => t.complexity === complexity);
    }

    // Get total count for pagination
    const [totalResult] = await db.select({ count: sql<number>`count(*)` })
      .from(atisCards)
      .where(and(...conditions));

    // For now, all tasks are considered scheduled (no overflow logic in ATIS endpoint)
    // The overflow logic will be applied when scheduling is triggered
    const scheduled = tasks;
    const overflow: typeof tasks = [];
    
    // Calculate metrics
    const totalScheduledMinutes = scheduled.reduce((acc: number, t: any) => acc + (t.estimatedMinutes || 30), 0);
    const totalOverflowMinutes = overflow.reduce((acc: number, t: any) => acc + (t.estimatedMinutes || 30), 0);
    const dailyCapacityMinutes = 480; // 8 hours per day
    
    res.json({
      scheduled,
      overflow,
      analysisRequiredCount: cardsNeedingAnalysis.length,
      pendingAnalysis: cardsNeedingAnalysis.length, // Compatibility: missing stored results, not running work.
      metrics: {
        totalScheduled: scheduled.length,
        totalOverflow: overflow.length,
        totalScheduledMinutes,
        totalOverflowMinutes,
        dailyCapacityMinutes,
        averageDailyLoad: scheduled.length > 0 ? (totalScheduledMinutes / 5) : 0,
      },
      pagination: {
        total: Number(totalResult?.count) || 0,
        limit,
        offset,
        hasMore: tasks.length === limit,
      },
      filters: {
        filter,
        taskType,
        complexity,
        sortBy,
        sortOrder,
      },
    });
      return; // Success - exit retry loop
    } catch (error: any) {
      if (error instanceof TrelloBoardInventoryUnavailableError) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          error: 'Trello work queue is unavailable. Retry after checking the Trello connection.',
          code: 'TRELLO_BOARD_ACCESS_UNAVAILABLE',
        });
      }
      lastError = error;
      console.error(`[ATIS] Timeline tasks error (attempt ${attempt}/${maxRetries}):`, error);
      
      // If it's a connection error and we have retries left, wait and retry
      if ((error.message?.includes('ECONNRESET') || error.message?.includes('ETIMEDOUT')) && attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 100; // Exponential backoff: 200ms, 400ms, 800ms
        console.log(`[ATIS] Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // If it's the last attempt or a non-retryable error, return error
      break;
    }
  }
  
  // All retries exhausted
  console.error('[ATIS] All retry attempts failed:', lastError);
  res.status(500).json({ error: 'Failed to fetch timeline tasks after multiple attempts' });
});

/**
 * POST /api/atis/checklist/toggle
 * Toggle completion status of a checklist step
 */
router.post('/checklist/toggle', async (req: AuthenticatedAtisRequest, res: Response) => {
  try {
    const cardId = Number(req.body?.cardId);
    const stepIndex = Number(req.body?.stepIndex);
    const userId = req.user!.id;

    if (!Number.isInteger(cardId) || cardId <= 0 || !Number.isInteger(stepIndex) || stepIndex < 0) {
      return res.status(400).json({ error: 'cardId and stepIndex must be valid non-negative integers' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Check if already completed
    const existing = await db.execute(
      sql`SELECT id FROM atis_checklist_completion WHERE card_id = ${cardId} AND step_index = ${stepIndex} AND user_id = ${userId}`
    );
    const rows = existing.rows;

    if (rows && rows.length > 0) {
      // Remove completion
      await db.execute(
        sql`DELETE FROM atis_checklist_completion WHERE card_id = ${cardId} AND step_index = ${stepIndex} AND user_id = ${userId}`
      );
      return res.json({ completed: false, cardId, stepIndex });
    } else {
      // Add completion
      await db.execute(
        sql`INSERT INTO atis_checklist_completion (card_id, step_index, user_id) VALUES (${cardId}, ${stepIndex}, ${userId})`
      );
      return res.json({ completed: true, cardId, stepIndex });
    }
  } catch (error: any) {
    console.error('[ATIS] Checklist toggle error:', error);
    sendAtisFailure(res, 'toggle the checklist item');
  }
});

/**
 * GET /api/atis/checklist/status/:cardId
 * Get completion status for all steps of a card
 */
router.get('/checklist/status/:cardId', async (req: AuthenticatedAtisRequest, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const cardId = Number(req.params.cardId);
    const userId = req.user!.id;

    if (!Number.isInteger(cardId) || cardId <= 0) {
      return res.status(400).json({ error: 'Invalid card ID' });
    }

    const result = await db.execute(sql`
      SELECT step_index, user_id, completed_at
      FROM atis_checklist_completion
      WHERE card_id = ${cardId} AND user_id = ${userId}
    `);
    const rows = result.rows;
    const completedSteps = rows.map((r: any) => ({
      stepIndex: r.step_index,
      userId: r.user_id,
      completedAt: r.completed_at,
    }));

    res.json({ cardId, completedSteps });
  } catch (error: any) {
    console.error('[ATIS] Checklist status error:', error);
    sendAtisFailure(res, 'load checklist status');
  }
});

/**
 * POST /api/atis/checklist/sync-completion/:cardId
 * Sync completion status to Trello when a step is completed in dashboard
 */
router.post('/checklist/sync-completion/:cardId', async (req: AuthenticatedAtisRequest, res: Response) => {
  try {
    const cardId = Number(req.params.cardId);
    const stepIndex = Number(req.body?.stepIndex);
    const completed = req.body?.completed;

    if (!Number.isInteger(cardId) || cardId <= 0 || !Number.isInteger(stepIndex) || stepIndex < 0 || typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'cardId, stepIndex, and completed are required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Get card's Trello ID and synced checklist ID
    const cardResult = await db.execute(sql`
      SELECT c."trelloId" AS trello_id, s.trello_checklist_id
      FROM atis_cards c
      LEFT JOIN atis_checklist_sync s ON c."trelloId" = s.trello_card_id
      WHERE c.id = ${cardId}
    `);
    const cardRows = cardResult.rows as Array<{
      trello_id: string | null;
      trello_checklist_id: string | null;
    }>;

    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const { trello_id: trelloCardId, trello_checklist_id: checklistId } = cardRows[0];

    if (!trelloCardId || !checklistId) {
      return res.json({ synced: false, reason: 'Checklist not synced to Trello yet' });
    }

    // Get checklist items from Trello
    const syncService = createChecklistSyncService();
    const checklists = await syncService.getCardChecklists(trelloCardId);
    const aptlssChecklist = checklists.find(c => c.id === checklistId);

    if (!aptlssChecklist) {
      return res.json({ synced: false, reason: 'APTLSS checklist not found on Trello card' });
    }

    // Find the item at the given step index
    if (stepIndex >= aptlssChecklist.checkItems.length) {
      return res.status(400).json({ error: 'Step index out of range' });
    }

    const checkItem = aptlssChecklist.checkItems[stepIndex];
    const newState = completed ? 'complete' : 'incomplete';

    // Update in Trello
    await syncService.updateChecklistItemState(trelloCardId, checkItem.id, newState);

    res.json({ synced: true, stepIndex, completed, trelloItemId: checkItem.id });
  } catch (error: any) {
    console.error('[ATIS] Checklist sync completion error:', error);
    sendAtisFailure(res, 'sync checklist completion');
  }
});

/**
 * POST /api/atis/sync-checklist/:cardId
 * Sync APTLSS checklist to a single Trello card
 */
router.post('/sync-checklist/:cardId', async (req: Request, res: Response) => {
  try {
    const cardId = parseInt(req.params.cardId);
    const { replaceExisting = false, preserveCompleted = true } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Get card understanding with checklist using Drizzle ORM
    const cards = await db
      .select({
        trelloId: atisCards.trelloId,
        aptlssChecklist: atisCardUnderstanding.aptlssChecklist,
      })
      .from(atisCards)
      .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
      .where(eq(atisCards.id, cardId))
      .limit(1);

    if (cards.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const card = cards[0];
    if (!card.trelloId) {
      return res.status(400).json({ error: 'Card has no Trello ID' });
    }

    // Ensure aptlssChecklist is a string or null
    const checklistStr = card.aptlssChecklist as string | null;

    let checklist: any[] = [];
    try {
      checklist = checklistStr ? JSON.parse(checklistStr) : [];
    } catch (e) {
      console.error('[ATIS] Failed to parse checklist:', e);
      return res.status(400).json({ error: 'Invalid checklist data' });
    }

    if (checklist.length === 0) {
      return res.status(400).json({ error: 'No checklist items to sync. Run AI analysis on this card first.' });
    }

    // Guard: Trello credentials must be present before attempting sync
    if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN) {
      return res.status(503).json({ error: 'Trello integration is not configured on the server.' });
    }

    // Sync to Trello
    const syncService = createChecklistSyncService();
    const syncResult = await syncService.syncChecklistToCard(
      card.trelloId,
      checklist,
      { replaceExisting, preserveCompleted }
    );

    res.json(syncResult);
  } catch (error: any) {
    console.error('[ATIS] Checklist sync error:', error);
    sendAtisFailure(res, 'sync the checklist');
  }
});

/**
 * POST /api/atis/sync-checklists/bulk
 * Bulk sync APTLSS checklists to multiple Trello cards
 */
router.post('/sync-checklists/bulk', async (req: Request, res: Response) => {
  try {
    const { replaceExisting = false, preserveCompleted = true } = req.body;
    if (req.body?.cardIds !== undefined && !Array.isArray(req.body.cardIds)) {
      return res.status(400).json({ error: 'cardIds must be an array of positive integer card IDs' });
    }
    const cardIds = normalizeChecklistSyncCardIds(req.body?.cardIds);
    if (Array.isArray(req.body?.cardIds) && (cardIds.length === 0 || cardIds.length !== req.body.cardIds.length)) {
      return res.status(400).json({ error: 'cardIds must contain unique positive integer card IDs' });
    }
    const { limit } = parseLimitOffset({ limit: req.body?.limit }, { defaultLimit: 50, maxLimit: 100 });

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Get cards with understanding
    let result;
    if (cardIds.length > 0) {
      result = await db.execute(sql`
        SELECT c.id, c."trelloId" AS trello_id, u."aptlssChecklist"
        FROM atis_cards c
        JOIN atis_card_understanding u ON c.id = u."cardId"
        WHERE c.id IN (${sql.join(cardIds.map((id) => sql`${id}`), sql`, `)})
        AND u."aptlssChecklist" IS NOT NULL
        AND c."trelloId" IS NOT NULL
        LIMIT ${limit}
      `);
    } else {
      result = await db.execute(sql`
        SELECT c.id, c."trelloId" AS trello_id, u."aptlssChecklist"
        FROM atis_cards c
        JOIN atis_card_understanding u ON c.id = u."cardId"
        WHERE u."aptlssChecklist" IS NOT NULL
        AND c."trelloId" IS NOT NULL
        AND c."isArchived" = 0
        LIMIT ${limit}
      `);
    }

    const rows = result.rows as Array<{
      id: number;
      trello_id: string;
      aptlssChecklist: string | null;
    }>;

    if (rows.length === 0) {
      return res.json({ total: 0, success: 0, failed: 0, results: [] });
    }

    // Parse checklists and prepare for sync
    const cardsToSync = toChecklistSyncCards(rows).map((card) => ({
      ...card,
      cardId: String(card.cardId),
    }));

    // Sync to Trello
    const syncService = createChecklistSyncService();
    const syncResult = await syncService.bulkSync(cardsToSync, { replaceExisting, preserveCompleted });

    res.json(syncResult);
  } catch (error: any) {
    console.error('[ATIS] Bulk checklist sync error:', error);
    sendAtisFailure(res, 'sync checklists in bulk');
  }
});

/**
 * GET /api/atis/sync-status/:cardId
 * Get sync status for a card
 */
router.get('/sync-status/:cardId', async (req: Request, res: Response) => {
  try {
    const cardId = parseInt(req.params.cardId);

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Get card's Trello ID
    const cardResult = await db.execute(sql`
      SELECT "trelloId" AS trello_id FROM atis_cards WHERE id = ${cardId}
    `);
    const cardRows = cardResult.rows;
    
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const trelloId = cardRows[0].trello_id;
    if (!trelloId) {
      return res.json({ synced: false, reason: 'No Trello ID' });
    }

    // Get sync status
    const syncResult = await db.execute(sql`
      SELECT trello_checklist_id, items_synced, synced_at
      FROM atis_checklist_sync
      WHERE trello_card_id = ${trelloId}
    `);
    const syncRows = syncResult.rows;

    if (syncRows.length === 0) {
      return res.json({ synced: false });
    }

    res.json({
      synced: true,
      checklistId: syncRows[0].trello_checklist_id,
      itemsSynced: syncRows[0].items_synced,
      syncedAt: syncRows[0].synced_at,
    });
  } catch (error: any) {
    console.error('[ATIS] Sync status error:', error);
    sendAtisFailure(res, 'load sync status');
  }
});

/**
 * GET /api/atis/task-types
 * Get available task types for filtering
 */
router.get('/task-types', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const result = await db.select({
      taskType: atisCardUnderstanding.taskType,
      count: sql<number>`count(*)`,
    })
      .from(atisCardUnderstanding)
      .groupBy(atisCardUnderstanding.taskType)
      .orderBy(desc(sql`count(*)`));

    res.json(result.filter((r: any) => r.taskType));
  } catch (error: any) {
    console.error('[ATIS] Task types error:', error);
    sendAtisFailure(res, 'load task types');
  }
});

// ============================================
// ATTACHMENT EXTRACTION ENDPOINTS
// ============================================

/**
 * GET /api/atis/extraction/stats
 * Get attachment extraction statistics
 */
router.get('/extraction/stats', async (req: Request, res: Response) => {
  try {
    const extractor = createAttachmentExtractor();
    const stats = await extractor.getExtractionStats();
    res.json(stats);
  } catch (error: any) {
    console.error('[ATIS] Extraction stats error:', error);
    sendAtisFailure(res, 'load extraction statistics');
  }
});

/**
 * POST /api/atis/extraction/process
 * Process pending attachments for content extraction
 */
router.post('/extraction/process', async (req: Request, res: Response) => {
  try {
    const { limit } = parseLimitOffset({ limit: req.body?.limit }, { defaultLimit: 50, maxLimit: 100 });
    const extractor = createAttachmentExtractor();
    const result = await extractor.processPendingAttachments(limit);
    res.json(result);
  } catch (error: any) {
    console.error('[ATIS] Extraction process error:', error);
    sendAtisFailure(res, 'process extraction');
  }
});

/**
 * GET /api/atis/extraction/card/:cardId
 * Get extracted content for a specific card
 */
router.get('/extraction/card/:cardId', async (req: Request, res: Response) => {
  try {
    const cardId = parseInt(req.params.cardId);
    const extractor = createAttachmentExtractor();
    const content = await extractor.getCardAttachmentContent(cardId);
    res.json({ cardId, attachmentCount: content.length, content });
  } catch (error: any) {
    console.error('[ATIS] Card extraction error:', error);
    sendAtisFailure(res, 'load card extraction');
  }
});

// ============================================
// CHATBOT URL EXTRACTION ENDPOINTS
// ============================================

/**
 * GET /api/atis/chatbot/stats
 * Get chatbot URL extraction statistics
 */
router.get('/chatbot/stats', async (req: Request, res: Response) => {
  try {
    const extractor = createChatbotExtractor();
    const stats = await extractor.getStats();
    res.json(stats);
  } catch (error: any) {
    console.error('[ATIS] Chatbot stats error:', error);
    sendAtisFailure(res, 'load chatbot statistics');
  }
});

/**
 * POST /api/atis/chatbot/scan
 * Scan cards and comments for chatbot URLs
 */
router.post('/chatbot/scan', async (req: Request, res: Response) => {
  try {
    const extractor = createChatbotExtractor();
    const detected = await extractor.scanForChatbotUrls();
    
    // Group by platform
    const byPlatform: Record<string, number> = {};
    for (const d of detected) {
      byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
    }
    
    res.json({
      totalDetected: detected.length,
      byPlatform,
      urls: detected.slice(0, 50), // Return first 50 for preview
    });
  } catch (error: any) {
    console.error('[ATIS] Chatbot scan error:', error);
    sendAtisFailure(res, 'scan chatbot messages');
  }
});

/**
 * POST /api/atis/chatbot/process
 * Process detected chatbot URLs and extract conversations
 */
router.post('/chatbot/process', async (req: Request, res: Response) => {
  try {
    const { limit } = parseLimitOffset({ limit: req.body?.limit }, { defaultLimit: 20, maxLimit: 100 });
    const extractor = createChatbotExtractor();
    const result = await extractor.processDetectedUrls(limit);
    res.json(result);
  } catch (error: any) {
    console.error('[ATIS] Chatbot process error:', error);
    sendAtisFailure(res, 'process chatbot messages');
  }
});

/**
 * GET /api/atis/chatbot/card/:cardId
 * Get chatbot conversations for a specific card
 */
router.get('/chatbot/card/:cardId', async (req: Request, res: Response) => {
  try {
    const cardId = parseInt(req.params.cardId);
    const extractor = createChatbotExtractor();
    const conversations = await extractor.getCardConversations(cardId);
    res.json({ cardId, conversationCount: conversations.length, conversations });
  } catch (error: any) {
    console.error('[ATIS] Card chatbot error:', error);
    sendAtisFailure(res, 'load card chatbot messages');
  }
});

/**
 * POST /api/atis/chatbot/extract-url
 * Extract conversation from a single chatbot URL
 */
router.post('/chatbot/extract-url', async (req: Request, res: Response) => {
  try {
    const { url, cardId } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const extractor = createChatbotExtractor();
    const detected = extractor.detectUrls(url);
    
    if (detected.length === 0) {
      return res.status(400).json({ error: 'No valid chatbot URL detected' });
    }
    
    const { url: detectedUrl, platform } = detected[0];
    const result = await extractor.extractConversation(detectedUrl, platform);
    
    if (result.success && result.conversation && cardId) {
      await extractor.storeConversation(cardId, result.conversation, detectedUrl);
    }
    
    res.json(result);
  } catch (error: any) {
    console.error('[ATIS] URL extraction error:', error);
    sendAtisFailure(res, 'extract URLs');
  }
});

/**
 * POST /api/atis/understanding/reanalyze-all
 * Re-analyze cards with the updated AI prompt (comprehensive checklists)
 * Supports filtering by board, specific cards, or all cards
 */
router.post('/understanding/reanalyze-all', analysisConfirmLimit, analysisStart('reanalyze'));

export default router;
