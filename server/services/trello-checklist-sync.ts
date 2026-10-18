/**
 * Trello Checklist Sync Service
 * 
 * Syncs AI-generated APTLSS checklists to Trello cards
 * Supports bi-directional completion sync
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { fetchWithRetry } from '../utils/retry';

const TRELLO_API_BASE = 'https://api.trello.com/1';

interface TrelloCredentials {
  apiKey: string;
  token: string;
}

interface ChecklistItem {
  step: string;
  timeMinutes: number;
  aptlssType: 'A' | 'P' | 'T' | 'L' | 'S';
}

interface SyncResult {
  success: boolean;
  checklistId?: string;
  checklistName?: string;
  itemsCreated?: number;
  error?: string;
}

interface ExistingChecklist {
  id: string;
  name: string;
  checkItems: Array<{
    id: string;
    name: string;
    state: 'complete' | 'incomplete';
  }>;
}

export class TrelloChecklistSyncService {
  private credentials: TrelloCredentials;

  constructor(credentials: TrelloCredentials) {
    this.credentials = credentials;
  }

  /**
   * Build Trello API URL with authentication
   */
  private buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${TRELLO_API_BASE}${endpoint}`);
    url.searchParams.set('key', this.credentials.apiKey);
    url.searchParams.set('token', this.credentials.token);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  }

  /**
   * Get existing checklists on a card
   */
  async getCardChecklists(cardId: string): Promise<ExistingChecklist[]> {
    const url = this.buildUrl(`/cards/${cardId}/checklists`);
    const response = await fetchWithRetry(url);
    
    if (!response.ok) {
      throw new Error(`Failed to get checklists: ${response.statusText}`);
    }
    
    return response.json();
  }

  /**
   * Create a new checklist on a card
   */
  async createChecklist(cardId: string, name: string): Promise<{ id: string; name: string }> {
    const url = this.buildUrl(`/cards/${cardId}/checklists`);
    
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create checklist: ${response.statusText}`);
    }
    
    return response.json();
  }

  /**
   * Add an item to a checklist
   */
  async addChecklistItem(checklistId: string, name: string, position: 'top' | 'bottom' = 'bottom'): Promise<{ id: string; name: string }> {
    const url = this.buildUrl(`/checklists/${checklistId}/checkItems`);
    
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pos: position }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to add checklist item: ${response.statusText}`);
    }
    
    return response.json();
  }

  /**
   * Update checklist item state
   */
  async updateChecklistItemState(cardId: string, checkItemId: string, state: 'complete' | 'incomplete'): Promise<void> {
    const url = this.buildUrl(`/cards/${cardId}/checkItem/${checkItemId}`, { state });
    
    const response = await fetchWithRetry(url, {
      method: 'PUT',
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update checklist item: ${response.statusText}`);
    }
  }

  /**
   * Delete a checklist
   */
  async deleteChecklist(checklistId: string): Promise<void> {
    const url = this.buildUrl(`/checklists/${checklistId}`);
    
    const response = await fetchWithRetry(url, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete checklist: ${response.statusText}`);
    }
  }

  /**
   * Format APTLSS checklist item for Trello
   */
  private formatChecklistItem(item: ChecklistItem, index: number): string {
    const typeLabels: Record<string, string> = {
      A: '🎯 Action',
      P: '📋 Process',
      T: '✅ Task',
      L: '📚 Learn',
      S: '🤝 Support',
    };
    
    const typeLabel = typeLabels[item.aptlssType] || item.aptlssType;
    const timeStr = item.timeMinutes >= 60 
      ? `${Math.floor(item.timeMinutes / 60)}h ${item.timeMinutes % 60}m`
      : `${item.timeMinutes}m`;
    
    return `[${typeLabel}] ${item.step} (${timeStr})`;
  }

  /**
   * Sync APTLSS checklist to a Trello card
   * 
   * @param cardId - Trello card ID
   * @param items - APTLSS checklist items
   * @param options - Sync options
   */
  async syncChecklistToCard(
    cardId: string,
    items: ChecklistItem[],
    options: {
      checklistName?: string;
      replaceExisting?: boolean;
      preserveCompleted?: boolean;
    } = {}
  ): Promise<SyncResult> {
    const {
      checklistName = '✨ APTLSS Checklist (AI-Generated)',
      replaceExisting = false,
      preserveCompleted = true,
    } = options;

    try {
      // Get existing checklists
      const existingChecklists = await this.getCardChecklists(cardId);
      const existingAptlss = existingChecklists.find(c => c.name.includes('APTLSS'));

      let checklistId: string;
      let completedItems: Set<string> = new Set();

      if (existingAptlss) {
        if (replaceExisting) {
          // Save completed items if preserving
          if (preserveCompleted) {
            existingAptlss.checkItems
              .filter(item => item.state === 'complete')
              .forEach(item => completedItems.add(item.name));
          }
          
          // Delete existing checklist
          await this.deleteChecklist(existingAptlss.id);
        } else {
          // Return existing checklist info
          return {
            success: true,
            checklistId: existingAptlss.id,
            checklistName: existingAptlss.name,
            itemsCreated: 0,
            error: 'APTLSS checklist already exists. Use replaceExisting=true to update.',
          };
        }
      }

      // Create new checklist
      const newChecklist = await this.createChecklist(cardId, checklistName);
      checklistId = newChecklist.id;

      // Add items
      let itemsCreated = 0;
      for (let i = 0; i < items.length; i++) {
        const itemName = this.formatChecklistItem(items[i], i);
        const newItem = await this.addChecklistItem(checklistId, itemName);
        itemsCreated++;

        // Restore completed state if preserving
        if (preserveCompleted && completedItems.has(itemName)) {
          await this.updateChecklistItemState(cardId, newItem.id, 'complete');
        }
      }

      // Record sync in database
      await this.recordSync(cardId, checklistId, itemsCreated);

      return {
        success: true,
        checklistId,
        checklistName,
        itemsCreated,
      };
    } catch (error: any) {
      console.error('[TrelloChecklistSync] Error syncing checklist:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Record sync operation in database
   */
  private async recordSync(cardId: string, checklistId: string, itemCount: number): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;

      await db.execute(sql`
        INSERT INTO atis_checklist_sync (trello_card_id, trello_checklist_id, items_synced, synced_at)
        VALUES (${cardId}, ${checklistId}, ${itemCount}, NOW())
        ON CONFLICT (trello_card_id) DO UPDATE SET
          trello_checklist_id = EXCLUDED.trello_checklist_id,
          items_synced = EXCLUDED.items_synced,
          synced_at = EXCLUDED.synced_at
      `);
    } catch (error) {
      console.error('[TrelloChecklistSync] Failed to record sync:', error);
    }
  }

  /**
   * Get sync status for a card
   */
  async getSyncStatus(cardId: string): Promise<{ synced: boolean; syncedAt?: Date; itemCount?: number }> {
    try {
      const db = await getDb();
      if (!db) return { synced: false };

      const result = await db.execute(sql`
        SELECT trello_checklist_id, items_synced, synced_at
        FROM atis_checklist_sync
        WHERE trello_card_id = ${cardId}
      `);

      const rows = result.rows as Array<{
        trello_checklist_id: string;
        items_synced: number;
        synced_at: Date | null;
      }>;
      if (rows.length === 0) {
        return { synced: false };
      }

      return {
        synced: true,
        syncedAt: rows[0].synced_at ?? undefined,
        itemCount: rows[0].items_synced,
      };
    } catch (error) {
      console.error('[TrelloChecklistSync] Failed to get sync status:', error);
      return { synced: false };
    }
  }

  /**
   * Bulk sync checklists for multiple cards
   */
  async bulkSync(
    cards: Array<{ cardId: string; trelloId: string; checklist: ChecklistItem[] }>,
    options: { replaceExisting?: boolean; preserveCompleted?: boolean } = {}
  ): Promise<{ total: number; success: number; failed: number; results: SyncResult[] }> {
    const results: SyncResult[] = [];
    let success = 0;
    let failed = 0;

    for (const card of cards) {
      if (!card.checklist || card.checklist.length === 0) {
        continue;
      }

      const result = await this.syncChecklistToCard(card.trelloId, card.checklist, {
        ...options,
        checklistName: '✨ APTLSS Checklist (AI-Generated)',
      });

      results.push({ ...result, checklistId: card.cardId });

      if (result.success) {
        success++;
      } else {
        failed++;
      }

      // Rate limiting - wait 200ms between API calls
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
      total: cards.length,
      success,
      failed,
      results,
    };
  }
}

/**
 * Create a sync service instance
 */
export function createChecklistSyncService(): TrelloChecklistSyncService {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!apiKey || !token) {
    throw new Error('TRELLO_API_KEY and TRELLO_TOKEN must be set in environment');
  }

  return new TrelloChecklistSyncService({ apiKey, token });
}
