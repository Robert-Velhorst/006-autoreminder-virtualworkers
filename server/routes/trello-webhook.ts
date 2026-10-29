import { encodeTrelloPathSegment } from '../utils/trello-path';
import { Router, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db';
import { chatbotWebhooks, chatbotConversations, chatbotCheckinResponses } from '../../drizzle/schema.postgres';
import { desc, eq, gte, sql } from 'drizzle-orm';
import { getCardConversations, storeConversation } from '../services/chatbot-history';
import {
  isTrelloCommentAutomationEnabled,
  postTrelloComment,
  sendScheduledCheckin,
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE,
} from '../services/trello-chatbot';
import { requireAdmin, requireAuthenticated } from '../middleware/auth';
import { getWebhookCallbackUrl } from '../services/webhook-auto-register';
import { getAIConfig, testAIConnection } from '../services/ai-service';
import { parseLimitOffset } from '../utils/pagination';
import { rateLimit } from 'express-rate-limit';
import { getConfiguredTrelloWebhookCallbackUrl } from './trelloWebhookSignature';

const router = Router();

const registerWebhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many webhook registration attempts, please wait before retrying' },
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many webhook requests, please slow down' },
}));

const TRELLO_API_BASE = 'https://api.trello.com/1';
const TRELLO_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONVERSATION_COUNT_CARD_IDS = 200;

export function normalizeConversationCountCardIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CONVERSATION_COUNT_CARD_IDS) {
    throw new Error(`cardIds may contain at most ${MAX_CONVERSATION_COUNT_CARD_IDS} values`);
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 128))];
}

function callbackUrl() {
  return getConfiguredTrelloWebhookCallbackUrl();
}

