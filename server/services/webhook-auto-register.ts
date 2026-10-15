/**
 * Automatic Webhook Registration Service
 * 
 * Automatically registers Trello webhooks for all boards in ATIS
 * and keeps them in sync as boards are added/removed.
 */

import { getDb } from '../db';
import { eq } from 'drizzle-orm';
import { atisBoards, chatbotWebhooks } from '../../drizzle/schema.postgres';

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

// Store the callback URL - will be set on server startup
let callbackUrl: string | null = null;

/**
 * Set the callback URL for webhooks (called on server startup)
 */
export function setWebhookCallbackUrl(url: string): void {
  callbackUrl = url;
  console.log(`[WebhookAutoRegister] Callback URL set to: ${url}`);
}

/**
 * Get the callback URL
 */
export function getWebhookCallbackUrl(): string | null {
  return callbackUrl;
}

/**
 * Register a webhook with Trello
 */
async function registerTrelloWebhook(
  modelId: string, 
  description: string
): Promise<{ id: string; active: boolean } | null> {
  if (!callbackUrl) {
    console.error('[WebhookAutoRegister] Callback URL not set');
    return null;
  }

  try {
    const response = await fetch(
      `https://api.trello.com/1/webhooks?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idModel: modelId,
          callbackURL: callbackUrl,
          description: description,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      // Check if webhook already exists
      if (errorText.includes('A webhook with that callback, model, and token already exists')) {
        console.log(`[WebhookAutoRegister] Webhook already exists for ${modelId}`);
        // Try to find existing webhook
        const existingWebhook = await findExistingWebhook(modelId);
        return existingWebhook;
      }
      console.error(`[WebhookAutoRegister] Failed to register webhook for ${modelId}:`, errorText);
      return null;
    }

    const webhook = await response.json();
    console.log(`[WebhookAutoRegister] Registered webhook ${webhook.id} for ${modelId}`);
    return { id: webhook.id, active: webhook.active };
  } catch (error) {
    console.error(`[WebhookAutoRegister] Error registering webhook for ${modelId}:`, error);
    return null;
  }
}

/**
 * Find an existing webhook for a model
 */
async function findExistingWebhook(modelId: string): Promise<{ id: string; active: boolean } | null> {
  try {
    const response = await fetch(
      `https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_API_KEY}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      return null;
    }

    const webhooks = await response.json();
    const existing = webhooks.find((w: any) => w.idModel === modelId);
    
    if (existing) {
      return { id: existing.id, active: existing.active };
    }
    return null;
  } catch (error) {
    console.error('[WebhookAutoRegister] Error finding existing webhook:', error);
    return null;
  }
}

/**
 * Delete a webhook from Trello
 */
async function deleteTrelloWebhook(webhookId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.trello.com/1/webhooks/${webhookId}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      { method: 'DELETE' }
    );
    return response.ok;
  } catch (error) {
    console.error(`[WebhookAutoRegister] Error deleting webhook ${webhookId}:`, error);
    return false;
  }
}

/**
 * Store webhook in database
 */
