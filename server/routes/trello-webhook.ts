import { Router, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { getDb } from '../db';
import { chatbotWebhooks, chatbotConversations, appSettings } from '../../drizzle/schema.postgres';
import { eq, inArray } from 'drizzle-orm';
import { getCardConversations, storeConversation } from '../services/chatbot-history';
import { postTrelloComment, sendScheduledCheckin } from '../services/trello-chatbot';
import { requireAdmin, requireAuthenticated } from '../middleware/auth';
import {
  getConfiguredTrelloWebhookCallbackUrl,
  isValidTrelloWebhookSignature,
} from './trelloWebhookSignature';

const router = Router();

router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many webhook requests, please slow down' },
}));

const TRELLO_API_BASE = 'https://api.trello.com/1';

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
router.post('/register', requireAdmin, async (req: any, res: Response) => {
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

    const callbackUrl = getConfiguredTrelloWebhookCallbackUrl();
    if (!callbackUrl || !process.env.TRELLO_WEBHOOK_SECRET) {
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
      body: JSON.stringify({
        idModel: cleanModelId,
        callbackURL: callbackUrl,
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
          callbackUrl,
          isActive: 1,
        })
        .catch((err: any) => console.error('[TrelloWebhook] DB insert error:', err));
    }

    console.log('[TrelloWebhook] Webhook registered successfully:', webhookData.id);
    res.json({ success: true, webhookId: webhookData.id });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error registering webhook:', error);
    res.status(500).json({ error: error.message });
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
router.get('/list', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    // Try Trello API first (source of truth for active state)
    if (apiKey && token) {
      try {
        const response = await fetch(
          `${TRELLO_API_BASE}/tokens/${token}/webhooks?key=${apiKey}`
        );
        if (response.ok) {
          const raw = await response.json();
          // Filter to only webhooks pointing at our callback URL so we don't
          // show unrelated webhooks registered under the same token.
          const ourBase = getConfiguredTrelloWebhookCallbackUrl();
          const filtered = ourBase
            ? raw.filter((w: any) => w.callbackURL === ourBase)
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
  } catch (error: any) {
    console.error('[TrelloWebhook] Error listing webhooks:', error);
    res.status(500).json({ error: error.message });
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
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (apiKey && token) {
      try {
        const response = await fetch(
          `${TRELLO_API_BASE}/webhooks/${webhookId}?key=${apiKey}&token=${token}`,
          { method: 'DELETE' }
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
  } catch (error: any) {
    console.error('[TrelloWebhook] Error deleting webhook:', error);
    res.status(500).json({ error: error.message });
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
    const callbackUrl = getConfiguredTrelloWebhookCallbackUrl();
    if (!callbackUrl || !process.env.TRELLO_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'Trello webhook verification is not configured' });
    }
    if (!isValidTrelloWebhookSignature({
      body: req.body,
      callbackUrl,
      requestPath: req.originalUrl,
      secret: process.env.TRELLO_WEBHOOK_SECRET,
      signature: req.get('x-trello-webhook'),
    })) {
      return res.status(401).json({ error: 'Invalid Trello webhook signature' });
    }

    const action = req.body;
    const actionType: string = action?.type ?? 'unknown';

    console.log('[TrelloWebhook] Received callback:', actionType);

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Webhook storage is unavailable' });
    }
    await db
      .insert(chatbotConversations)
      .values({
        cardTrelloId: action?.data?.card?.id ?? 'unknown',
        cardName: action?.data?.card?.name ?? null,
        boardTrelloId: action?.data?.board?.id ?? null,
        command: actionType,
        commandArgs: JSON.stringify(action?.data ?? {}),
        authorTrelloId: action?.memberCreator?.id ?? null,
        authorName: action?.memberCreator?.fullName ?? null,
        responseStatus: 'pending',
      });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error processing callback:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trello-webhook/status
 * Get webhook configuration status.
 *
 * Reachability is not probed server-side: the callback URL is configurable,
 * and making an outbound request here would create an SSRF primitive.
 */
router.get('/status', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const callbackUrl = getConfiguredTrelloWebhookCallbackUrl();
    const isConfigured = !!process.env.TRELLO_API_KEY && !!process.env.TRELLO_TOKEN &&
      !!callbackUrl && !!process.env.TRELLO_WEBHOOK_SECRET;

    const recommendation = isConfigured
      ? 'Webhook settings are present. Live delivery has not been tested; verify by sending a test event from Trello.'
      : 'Configure the Trello credentials, HTTPS callback URL, and webhook secret before enabling push updates.';

    res.json({
      status: {
        callbackUrl,
        publicUrl: callbackUrl,
        isConfigured,
        isReachable: null,
        recommendation,
      },
    });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error getting webhook status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/trello-webhook/conversation-counts
 * Get conversation counts for a batch of card IDs.
 * Returns { counts: { [cardId]: number } }
 */
router.post('/conversation-counts', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { cardIds } = req.body;
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
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
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chatbot/analytics
 * Get chatbot analytics.
 */
router.get('/analytics', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    res.json({
      totalConversations: 0,
      totalCommands: {},
      avgResponseTimeMs: 0,
      totalCheckins: 0,
      totalResponses: 0,
      overallResponseRate: 0,
      avgCheckinResponseMinutes: 0,
      activeWorkers: 0,
      activeCards: 0,
      topCommands: [],
    });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error getting chatbot analytics:', error);
    res.status(500).json({ error: error.message });
  }
});
/**
 * GET /api/trello-webhook/ai-settings
 * Get the global AI provider settings
 */
router.get('/ai-settings', requireAdmin, async (req: any, res: Response) => {
  try {
    const db = await getDb();
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const keys = ['ai_provider', 'ai_model', 'ai_groq_key', 'ai_together_key', 'ai_openrouter_key', 'ai_ollama_url'];
    const settings = await db.select().from(appSettings).where(inArray(appSettings.key, keys));
    
    const settingsMap = new Map(settings.map((s: any) => [s.key, s.value]));
    
    res.json({
      success: true,
      config: {
        provider: settingsMap.get('ai_provider') || 'groq',
        model: settingsMap.get('ai_model') || 'llama-3.3-70b-versatile',
        groqApiKey: settingsMap.has('ai_groq_key') ? '********' : null,
        togetherApiKey: settingsMap.has('ai_together_key') ? '********' : null,
        openrouterApiKey: settingsMap.has('ai_openrouter_key') ? '********' : null,
        ollamaUrl: settingsMap.get('ai_ollama_url') || 'http://localhost:11434',
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/trello-webhook/ai-settings
 * Save the global AI provider settings
 */
router.post('/ai-settings', requireAdmin, async (req: any, res: Response) => {
  try {
    const db = await getDb();
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const { provider, model, groqApiKey, togetherApiKey, openrouterApiKey, ollamaUrl } = req.body;
    
    const upsertSetting = async (key: string, value: string | undefined | null) => {
      if (value === undefined || value === '********') return; // skip unchanged masked keys
      if (value === null || value === '') {
        await db.delete(appSettings).where(eq(appSettings.key, key));
        return;
      }
      
      const existing = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
      if (existing.length > 0) {
        await db.update(appSettings).set({ value }).where(eq(appSettings.key, key));
      } else {
        await db.insert(appSettings).values({ key, value });
      }
    };

    await upsertSetting('ai_provider', provider);
    await upsertSetting('ai_model', model);
    await upsertSetting('ai_groq_key', groqApiKey);
    await upsertSetting('ai_together_key', togetherApiKey);
    await upsertSetting('ai_openrouter_key', openrouterApiKey);
    await upsertSetting('ai_ollama_url', ollamaUrl);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trello-webhook/history/:cardId
 * Get conversation history for a specific card.
 */
router.get('/history/:cardId', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { cardId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

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
    res.status(500).json({ error: error.message });
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

    const posted = await postTrelloComment(cardId, message);
    if (!posted) {
      return res.status(500).json({ error: 'Failed to post comment to Trello' });
    }

    // Save to chatbot_conversations history
    await storeConversation({
      cardTrelloId: cardId,
      command: 'manual_message',
      responseText: message,
      authorName: user.name || 'Admin/Founder',
      responseStatus: 'success',
      receivedAt: new Date(),
      respondedAt: new Date(),
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error sending message:', error);
    res.status(500).json({ error: error.message });
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

    const success = await sendScheduledCheckin(cardId);
    if (!success) {
      return res.status(500).json({ error: 'Failed to send checkin comment to Trello' });
    }

    // Save to chatbot_conversations history
    await storeConversation({
      cardTrelloId: cardId,
      command: 'checkin',
      responseText: 'Check-in request sent',
      authorName: user.name || 'Admin/Founder',
      responseStatus: 'success',
      receivedAt: new Date(),
      respondedAt: new Date(),
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[TrelloWebhook] Error triggering checkin:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