export function verifyTrelloWebhook(input: {
  rawBody: Buffer;
  signature: string;
  callbackUrl: string;
  secret: string;
}) {
  const expected = createHmac('sha1', input.secret)
    .update(Buffer.concat([input.rawBody, Buffer.from(input.callbackUrl)]))
    .digest('base64');
  const actualBytes = Buffer.from(input.signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function unconfirmedTrelloSend(res: Response, item: 'comment' | 'check-in') {
  return res.status(409).json({
    success: false,
    deliveryStatus: 'unknown',
    retryAllowed: false,
    error: `Trello did not confirm whether the ${item} was posted; it may already be on the card.`,
    nextStep: 'Open the Trello card and verify whether the comment is already there. Do not send it again until you have checked.',
  });
}

async function persistSendHistory(record: Parameters<typeof storeConversation>[0], item: 'comment' | 'check-in') {
  try {
    return (await storeConversation(record)) != null;
  } catch (error) {
    console.error(`[TrelloWebhook] ${item} was posted but its history could not be saved:`, error);
    return false;
  }
}

function sendConfirmedResponse(res: Response, historySaved: boolean, item: 'comment' | 'check-in') {
  if (!historySaved) {
    return res.status(200).json({
      success: true,
      posted: true,
      historySaved: false,
      retryAllowed: false,
      warning: `The ${item} was posted to Trello, but the dashboard could not save its history. Do not retry the send; check the Trello card. Dashboard history may be incomplete.`,
    });
  }

  return res.json({ success: true, posted: true, historySaved: true });
}

router.use((req: any, res: Response, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/') {
    return next();
  }
  if (req.method === 'POST' && req.path === '/') {
    return next();
  }
  return requireAuthenticated(req, res, next);
});

/**
 * Normalise a raw Trello API webhook object into the same shape as our DB row.
 * Fix #7: the /list endpoint was returning raw Trello objects (idModel, active)
 * when the Trello API succeeded, but DB rows (modelId, isActive) on fallback.
 * The frontend Webhook interface only matches the DB shape, so the Trello-API
 * path was silently broken. We now always return a consistent shape.
 */
function normaliseTrelloWebhook(raw: any) {
  return {
    // Use the Trello webhook ID as both id and trelloWebhookId so the
    // frontend delete handler (which uses trelloWebhookId) always works.
    id: raw.id,
    trelloWebhookId: raw.id,
    modelId: raw.idModel ?? raw.modelId,
    description: raw.description ?? null,
    isActive: raw.active !== undefined ? (raw.active ? 1 : 0) : raw.isActive,
    callbackUrl: raw.callbackURL ?? raw.callbackUrl ?? null,
    createdAt: raw.createdAt ?? null,
  };
}

/**
 * GET /api/trello-webhook
 * Health check / Trello validation endpoint — must NOT require auth so Trello
 * can reach it during webhook registration.
 */
router.get('/', (_req: any, res: Response) => {
  res.status(200).json({ status: 'ok', message: 'Webhook endpoint is ready' });
});

/**
 * POST /api/trello-webhook/register
 * Register a webhook for a Trello board/workspace.
 * Fix #3 (duplicate detection): checks DB before calling Trello.
 */
router.post('/register', requireAdmin, registerWebhookRateLimit, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { modelId, description: rawDescription } = req.body;

    if (!modelId) {
      return res.status(400).json({ error: 'Missing modelId' });
    }

    if (typeof modelId !== 'string' || modelId.trim().length === 0) {
      return res.status(400).json({ error: 'Invalid modelId. Must be a non-empty string.' });
    }

    const cleanModelId = modelId.trim();

    if (cleanModelId.length < 8 || cleanModelId.length > 32) {
      return res.status(400).json({
        error: 'Invalid modelId length. Trello board IDs are typically 24-32 characters.',
      });
    }

    if (!/^[a-zA-Z0-9]+$/.test(cleanModelId)) {
      return res.status(400).json({
        error: 'Invalid modelId format. Only alphanumeric characters allowed.',
      });
    }

    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    // Registration must use deployment configuration, never a client-supplied
    // host header. Trello signs future callbacks against this exact URL.
    const configuredCallbackUrl = callbackUrl();
    if (!configuredCallbackUrl) {
      return res.status(500).json({
        error: 'Set TRELLO_WEBHOOK_CALLBACK_URL to the exact public HTTPS callback and configure TRELLO_WEBHOOK_SECRET before registering Trello webhooks.',
      });
    }

    // Fix #3 — duplicate detection: check DB before calling Trello
    const db = await getDb();
    if (db) {
      const existing = await db.query.chatbotWebhooks.findFirst({
        where: eq(chatbotWebhooks.modelId, cleanModelId),
      });
      if (existing) {
        return res.status(409).json({
          error: 'A webhook for this board is already registered. Delete it first to re-register.',
        });
      }
    }

    console.log('[TrelloWebhook] Registering webhook for modelId:', cleanModelId);

    const description = rawDescription || `VA Dashboard Webhook for ${cleanModelId}`;

    const response = await fetch(`${TRELLO_API_BASE}/webhooks?key=${apiKey}&token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        idModel: cleanModelId,
        callbackURL: configuredCallbackUrl,
        description,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[TrelloWebhook] Trello API error:', error);

      let userMessage = 'Failed to register webhook with Trello';
      if (error.includes('invalid value for idModel')) {
        userMessage = `Board ID "${cleanModelId}" is invalid or not found. Verify the ID from your Trello board URL (trello.com/b/BOARD_ID/name) and that you have admin access.`;
      } else if (error.includes('invalid token') || error.includes('unauthorized')) {
        userMessage = 'Trello authentication failed. Check your TRELLO_API_KEY and TRELLO_TOKEN.';
      } else if (error.includes('already exists')) {
        userMessage = 'A webhook for this board already exists on Trello. Delete the existing webhook first.';
      } else if (error.includes('model not found')) {
        userMessage = `Board "${cleanModelId}" not found. Please verify the board ID is correct.`;
      }

      return res.status(response.status).json({ error: userMessage });
    }

    const webhookData = await response.json();

    if (db) {
      await db
        .insert(chatbotWebhooks)
        .values({
          trelloWebhookId: webhookData.id,
          modelId: cleanModelId,
          description,
          callbackUrl: configuredCallbackUrl,
          isActive: 1,
        })
        .catch((err: any) => console.error('[TrelloWebhook] DB insert error:', err));
    }

    console.log('[TrelloWebhook] Webhook registered successfully:', webhookData.id);
    res.json({ success: true, webhookId: webhookData.id });
  } catch (error: unknown) {
    console.error('[TrelloWebhook] Error registering webhook:', error);
    res.status(500).json({ error: 'Failed to register webhook with Trello' });
  }
});

/**
 * GET /api/trello-webhook/list
 * List all registered webhooks.
 *
 * Fix #7: always returns a consistent shape regardless of data source.
 * The Trello API and DB previously returned different field names
 * (idModel vs modelId, active vs isActive) which broke the frontend.
 * Now both paths are normalised through normaliseTrelloWebhook().
 */
router.get('/list', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    // Try Trello API first (source of truth for active state)
    if (apiKey && token) {
      try {
        const response = await fetch(
          `${TRELLO_API_BASE}/tokens/${encodeURIComponent(token)}/webhooks?key=${encodeURIComponent(apiKey)}`,
          { redirect: 'error', signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS) },
        );
        if (response.ok) {
          const raw = await response.json();
          // Filter to webhooks explicitly owned by this configured deployment.
          const configuredCallbackUrl = callbackUrl();
          const filtered = configuredCallbackUrl
            ? raw.filter((w: any) => (w.callbackURL ?? '') === configuredCallbackUrl)
            : [];
          const webhooks = filtered.map(normaliseTrelloWebhook);
          console.log('[TrelloWebhook] Fetched webhooks from Trello API');
          return res.json({ webhooks });
        }
      } catch (err: any) {
        console.error('[TrelloWebhook] Trello API error, falling back to DB:', err);
      }
    }

    // Fallback to database
    const db = await getDb();
    if (db) {
      const rows = await db.query.chatbotWebhooks.findMany();
      const webhooks = rows.map(normaliseTrelloWebhook);
      console.log('[TrelloWebhook] Fetched webhooks from database');
      return res.json({ webhooks });
    }

    res.json({ webhooks: [] });
  } catch (error: unknown) {
    console.error('[TrelloWebhook] Error listing webhooks:', error);
    res.status(500).json({ error: 'Failed to list Trello webhooks' });
  }
});

/**
 * DELETE /api/trello-webhook/:webhookId
 * Delete a webhook from both Trello and the local DB.
 */
router.delete('/:webhookId', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { webhookId } = req.params;
    const encodedWebhookId = encodeTrelloPathSegment(webhookId);
    if (!encodedWebhookId) {
      return res.status(400).json({ error: 'Invalid Trello webhook ID' });
    }
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (apiKey && token) {
      try {
        const response = await fetch(
          `${TRELLO_API_BASE}/webhooks/${encodedWebhookId}?key=${apiKey}&token=${token}`,
          { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS) }
        );
        if (response.ok) {
          console.log('[TrelloWebhook] Deleted webhook from Trello API');
        } else {
          console.error('[TrelloWebhook] Error deleting from Trello:', response.status);
        }
      } catch (err: any) {
        console.error('[TrelloWebhook] Error deleting from Trello:', err);
      }
    }

    const db = await getDb();
    if (db) {
      await db.delete(chatbotWebhooks).where(eq(chatbotWebhooks.trelloWebhookId, webhookId));
    }

    res.json({ success: true });
  } catch (error: unknown) {
    console.error('[TrelloWebhook] Error deleting webhook:', error);
    res.status(500).json({ error: 'Failed to delete Trello webhook' });
  }
});

/**
 * POST /api/trello-webhook
 * Webhook callback from Trello — no auth required (called by Trello's servers).
 *
 * Fix #8: was inserting into wrong/non-existent columns (trelloCardId,
 * trelloAction, conversationData). The actual schema columns are cardTrelloId,
 * boardTrelloId, command, and responseStatus (NOT NULL). Fixed to match schema.
 */
router.post('/', async (req: any, res: Response) => {
  try {
    const secret = process.env.TRELLO_WEBHOOK_SECRET?.trim() || process.env.TRELLO_POWERUP_SECRET?.trim();
    const registeredCallback = callbackUrl();
    const signature = typeof req.get('x-trello-webhook') === 'string' ? req.get('x-trello-webhook') : '';
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!secret || !registeredCallback) {
      return res.status(503).json({ error: 'Trello webhook verification is not configured' });
    }
    if (req.originalUrl !== new URL(registeredCallback).pathname || !rawBody || !signature || !verifyTrelloWebhook({ rawBody, signature, callbackUrl: registeredCallback, secret })) {
      return res.status(401).json({ error: 'Invalid Trello webhook signature' });
    }
    const payload = req.body;
    const action = payload?.action ?? payload;
    const actionData = action?.data && typeof action.data === 'object' ? action.data : {};
    const actionType: string = typeof action?.type === 'string' ? action.type : 'unknown';
    const actionId = typeof action?.id === 'string' && action.id.trim().length > 0
      ? action.id.trim()
      : null;
    if (!actionId) {
      return res.status(400).json({ error: 'Trello action ID is required' });
    }
    const boardTrelloId = actionData?.board?.id ?? payload?.model?.id ?? null;
    const registeredModelId = payload?.model?.id ?? actionData?.board?.id ?? null;
    const sourceDate = typeof action?.date === 'string' ? action.date : null;

    console.log('[TrelloWebhook] Received callback');

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Trello webhook storage is unavailable' });
    }
    const conversation = {
      cardTrelloId: actionData?.card?.id ?? 'unknown',
      cardName: actionData?.card?.name ?? null,
      boardTrelloId,
      command: actionType,
      commandArgs: JSON.stringify({
        ...actionData,
        _trelloWebhook: { actionId, sourceDate },
      }),
      authorTrelloId: action?.memberCreator?.id ?? null,
      authorName: action?.memberCreator?.fullName ?? null,
      responseStatus: 'pending' as const,
    };

    if (!registeredModelId) {
      return res.status(503).json({ error: 'Trello webhook replay protection is unavailable' });
    }

    const archiveResult = await db.transaction(async (tx: any): Promise<'inserted' | 'duplicate' | 'unregistered'> => {
        // All model registrations share this short-lived lock. A single Trello
        // action may be delivered through both board and workspace webhooks,
        // so locking only the incoming model row leaves a cross-model replay race.
        const replayLockResult = await tx.execute(sql`
          SELECT id FROM chatbot_webhooks
          ORDER BY id
          LIMIT 1
          FOR UPDATE
        `);
        const replayLockRows = replayLockResult.rows;
        if (!replayLockRows.length) {
          return 'unregistered';
        }

        // Keep the matching registration locked until commit as well, so a
        // concurrent removal cannot invalidate registration during archiving.
        const registeredWebhookResult = await tx.execute(sql`
          SELECT id FROM chatbot_webhooks
          WHERE "modelId" = ${registeredModelId}
          ORDER BY id
          LIMIT 1
          FOR UPDATE
        `);
        const registeredWebhookRows = registeredWebhookResult.rows;
        if (!registeredWebhookRows.length) {
          return 'unregistered';
        }

        const existingResult = await tx.execute(sql`
          SELECT id FROM chatbot_conversations
          WHERE CASE
            WHEN pg_input_is_valid("commandArgs", 'jsonb')
              THEN "commandArgs"::jsonb #>> '{_trelloWebhook,actionId}'
            ELSE NULL
          END = ${actionId}
          LIMIT 1
        `);
        const existingRows = existingResult.rows;
        if (existingRows.length) return 'duplicate';

        await tx.insert(chatbotConversations).values(conversation);
        return 'inserted';
    });

    if (archiveResult === 'unregistered') {
      return res.status(503).json({ error: 'Trello webhook replay protection is unavailable' });
    }
    return res.json(archiveResult === 'duplicate' ? { success: true, duplicate: true } : { success: true });
  } catch (error: unknown) {
    console.error('[TrelloWebhook] Error processing callback');
    res.status(500).json({ error: 'Trello webhook processing failed' });
  }
});

/**
 * GET /api/trello-webhook/status
 * Get webhook configuration status.
 *
 * Reachability is not probed server-side: the callback URL is configurable,
 * and making an outbound request here would create an SSRF primitive.
 */
router.get('/status', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const callbackUrl = getConfiguredTrelloWebhookCallbackUrl();
    const isConfigured = !!process.env.TRELLO_API_KEY && !!process.env.TRELLO_TOKEN &&
      !!callbackUrl && !!process.env.TRELLO_WEBHOOK_SECRET;

    const recommendation = isConfigured
      ? 'Webhook settings are present. Live delivery has not been tested; verify by sending a test event from Trello.'
      : 'Configure the Trello credentials, HTTPS callback URL, and webhook secret before enabling push updates.';
    const configuredCallbackUrl = callbackUrl;
    const isReachable = false; // A settings read does not establish live delivery acceptance.

    res.json({
      status: {
        callbackUrl: configuredCallbackUrl,
        publicUrl: configuredCallbackUrl,
        isConfigured,
        isReachable: null,
        recommendation,
      },
    });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error getting webhook status:', error);
    res.status(500).json({ error: 'Could not load Trello webhook status' });
  }
});

/**
 * POST /api/trello-webhook/conversation-counts
 * Get conversation counts for a batch of card IDs.
 * Returns { counts: { [cardId]: number } }
 */
router.post('/conversation-counts', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    let cardIds: string[];
    try {
      cardIds = normalizeConversationCountCardIds(req.body?.cardIds);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid cardIds' });
    }
    if (cardIds.length === 0) {
      return res.json({ counts: {} });
    }

    const db = await getDb();
    if (!db) {
      // Return zeros gracefully — no DB means no conversations yet
      const counts: Record<string, number> = {};
      cardIds.forEach((id: string) => { counts[id] = 0; });
      return res.json({ counts });
    }

    // Count conversations per card from chatbot_conversations table
    const { chatbotConversations } = await import('../../drizzle/schema.postgres');
    const { inArray, sql: drizzleSql } = await import('drizzle-orm');

    const rows = await db
      .select({
        cardTrelloId: chatbotConversations.cardTrelloId,
        count: drizzleSql<number>`count(*)`,
      })
      .from(chatbotConversations)
      .where(inArray(chatbotConversations.cardTrelloId, cardIds))
      .groupBy(chatbotConversations.cardTrelloId);

    const counts: Record<string, number> = {};
    cardIds.forEach((id: string) => { counts[id] = 0; });
    rows.forEach((row: any) => { counts[row.cardTrelloId] = Number(row.count); });

    res.json({ counts });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error getting conversation counts:', error);
    res.status(500).json({ error: 'Could not load conversation counts' });
  }
});

/**
 * GET /api/chatbot/analytics
 * Get chatbot analytics.
 */
router.get('/analytics', requireAdmin, async (req: any, res: Response) => {
  try {
    const days = Number(req.query.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 365' });
    }
    const db = await getDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const [summaryRows, commandRows, checkinRows] = await Promise.all([
      db.select({
        totalConversations: sql<number>`COUNT(${chatbotConversations.id})`,
        avgResponseTimeMs: sql<number>`COALESCE(AVG(${chatbotConversations.responseTimeMs}), 0)`,
        totalCheckins: sql<number>`SUM(CASE WHEN ${chatbotConversations.command} = 'checkin' THEN 1 ELSE 0 END)`,
        activeWorkers: sql<number>`COUNT(DISTINCT ${chatbotConversations.authorTrelloId})`,
        activeCards: sql<number>`COUNT(DISTINCT ${chatbotConversations.cardTrelloId})`,
      }).from(chatbotConversations).where(gte(chatbotConversations.createdAt, since)),
      db.select({
        command: chatbotConversations.command,
        count: sql<number>`COUNT(*)`,
      }).from(chatbotConversations)
        .where(gte(chatbotConversations.createdAt, since))
        .groupBy(chatbotConversations.command),
      db.select({
        totalResponses: sql<number>`COUNT(${chatbotCheckinResponses.id})`,
        avgCheckinResponseMinutes: sql<number>`COALESCE(AVG(${chatbotCheckinResponses.responseTimeMinutes}), 0)`,
      }).from(chatbotCheckinResponses).where(gte(chatbotCheckinResponses.createdAt, since)),
    ]);
    const summary = summaryRows[0];
    const checkins = checkinRows[0];
    const totalCheckins = Number(summary?.totalCheckins ?? 0);
    const totalResponses = Number(checkins?.totalResponses ?? 0);
    const totalCommands = Object.fromEntries(commandRows.map((row) => [row.command, Number(row.count)]));
    const topCommands = commandRows
      .map((row) => ({ command: row.command, count: Number(row.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return res.json({
      totalConversations: Number(summary?.totalConversations ?? 0),
      totalCommands,
      avgResponseTimeMs: Math.round(Number(summary?.avgResponseTimeMs ?? 0)),
      totalCheckins,
      totalResponses,
      overallResponseRate: totalCheckins === 0 ? 0 : totalResponses / totalCheckins,
      avgCheckinResponseMinutes: Math.round(Number(checkins?.avgCheckinResponseMinutes ?? 0)),
      activeWorkers: Number(summary?.activeWorkers ?? 0),
      activeCards: Number(summary?.activeCards ?? 0),
      topCommands,
      periodDays: days,
      source: 'chatbot_conversations+chatbot_checkin_responses',
    });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error getting chatbot analytics:', error);
    res.status(500).json({ error: 'Could not load chatbot analytics' });
  }
});
/**
 * GET /api/trello-webhook/ai-settings
 * Get the global AI provider settings
 */
router.get('/ai-settings', requireAdmin, async (req: any, res: Response) => {
  try {
    const status = await getAIConfig();
    res.json({
      success: true,
      config: status,
    });
  } catch (error: any) {
    console.error('[TrelloWebhook] Could not load AI subscription status');
    res.status(500).json({ error: 'Could not load Codex subscription status' });
  }
});

/**
 * POST /api/trello-webhook/ai-settings
 * Save the global AI provider settings
 */
router.post('/ai-settings', requireAdmin, async (req: any, res: Response) => {
  return res.status(410).json({
    error: 'AI uses the fixed Codex subscription policy. Authentication stays in the private host runner; dashboard configuration writes are disabled.',
  });
});

router.post('/test-ai', requireAdmin, async (_req: any, res: Response) => {
  try {
    const result = await testAIConnection();
    return res.status(result.success ? 200 : 503).json(result);
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: 'Could not test the Codex subscription connection',
    });
  }
});

/**
 * GET /api/trello-webhook/recent
 * Return recent stored bot conversations for the settings history panel.
 */
router.get('/recent', requireAdmin, async (req: any, res: Response) => {
  try {
    const days = Number(req.query.days ?? 7);
    const limit = Number(req.query.limit ?? 250);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 365' });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 250' });
    }

    const db = await getDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const conversations = await db.select()
      .from(chatbotConversations)
      .where(gte(chatbotConversations.receivedAt, since))
      .orderBy(desc(chatbotConversations.receivedAt))
      .limit(limit);

    return res.json({ conversations });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error loading recent conversations:', error);
    return res.status(500).json({ error: 'Could not load recent conversations' });
  }
});

/**
 * GET /api/trello-webhook/history/:cardId
 * Get conversation history for a specific card.
 */
router.get('/history/:cardId', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { cardId } = req.params;
    const { limit } = parseLimitOffset(req.query, { defaultLimit: 50, maxLimit: 100 });

    const rows = await getCardConversations(cardId, limit);
    const conversations = rows.map((r: any) => {
      // Determine frontend messageType
      let messageType: 'command' | 'response' | 'checkin' | 'reminder' = 'command';
      if (r.command === 'checkin') {
        messageType = 'checkin';
      } else if (r.command === 'remind' || r.command === 'reminder') {
        messageType = 'reminder';
      } else if (r.command === 'response') {
        messageType = 'response';
      }

      let commandText: string | null = null;
      let botResponseText: string | null = null;

      if (r.command === 'manual_message' || r.command === 'ask_founder') {
        commandText = r.responseText;
        botResponseText = null;
      } else {
        commandText = `@bot ${r.command}`;
        botResponseText = r.responseText;
        // If it's a response from the bot, set type to response
        messageType = 'response';
      }

      return {
        id: r.id,
        cardId: r.cardTrelloId,
        cardName: r.cardName,
        messageType,
        command: commandText,
        authorName: r.authorName || 'System',
        authorId: r.authorTrelloId || '',
        botResponse: botResponseText,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
      };
    });

    res.json({ conversations });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error fetching history:', error);
    res.status(500).json({ error: 'Could not load conversation history' });
  }
});

/**
 * POST /api/trello-webhook/send
 * Post a manual comment/message to a Trello card.
 */
router.post('/send', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { cardId, message } = req.body;
    if (!cardId || !message) {
      return res.status(400).json({ error: 'Missing cardId or message' });
    }

    if (!isTrelloCommentAutomationEnabled()) {
      return res.status(409).json({ error: TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE });
    }

    let posted: boolean;
    try {
      posted = await postTrelloComment(cardId, message);
    } catch (error) {
      console.error('[TrelloWebhook] Manual comment outcome is unconfirmed:', error);
      return unconfirmedTrelloSend(res, 'comment');
    }
    if (!posted) {
      return unconfirmedTrelloSend(res, 'comment');
    }

    // Save to chatbot_conversations history
    const historySaved = await persistSendHistory({
      cardTrelloId: cardId,
      command: 'manual_message',
      responseText: message,
      authorName: user.name || 'Admin/Founder',
      responseStatus: 'success',
      receivedAt: new Date(),
      respondedAt: new Date(),
    }, 'comment');

    return sendConfirmedResponse(res, historySaved, 'comment');
  } catch (error: any) {
    console.error('[TrelloWebhook] Error sending message:', error);
    return res.status(500).json({ error: 'Could not post the Trello message' });
  }
});

/**
 * POST /api/trello-webhook/checkin
 * Send a scheduled progress check-in request to a Trello card.
 */
router.post('/checkin', requireAdmin, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { cardId } = req.body;
    if (!cardId) {
      return res.status(400).json({ error: 'Missing cardId' });
    }

    if (!isTrelloCommentAutomationEnabled()) {
      return res.status(409).json({ error: TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE });
    }

    let success: boolean;
    try {
      success = await sendScheduledCheckin(cardId);
    } catch (error) {
      console.error('[TrelloWebhook] Check-in outcome is unconfirmed:', error);
      return unconfirmedTrelloSend(res, 'check-in');
    }
    if (!success) {
      return unconfirmedTrelloSend(res, 'check-in');
    }

    // Save to chatbot_conversations history
    const historySaved = await persistSendHistory({
      cardTrelloId: cardId,
      command: 'checkin',
      responseText: 'Check-in request sent',
      authorName: user.name || 'Admin/Founder',
      responseStatus: 'success',
      receivedAt: new Date(),
      respondedAt: new Date(),
    }, 'check-in');

    return sendConfirmedResponse(res, historySaved, 'check-in');
  } catch (error: any) {
    console.error('[TrelloWebhook] Error triggering checkin:', error);
    return res.status(500).json({ error: 'Could not send the Trello check-in' });
  }
});

export default router;
