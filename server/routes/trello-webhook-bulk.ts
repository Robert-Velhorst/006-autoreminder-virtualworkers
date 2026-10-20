import express, { Response } from 'express';
import { getDb } from '../db';
import { chatbotWebhooks } from '../../drizzle/schema.postgres';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAuthenticated } from '../middleware/auth';
import { getConfiguredTrelloWebhookCallbackUrl } from './trelloWebhookSignature';

const router = express.Router();
router.use(requireAuthenticated);

const TRELLO_API_BASE = 'https://api.trello.com/1';
const TRELLO_REQUEST_TIMEOUT_MS = 15_000;

interface BulkRegistrationRequest {
  boardIds: string[];
  descriptions?: Record<string, string>;
}

interface BulkRegistrationResult {
  boardId: string;
  success: boolean;
  webhookId?: string;
  error?: string;
}

interface BulkRegistrationResponse {
  success: boolean;
  results: BulkRegistrationResult[];
  summary: {
    total: number;
    successful: number;
    failed: number;
  };
}

export function trelloWebhookRegistrationError(status: number, responseText: string) {
  const normalized = responseText.toLowerCase();
  if (status === 401 || normalized.includes('invalid token')) {
    return 'Authentication failed — check your Trello credentials';
  }
  if (status === 404 || normalized.includes('model not found')) {
    return 'Board not found or you do not have permission';
  }
  if (normalized.includes('invalid value for idmodel')) {
    return 'Board ID is invalid';
  }
  return `Trello rejected the webhook registration (${status})`;
}

/**
 * POST /api/trello-webhook/bulk
 * Register webhooks for multiple Trello boards in a single request.
 *
 * Fix #1: Auth check added — matches every other route in the app.
 * Fix #2: Results are persisted to chatbot_webhooks DB table.
 * Fix #4: callbackUrl is constructed server-side, not accepted from client.
 * Fix #5: Concurrency-limited to 10 parallel requests to avoid Trello rate limits.
 */
router.post('/', requireAdmin, async (req: any, res: Response) => {
  try {
    const { boardIds, descriptions } = req.body as BulkRegistrationRequest;

    // Validate input
    if (!Array.isArray(boardIds) || boardIds.length === 0) {
      return res.status(400).json({ error: 'boardIds must be a non-empty array' });
    }

    if (boardIds.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 boards can be registered at once' });
    }

    // Fix #4 — build callbackUrl on the server
    const callbackUrl = getConfiguredTrelloWebhookCallbackUrl();
    if (!callbackUrl || !process.env.TRELLO_WEBHOOK_SECRET) {
      return res.status(500).json({
        error: 'Set TRELLO_WEBHOOK_CALLBACK_URL and TRELLO_WEBHOOK_SECRET before registering Trello webhooks.',
      });
    }

    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      return res.status(500).json({ error: 'Trello API credentials not configured' });
    }

    // Fix #3 — check for already-registered boards before hitting Trello
    const db = await getDb();
    const existingModelIds = new Set<string>();
    if (db) {
      const existing = await db.query.chatbotWebhooks.findMany();
      existing.forEach((w: any) => existingModelIds.add(w.modelId));
    }

    // Fix #5 — concurrency-limited registration (10 at a time)
    const registrationResults: BulkRegistrationResult[] = [];

    const CONCURRENCY = 10;
    for (let i = 0; i < boardIds.length; i += CONCURRENCY) {
      const batch = boardIds.slice(i, i + CONCURRENCY);
      const batchPromises = batch.map(boardId => {
        // Fix #3 — skip boards that are already registered
        if (existingModelIds.has(boardId)) {
          return Promise.resolve<BulkRegistrationResult>({
            boardId,
            success: true,
            webhookId: 'already-registered',
            error: undefined,
          });
        }
        return registerWebhookForBoard(
          boardId,
          descriptions?.[boardId] || 'VA Dashboard Chatbot',
          callbackUrl,
          apiKey,
          token
        );
      });

      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          registrationResults.push(result.value);
        } else {
          registrationResults.push({
            boardId: batch[idx],
            success: false,
            error: result.reason?.message || 'Unknown error',
          });
        }
      });
    }

    // Fix #2 — persist successful registrations to the database
    if (db) {
      const toInsert = registrationResults.filter(
        r => r.success && r.webhookId && r.webhookId !== 'already-registered'
      );
      for (const result of toInsert) {
        await db
          .insert(chatbotWebhooks)
          .values({
            trelloWebhookId: result.webhookId!,
            modelId: result.boardId,
            description: descriptions?.[result.boardId] || 'VA Dashboard Chatbot',
            callbackUrl,
            isActive: 1,
          })
          .catch((err: any) =>
            console.error(`[TrelloWebhookBulk] DB insert error for ${result.boardId}:`, err)
          );
      }
    }

    const successful = registrationResults.filter(r => r.success).length;
    const failed = registrationResults.filter(r => !r.success).length;

    const response: BulkRegistrationResponse = {
      success: failed === 0,
      results: registrationResults,
      summary: {
        total: boardIds.length,
        successful,
        failed,
      },
    };

    res.json(response);
  } catch (error) {
    console.error('[TrelloWebhookBulk] Error:', error);
    res.status(500).json({
      error: 'Failed to process bulk registration',
    });
  }
});

/**
 * Register a webhook for a single board with Trello.
 */
async function registerWebhookForBoard(
  boardId: string,
  description: string,
  callbackUrl: string,
  apiKey: string,
  token: string
): Promise<BulkRegistrationResult> {
  try {
    // Validate board ID format
    if (!boardId || boardId.length < 8 || boardId.length > 32) {
      throw new Error('Invalid board ID format');
    }
    if (!/^[a-zA-Z0-9]+$/.test(boardId)) {
      throw new Error('Board ID contains invalid characters');
    }

    const response = await fetch(`${TRELLO_API_BASE}/webhooks?key=${apiKey}&token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        callbackURL: callbackUrl,
        idModel: boardId,
        description,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}`;

      if (errorText.includes('already exists')) {
        // Treat "already exists" as a success — webhook is in place
        return { boardId, success: true, webhookId: 'pre-existing' };
      } else {
        errorMessage = trelloWebhookRegistrationError(response.status, errorText);
      }

      return { boardId, success: false, error: errorMessage };
    }

    const data = await response.json();
    if (!data?.id) {
      throw new Error('Invalid response from Trello API — missing webhook ID');
    }

    return { boardId, success: true, webhookId: data.id };
  } catch (error) {
    console.error('[TrelloWebhookBulk] Registration failed for %s:', boardId, error);
    return {
      boardId,
      success: false,
      error: 'Trello webhook registration failed',
    };
  }
}

export default router;
