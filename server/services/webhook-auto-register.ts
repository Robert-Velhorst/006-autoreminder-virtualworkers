/**
 * Automatic Webhook Registration Service
 * 
 * Automatically registers Trello webhooks for all boards in ATIS
 * and keeps them in sync as boards are added/removed.
 */

import { getDb } from '../db';
import { eq, sql, and, isNull } from 'drizzle-orm';
import { atisBoards, chatbotWebhooks } from '../../drizzle/schema.postgres';
import { ScheduledJobLeaseLostError, type ScheduledJobContext } from '../scheduledJobRuntime';

const TRELLO_REQUEST_TIMEOUT_MS = 15_000;

async function checkpoint(context?: ScheduledJobContext) {
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
  await context?.assertOwnership();
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
}

function requestSignal(context?: ScheduledJobContext) {
  const timeout = AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS);
  return context ? AbortSignal.any([context.signal, timeout]) : timeout;
}

async function rethrowLeaseLoss(error: unknown, context?: ScheduledJobContext) {
  if (error instanceof ScheduledJobLeaseLostError) throw error;
  await checkpoint(context);
}

// Store the callback URL - will be set on server startup
let callbackUrl: string | null = null;
let syncInterval: NodeJS.Timeout | null = null;

function trelloCredentials() {
  const key = process.env.TRELLO_API_KEY?.trim();
  const token = process.env.TRELLO_TOKEN?.trim();
  if (!key || !token) return null;
  return { key, token };
}

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
  description: string,
  context?: ScheduledJobContext
): Promise<{ id: string; active: boolean } | null> {
  if (!callbackUrl) {
    console.error('[WebhookAutoRegister] Callback URL not set');
    return null;
  }
  const credentials = trelloCredentials();
  if (!credentials) {
    console.error('[WebhookAutoRegister] Trello credentials are not configured');
    return null;
  }

  await checkpoint(context);
  try {
    const response = await fetch(
      `https://api.trello.com/1/webhooks?${new URLSearchParams({ key: credentials.key, token: credentials.token })}`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        signal: requestSignal(context),
        body: JSON.stringify({
          idModel: modelId,
          callbackURL: callbackUrl,
          description: description,
        }),
      }
    );

    await checkpoint(context);
    if (!response.ok) {
      const errorText = await response.text();
      await checkpoint(context);
      // Check if webhook already exists
      if (errorText.includes('A webhook with that callback, model, and token already exists')) {
        console.log(`[WebhookAutoRegister] Webhook already exists for ${modelId}`);
        // Try to find existing webhook
        const existingWebhook = await findExistingWebhook(modelId, context);
        return existingWebhook;
      }
      console.error(`[WebhookAutoRegister] Provider rejected webhook registration for ${modelId}`);
      return null;
    }

    const webhook = await response.json();
    await checkpoint(context);
    console.log(`[WebhookAutoRegister] Registered webhook ${webhook.id} for ${modelId}`);
    return { id: webhook.id, active: webhook.active };
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    console.error(`[WebhookAutoRegister] Webhook registration unavailable for ${modelId}`);
    return null;
  }
}

/**
 * Find an existing webhook for a model
 */
async function findExistingWebhook(modelId: string, context?: ScheduledJobContext): Promise<{ id: string; active: boolean } | null> {
  const credentials = trelloCredentials();
  if (!credentials) return null;
  await checkpoint(context);
  try {
    const response = await fetch(
      `https://api.trello.com/1/tokens/${encodeURIComponent(credentials.token)}/webhooks?${new URLSearchParams({ key: credentials.key })}`,
      {
        method: 'GET',
        redirect: 'error',
        signal: requestSignal(context),
      }
    );

    await checkpoint(context);
    if (!response.ok) {
      return null;
    }

    const webhooks = await response.json();
    await checkpoint(context);
    const existing = webhooks.find((w: any) => w.idModel === modelId);
    
    if (existing) {
      return { id: existing.id, active: existing.active };
    }
    return null;
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    console.error('[WebhookAutoRegister] Existing webhook lookup unavailable');
    return null;
  }
}

/**
 * Delete a webhook from Trello
 */
async function deleteTrelloWebhook(webhookId: string, context?: ScheduledJobContext): Promise<boolean> {
  const credentials = trelloCredentials();
  if (!credentials) return false;
  await checkpoint(context);
  try {
    const response = await fetch(
      `https://api.trello.com/1/webhooks/${encodeURIComponent(webhookId)}?${new URLSearchParams({ key: credentials.key, token: credentials.token })}`,
      {
        method: 'DELETE',
        redirect: 'error',
        signal: requestSignal(context),
      }
    );
    await checkpoint(context);
    return response.ok;
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    console.error(`[WebhookAutoRegister] Webhook deletion unavailable for ${webhookId}`);
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
  isActive: boolean,
  context?: ScheduledJobContext
): Promise<void> {
  const db = await getDb();
  await checkpoint(context);
  if (!db || !callbackUrl) throw new Error("Database or configured webhook callback unavailable");

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
    await checkpoint(context);
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    throw new Error('Webhook registry persistence failed after provider registration; reconcile before retrying');
  }
}