async function storeWebhook(
  trelloWebhookId: string,
  modelId: string,
  modelType: 'board' | 'workspace',
  description: string,
  isActive: boolean
): Promise<void> {
  const db = await getDb();
  if (!db || !callbackUrl) return;

  try {
    await db.insert(chatbotWebhooks).values({
      trelloWebhookId,
      modelId,
      modelType,
      description,
      callbackUrl,
      isActive: isActive ? 1 : 0,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: chatbotWebhooks.trelloWebhookId,
      set: {
        modelId,
        modelType,
        description,
        callbackUrl,
        isActive: isActive ? 1 : 0,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    console.error('[WebhookAutoRegister] Error storing webhook:', error);
  }
}

/**
 * Remove webhook from database
 */
async function removeWebhookFromDb(trelloWebhookId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    await db.delete(chatbotWebhooks).where(eq(chatbotWebhooks.trelloWebhookId, trelloWebhookId));
  } catch (error) {
    console.error('[WebhookAutoRegister] Error removing webhook from db:', error);
  }
}

/**
 * Get all registered webhooks from database
 */
async function getStoredWebhooks(): Promise<Array<{
  trelloWebhookId: string;
  modelId: string;
  modelType: string;
}>> {
  const db = await getDb();
  if (!db) return [];

  try {
    return await db.select({
      trelloWebhookId: chatbotWebhooks.trelloWebhookId,
      modelId: chatbotWebhooks.modelId,
      modelType: chatbotWebhooks.modelType,
    }).from(chatbotWebhooks);
  } catch (error) {
    console.error('[WebhookAutoRegister] Error getting stored webhooks:', error);
    return [];
  }
}

/**
 * Get all boards from ATIS
 */
async function getATISBoards(): Promise<Array<{
  trelloId: string;
  name: string;
}>> {
  const db = await getDb();
  if (!db) return [];

  try {
    const boards = await db
      .select({
        trelloId: atisBoards.trelloId,
        name: atisBoards.name,
      })
      .from(atisBoards);
    
    return boards;
  } catch (error) {
    console.error('[WebhookAutoRegister] Error getting ATIS boards:', error);
    return [];
  }
}

/**
 * Sync webhooks with ATIS boards
 * - Register webhooks for new boards
 * - Remove webhooks for deleted boards
 */
export async function syncWebhooks(): Promise<{
  registered: number;
  removed: number;
  errors: number;
}> {
  const results = {
    registered: 0,
    removed: 0,
    errors: 0,
  };

  if (!callbackUrl) {
    console.error('[WebhookAutoRegister] Cannot sync webhooks: callback URL not set');
    return results;
  }

  console.log('[WebhookAutoRegister] Starting webhook sync...');

  // Get all ATIS boards
  const boards = await getATISBoards();
  const boardIds = new Set(boards.map(b => b.trelloId));

  // Get all stored webhooks
  const storedWebhooks = await getStoredWebhooks();
  const webhookModelIds = new Set(storedWebhooks.map(w => w.modelId));

  // Register webhooks for new boards
  for (const board of boards) {
    if (!webhookModelIds.has(board.trelloId)) {
      console.log(`[WebhookAutoRegister] Registering webhook for board: ${board.name}`);
      const webhook = await registerTrelloWebhook(
        board.trelloId,
        `VA Dashboard Chatbot - ${board.name}`
      );

      if (webhook) {
        await storeWebhook(
          webhook.id,
          board.trelloId,
          'board',
          `VA Dashboard Chatbot - ${board.name}`,
          webhook.active
        );
        results.registered++;
      } else {
        results.errors++;
      }
    }
  }

  // Remove webhooks for deleted boards
  for (const webhook of storedWebhooks) {
    if (!boardIds.has(webhook.modelId)) {
      console.log(`[WebhookAutoRegister] Removing webhook for deleted board: ${webhook.modelId}`);
      const deleted = await deleteTrelloWebhook(webhook.trelloWebhookId);
      
      if (deleted) {
        await removeWebhookFromDb(webhook.trelloWebhookId);
        results.removed++;
      } else {
        results.errors++;
      }
    }
  }

  console.log(`[WebhookAutoRegister] Sync complete: ${results.registered} registered, ${results.removed} removed, ${results.errors} errors`);
  return results;
}

/**
 * Register webhook for a specific board (called when board is added to ATIS)
 */
export async function registerWebhookForBoard(
  boardTrelloId: string,
  boardName: string
): Promise<boolean> {
  if (!callbackUrl) {
    console.error('[WebhookAutoRegister] Cannot register webhook: callback URL not set');
    return false;
  }

  const webhook = await registerTrelloWebhook(
    boardTrelloId,
    `VA Dashboard Chatbot - ${boardName}`
  );

  if (webhook) {
    await storeWebhook(
      webhook.id,
      boardTrelloId,
      'board',
      `VA Dashboard Chatbot - ${boardName}`,
      webhook.active
    );
    return true;
  }

  return false;
}

/**
 * Remove webhook for a specific board (called when board is removed from ATIS)
 */
export async function removeWebhookForBoard(boardTrelloId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    const rows = await db.select({ trelloWebhookId: chatbotWebhooks.trelloWebhookId })
      .from(chatbotWebhooks)
      .where(eq(chatbotWebhooks.modelId, boardTrelloId))
      .limit(1);
    
    if (rows.length > 0) {
      const webhookId = rows[0].trelloWebhookId;
      const deleted = await deleteTrelloWebhook(webhookId);
      
      if (deleted) {
        await removeWebhookFromDb(webhookId);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('[WebhookAutoRegister] Error removing webhook for board:', error);
    return false;
  }
}

/**
 * Initialize webhook auto-registration on server startup
 */
export async function initializeWebhookAutoRegister(serverUrl: string): Promise<void> {
  // Set the callback URL
  setWebhookCallbackUrl(`${serverUrl}/api/trello-webhook`);
  
  // Skip webhook auto-registration in development mode to prevent memory leaks
  // from failed webhook registrations when localhost is not reachable from Trello
  if (process.env.NODE_ENV === 'development') {
    console.log('[WebhookAutoRegister] Skipping webhook auto-registration in development mode');
    return;
  }
  
  // Initial sync
  console.log('[WebhookAutoRegister] Initializing...');
  await syncWebhooks();
  
  // Set up periodic sync (every hour)
  setInterval(async () => {
    console.log('[WebhookAutoRegister] Running periodic sync...');
    await syncWebhooks();
  }, 60 * 60 * 1000); // 1 hour
}

export default {
  setWebhookCallbackUrl,
  getWebhookCallbackUrl,
  syncWebhooks,
  registerWebhookForBoard,
  removeWebhookForBoard,
  initializeWebhookAutoRegister,
};