/**
 * Remove webhook from database
 */
async function removeWebhookFromDb(trelloWebhookId: string, context?: ScheduledJobContext): Promise<void> {
  const db = await getDb();
  await checkpoint(context);
  if (!db) throw new Error('Database unavailable for webhook registry persistence');

  try {
    await db.delete(chatbotWebhooks).where(eq(chatbotWebhooks.trelloWebhookId, trelloWebhookId));
    await checkpoint(context);
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    throw new Error('Webhook registry persistence failed after provider removal; reconcile before retrying');
  }
}

/**
 * Get all registered webhooks from database
 */
async function getStoredWebhooks(context?: ScheduledJobContext): Promise<Array<{
  trelloWebhookId: string;
  modelId: string;
  modelType: string;
}>> {
  const db = await getDb();
  await checkpoint(context);
  if (!db) throw new Error('Database unavailable for webhook registry inventory');

  try {
    const rows = await db.select({
      trelloWebhookId: chatbotWebhooks.trelloWebhookId,
      modelId: chatbotWebhooks.modelId,
      modelType: chatbotWebhooks.modelType,
    }).from(chatbotWebhooks);
    await checkpoint(context);
    return rows;
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    throw new Error('Webhook registry inventory unavailable; provider reconciliation stopped');
  }
}

/**
 * Get all boards from ATIS
 */
async function getATISBoards(context?: ScheduledJobContext): Promise<Array<{
  trelloId: string;
  name: string;
}>> {
  const db = await getDb();
  await checkpoint(context);
  if (!db) throw new Error('Database unavailable for board inventory');

  try {
    const boards = await db
      .select({
        trelloId: atisBoards.trelloId,
        name: atisBoards.name,
      })
      .from(atisBoards);
    await checkpoint(context);
    
    return boards;
  } catch (error) {
    await rethrowLeaseLoss(error, context);
    throw new Error('Board inventory unavailable; provider reconciliation stopped');
  }
}

/**
 * Sync webhooks with ATIS boards
 * - Register webhooks for new boards
 * - Remove webhooks for deleted boards
 */
export async function syncWebhooks(context?: ScheduledJobContext): Promise<{
  registered: number;
  removed: number;
  errors: number;
}> {
  await checkpoint(context);
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
  const boards = await getATISBoards(context);
  const boardIds = new Set(boards.map(b => b.trelloId));

  // Get all stored webhooks
  const storedWebhooks = await getStoredWebhooks(context);
  await checkpoint(context);
  const webhookModelIds = new Set(storedWebhooks.map(w => w.modelId));

  // Register webhooks for new boards
  for (const board of boards) {
    if (!webhookModelIds.has(board.trelloId)) {
      console.log(`[WebhookAutoRegister] Registering webhook for board: ${board.name}`);
      const webhook = await registerTrelloWebhook(
        board.trelloId,
        `VA Dashboard Chatbot - ${board.name}`,
        context
      );

      if (webhook) {
        await storeWebhook(
          webhook.id,
          board.trelloId,
          'board',
          `VA Dashboard Chatbot - ${board.name}`,
          webhook.active,
          context
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
      const deleted = await deleteTrelloWebhook(webhook.trelloWebhookId, context);
      
      if (deleted) {
        await removeWebhookFromDb(webhook.trelloWebhookId, context);
        results.removed++;
      } else {
        results.errors++;
      }
    }
  }

  await checkpoint(context);
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
export async function initializeWebhookAutoRegister(serverUrl: string, autoSync = false): Promise<void> {
  // Set the callback URL
  const exactCallback = serverUrl.endsWith('/api/trello-webhook')
    ? serverUrl
    : `${serverUrl.replace(/\/$/, '')}/api/trello-webhook`;
  setWebhookCallbackUrl(exactCallback);
  if (!autoSync) {
    console.log('[WebhookAutoRegister] Automatic external registration is disabled; use the explicit Settings action');
    return;
  }
  
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
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(async () => {
    console.log('[WebhookAutoRegister] Running periodic sync...');
    await syncWebhooks();
  }, 60 * 60 * 1000); // 1 hour
  syncInterval.unref();
}

export function stopWebhookAutoRegister(): void {
  if (!syncInterval) return;
  clearInterval(syncInterval);
  syncInterval = null;
}

export default {
  setWebhookCallbackUrl,
  getWebhookCallbackUrl,
  syncWebhooks,
  initializeWebhookAutoRegister,
  stopWebhookAutoRegister,
  registerWebhookForBoard,
  removeWebhookForBoard,
};
