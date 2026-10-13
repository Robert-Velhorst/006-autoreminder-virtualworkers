/**
 * Trello Checklist Sync Service
 * 
 * Syncs AI-generated APTLSS checklists to Trello cards
 * Supports bi-directional completion sync
 */

import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { taskAssignments } from '../../drizzle/schema';
import { managerPilotWorkerIds } from '../aptlssManagerPilot';
import { parseManagerAssignmentReference } from '../aptlssManagerAssignments';
import { fetchWithRetry } from '../utils/retry';
import { ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader } from '../scheduledJobRuntime';

export async function assertAptlssJobOwnership(context?: ScheduledJobContext, reader?: ScheduledJobOwnershipReader): Promise<void> {
  if (!context) return;
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
  await context.assertOwnership(reader);
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
}

const TRELLO_API_BASE = 'https://api.trello.com/1';

interface TrelloCredentials {
  apiKey: string;
  token: string;
}

export interface ChecklistItem {
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

interface ChecklistSyncOptions {
  checklistName?: string;
  replaceExisting?: boolean;
  preserveCompleted?: boolean;
  /** Monotonically increasing source-plan revision, persisted in the checklist name. */
  sourceRevision?: number;
}

interface SyncIntent {
  token: number;
  sourceRevision?: number;
  contentHash: string;
}

const localCardSyncTails = new Map<string, Promise<void>>();
const currentSyncIntents = new Map<string, SyncIntent>();
let nextSyncIntentToken = 0;
const CHECKLIST_SYNC_LOCK_TIMEOUT_SECONDS = 10;

const ACTIVE_ASSIGNMENT_STATUSES = ['assigned', 'in_progress', 'blocked'] as const;
const MAX_CARD_ASSIGNMENTS = 250;

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

function checklistContentHash(names: string[]): string {
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

function normalizedChecklistNames(checklist: ExistingChecklist): string[] {
  return (checklist.checkItems ?? []).map(item => item.name);
}

function checklistMatchesNames(checklist: ExistingChecklist, expectedNames: string[]): boolean {
  const actualNames = normalizedChecklistNames(checklist);
  return actualNames.length === expectedNames.length
    && actualNames.every((name, index) => name === expectedNames[index]);
}

function checklistIsOrderedPrefix(checklist: ExistingChecklist, expectedNames: string[]): boolean {
  const actualNames = normalizedChecklistNames(checklist);
  return actualNames.length <= expectedNames.length
    && actualNames.every((name, index) => name === expectedNames[index]);
}

function checklistRevision(name: string): number | undefined {
  const match = name.match(/ · v(\d+)$/);
  if (!match) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

function checklistBaseName(name: string): string {
  return name
    .replace(/ · v\d+$/, '')
    .replace(/ \[sync (?:u|v\d+)-[a-f0-9]{20}\]$/, '');
}

function isManagedChecklistName(name: string, baseName: string): boolean {
  if (name === baseName) return true;
  if (name.startsWith(`${baseName} · v`)) return checklistRevision(name) !== undefined;
  const stagePrefix = `${baseName} [sync `;
  return name.startsWith(stagePrefix)
    && /^\[sync (?:u|v\d+)-[a-f0-9]{20}\]$/.test(name.slice(baseName.length + 1));
}

function stagingChecklistName(baseName: string, contentHash: string, sourceRevision?: number): string {
  const version = sourceRevision === undefined ? 'u' : `v${sourceRevision}`;
  return `${baseName} [sync ${version}-${contentHash.slice(0, 20)}]`;
}

function checklistStageRevision(name: string): number | undefined {
  const match = name.match(/\[sync v(\d+)-[a-f0-9]{20}\]$/);
  if (!match) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

function sqlResultRows(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) return [];
  const rows = result[0];
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

function acquireSyncIntent(
  cardId: string,
  sourceRevision: number | undefined,
  contentHash: string,
): { intent?: SyncIntent; error?: string } {
  if (sourceRevision !== undefined && (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0)) {
    return { error: 'Checklist source revision must be a positive, safe integer.' };
  }

  const activeIntent = currentSyncIntents.get(cardId);
  if (activeIntent) {
    if (activeIntent.sourceRevision !== undefined && sourceRevision === undefined) {
      return { error: 'A source revision is required while a versioned checklist sync is in progress.' };
    }
    if (
      activeIntent.sourceRevision !== undefined
      && sourceRevision !== undefined
      && sourceRevision < activeIntent.sourceRevision
    ) {
      return { error: 'This checklist event is older than a newer sync already in progress.' };
    }
    if (
      activeIntent.sourceRevision !== undefined
      && sourceRevision === activeIntent.sourceRevision
      && contentHash !== activeIntent.contentHash
    ) {
      return { error: 'The same checklist source revision was received with different contents.' };
    }
  }

  const intent = { token: ++nextSyncIntentToken, sourceRevision, contentHash };
  currentSyncIntents.set(cardId, intent);
  return { intent };
}

async function withLocalCardSyncLock<T>(cardId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localCardSyncTails.get(cardId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  localCardSyncTails.set(cardId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (localCardSyncTails.get(cardId) === current) localCardSyncTails.delete(cardId);
  }
}

export type AptlssChecklistWriteAuthorization = {
  allowed: boolean;
  applyToTrello: boolean;
  reason?: string;
};

/**
 * Resolve checklist-write permission from the canonical worker assignment.
 * An unset pilot list preserves legacy behavior; a configured but invalid or
 * unverifiable list fails closed.
 */
export async function getAptlssChecklistWriteAuthorization(
  cardId?: string | null,
): Promise<AptlssChecklistWriteAuthorization> {
  const configuredPilotIds = process.env.APTLSS_MANAGER_PILOT_WORKER_IDS;
  const safeguardsConfigured = Boolean(configuredPilotIds?.trim())
    || process.env.APTLSS_MANAGER_SHADOW_ONLY === 'true';
  if (!safeguardsConfigured) return { allowed: true, applyToTrello: true };

  const pilotWorkerIds = managerPilotWorkerIds();
  if (pilotWorkerIds.length === 0) {
    return {
      allowed: false,
      applyToTrello: false,
      reason: 'APTLSS pilot safeguards are configured but the worker allowlist is invalid.',
    };
  }
  if (!cardId?.trim()) {
    return {
      allowed: false,
      applyToTrello: false,
      reason: 'Card ownership is unavailable while APTLSS pilot safeguards are configured.',
    };
  }

  try {
    const db = await getDb();
    if (!db) {
      return {
        allowed: false,
        applyToTrello: false,
        reason: 'Card ownership could not be verified while APTLSS pilot safeguards are configured.',
      };
    }

    const assignments = await db.select({
      taskId: taskAssignments.taskId,
      vaId: taskAssignments.vaId,
    }).from(taskAssignments).where(and(
      inArray(taskAssignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
      or(
        eq(taskAssignments.taskId, cardId),
        sql`LEFT(${taskAssignments.taskId}, ${cardId.length + 1}) = CONCAT(${cardId}, ':')`,
      ),
    )).limit(MAX_CARD_ASSIGNMENTS + 1);

    if (assignments.length > MAX_CARD_ASSIGNMENTS) {
      return {
        allowed: false,
        applyToTrello: false,
        reason: 'Card ownership has too many active assignment records to verify safely.',
      };
    }

    const owners = new Set<number>();
    for (const assignment of assignments) {
      const reference = parseManagerAssignmentReference(assignment.taskId);
      if (
        !reference
        || reference.cardId !== cardId
        || !Number.isSafeInteger(assignment.vaId)
        || assignment.vaId <= 0
      ) {
        return {
          allowed: false,
          applyToTrello: false,
          reason: 'Card ownership contains an invalid or ambiguous active assignment.',
        };
      }
      owners.add(assignment.vaId);
    }

    if ([...owners].some(ownerId => pilotWorkerIds.includes(ownerId))) {
      return {
        allowed: false,
        applyToTrello: false,
        reason: 'Trello checklist writes are disabled for cards assigned to an APTLSS pilot worker.',
      };
    }
    if (owners.size === 0) {
      return {
        allowed: false,
        applyToTrello: false,
        reason: 'Card ownership is missing; assign the card to one worker before checklist generation.',
      };
    }
    if (owners.size !== 1) {
      return {
        allowed: false,
        applyToTrello: false,
        reason: 'Card ownership is ambiguous; assign the card to one worker before checklist generation.',
      };
    }

    return { allowed: true, applyToTrello: true };
  } catch {
    return {
      allowed: false,
      applyToTrello: false,
      reason: 'Card ownership could not be verified while APTLSS pilot safeguards are configured.',
    };
  }
}

export class TrelloChecklistSyncService {
  private credentials: TrelloCredentials;

  constructor(credentials: TrelloCredentials, private readonly context?: ScheduledJobContext) {
    this.credentials = credentials;
  }

  private async assertChecklistWriteAllowed(cardId?: string | null) {
    const authorization = await getAptlssChecklistWriteAuthorization(cardId);
    if (!authorization.allowed) throw new Error(authorization.reason || 'Trello checklist write is not authorized.');
  }

  private checklistWriteSafeguardsEnabled(): boolean {
    return Boolean(process.env.APTLSS_MANAGER_PILOT_WORKER_IDS?.trim())
      || process.env.APTLSS_MANAGER_SHADOW_ONLY === 'true';
  }

  private async assertChecklistBelongsToCard(checklistId: string, cardId: string): Promise<void> {
    if (!this.checklistWriteSafeguardsEnabled()) return;
    const checklists = await this.getCardChecklists(cardId);
    if (!checklists.some(checklist => checklist.id === checklistId)) {
      throw new Error('The requested checklist does not belong to the authorized Trello card.');
    }
  }

  private assertCurrentIntent(cardId: string, intent: SyncIntent): void {
    if (currentSyncIntents.get(cardId)?.token !== intent.token) {
      throw new Error('This checklist sync was superseded by a newer request.');
    }
  }

  private async withCardSyncLock<T>(cardId: string, operation: () => Promise<T>): Promise<T> {
    const db = await getDb();
    if (!db || typeof db.transaction !== 'function') {
      return withLocalCardSyncLock(cardId, operation);
    }

    const lockName = `aptlss-checklist-${createHash('sha256').update(cardId).digest('hex').slice(0, 40)}`;
    return db.transaction(async tx => {
      const acquired = sqlResultRows(await tx.execute(sql`
        SELECT GET_LOCK(${lockName}, ${CHECKLIST_SYNC_LOCK_TIMEOUT_SECONDS}) AS acquired
      `));
      if (Number(acquired[0]?.acquired) !== 1) {
        throw new Error('Another checklist sync is in progress for this card. Retry shortly.');
      }

      try {
        return await operation();
      } finally {
        const released = sqlResultRows(await tx.execute(sql`SELECT RELEASE_LOCK(${lockName}) AS released`));
        if (Number(released[0]?.released) !== 1) {
          throw new Error('The checklist sync lock could not be released cleanly.');
        }
      }
    });
  }

  private async renameChecklist(checklistId: string, cardId: string, name: string): Promise<void> {
    await this.assertChecklistWriteAllowed(cardId);
    await this.assertChecklistBelongsToCard(checklistId, cardId);
    await assertAptlssJobOwnership(this.context);
    const response = await fetchWithRetry(this.buildUrl(`/checklists/${checklistId}`, { name }), {
      method: 'PUT',
      signal: this.writeSignal(),
    }, { maxRetries: 0 });
    if (!response.ok) throw new Error(`Failed to rename checklist: ${response.statusText}`);
  }

  private async deleteChecklistAfterVerification(
    checklist: ExistingChecklist,
    cardId: string,
    intent: SyncIntent,
  ): Promise<void> {
    this.assertCurrentIntent(cardId, intent);
    try {
      await this.deleteChecklistUnlocked(checklist.id, cardId);
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError) throw error;
      await assertAptlssJobOwnership(this.context);
      const current = await this.getCardChecklists(cardId);
      if (current.some(candidate => candidate.id === checklist.id)) throw error;
    }
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

  private writeSignal(): AbortSignal | undefined {
    return this.context ? AbortSignal.any([this.context.signal, AbortSignal.timeout(15_000)]) : undefined;
  }

  /**
   * Get existing checklists on a card
   */
  async getCardChecklists(cardId: string): Promise<ExistingChecklist[]> {
    await assertAptlssJobOwnership(this.context);
    const url = this.buildUrl(`/cards/${cardId}/checklists`);
    const response = this.context
      ? await fetchWithRetry(url, { signal: this.writeSignal() }, { maxRetries: 0 })
      : await fetchWithRetry(url);
    await assertAptlssJobOwnership(this.context);
    
    if (!response.ok) {
      throw new Error(`Failed to get checklists: ${response.statusText}`);
    }
    
    return response.json();
  }

  /**
   * Create a new checklist on a card
   */
  async createChecklist(cardId: string, name: string): Promise<{ id: string; name: string }> {
    return this.withCardSyncLock(cardId, () => this.createChecklistUnlocked(cardId, name));
  }

  private async createChecklistUnlocked(cardId: string, name: string): Promise<{ id: string; name: string }> {
    await this.assertChecklistWriteAllowed(cardId);
    const url = this.buildUrl(`/cards/${cardId}/checklists`);
    await assertAptlssJobOwnership(this.context);
    
    const response = await fetchWithRetry(url, {
      method: 'POST',
      signal: this.writeSignal(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }, { maxRetries: 0 });
    
    if (!response.ok) {
      throw new Error(`Failed to create checklist: ${response.statusText}`);
    }
    
    return response.json();
  }

  /**
   * Add an item to a checklist
   */
  async addChecklistItem(
    checklistId: string,
    name: string,
    position: 'top' | 'bottom' = 'bottom',
    cardId?: string,
  ): Promise<{ id: string; name: string }> {
    if (!cardId) return this.addChecklistItemUnlocked(checklistId, name, position, cardId);
    return this.withCardSyncLock(cardId, () => this.addChecklistItemUnlocked(checklistId, name, position, cardId));
  }

  private async addChecklistItemUnlocked(
    checklistId: string,
    name: string,
    position: 'top' | 'bottom',
    cardId?: string,
  ): Promise<{ id: string; name: string }> {
    await this.assertChecklistWriteAllowed(cardId);
    if (cardId) await this.assertChecklistBelongsToCard(checklistId, cardId);
    const url = this.buildUrl(`/checklists/${checklistId}/checkItems`);
    await assertAptlssJobOwnership(this.context);
    
    const response = await fetchWithRetry(url, {
      method: 'POST',
      signal: this.writeSignal(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pos: position }),
    }, { maxRetries: 0 });
    
    if (!response.ok) {
      throw new Error(`Failed to add checklist item: ${response.statusText}`);
    }
    
    return response.json();
  }

  /**
   * Update checklist item state
   */
  async updateChecklistItemState(cardId: string, checkItemId: string, state: 'complete' | 'incomplete'): Promise<void> {
    await this.assertChecklistWriteAllowed(cardId);
    let originalItemName: string | undefined;
    let originalChecklistBaseName: string | undefined;
    if (this.checklistWriteSafeguardsEnabled()) {
      const checklists = await this.getCardChecklists(cardId);
      const sourceChecklist = checklists.find(checklist =>
        (checklist.checkItems ?? []).some(item => item.id === checkItemId),
      );
      originalItemName = sourceChecklist?.checkItems.find(item => item.id === checkItemId)?.name;
      if (originalItemName === undefined) {
        throw new Error('The requested checklist item does not belong to the authorized Trello card.');
      }
      originalChecklistBaseName = checklistBaseName(sourceChecklist!.name);
    }

    await this.withCardSyncLock(cardId, async () => {
      await this.assertChecklistWriteAllowed(cardId);
      let targetItemId = checkItemId;
      if (this.checklistWriteSafeguardsEnabled()) {
        const checklists = await this.getCardChecklists(cardId);
        const itemStillExists = checklists.some(checklist =>
          (checklist.checkItems ?? []).some(item => item.id === checkItemId),
        );
        if (!itemStillExists) {
          const replacementItems = checklists
            .filter(checklist => isManagedChecklistName(checklist.name, originalChecklistBaseName!))
            .flatMap(checklist => checklist.checkItems ?? [])
            .filter(item => item.name === originalItemName);
          if (replacementItems.length !== 1) {
            throw new Error('The checklist item changed during synchronization. Refresh the card and retry.');
          }
          targetItemId = replacementItems[0].id;
        }
      }
      await this.updateChecklistItemStateUnlocked(cardId, targetItemId, state);
    });
  }

  private async updateChecklistItemStateUnlocked(
    cardId: string,
    checkItemId: string,
    state: 'complete' | 'incomplete',
  ): Promise<void> {
    await this.assertChecklistWriteAllowed(cardId);
    const url = this.buildUrl(`/cards/${cardId}/checkItem/${checkItemId}`, { state });
    await assertAptlssJobOwnership(this.context);
    
    const response = await fetchWithRetry(url, {
      method: 'PUT',
      signal: this.writeSignal(),
    }, { maxRetries: 0 });
    
    if (!response.ok) {
      throw new Error(`Failed to update checklist item: ${response.statusText}`);
    }
  }

  /**
   * Delete a checklist
   */
  async deleteChecklist(checklistId: string, cardId?: string): Promise<void> {
    if (!cardId) return this.deleteChecklistUnlocked(checklistId, cardId);
    return this.withCardSyncLock(cardId, () => this.deleteChecklistUnlocked(checklistId, cardId));
  }

  private async deleteChecklistUnlocked(checklistId: string, cardId?: string): Promise<void> {
    await this.assertChecklistWriteAllowed(cardId);
    if (cardId) await this.assertChecklistBelongsToCard(checklistId, cardId);
    const url = this.buildUrl(`/checklists/${checklistId}`);
    await assertAptlssJobOwnership(this.context);
    
    const response = await fetchWithRetry(url, {
      method: 'DELETE',
      signal: this.writeSignal(),
    }, { maxRetries: 0 });
    
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
    options: ChecklistSyncOptions = {}
  ): Promise<SyncResult> {
    await assertAptlssJobOwnership(this.context);
    const {
      checklistName = '✨ APTLSS Checklist (AI-Generated)',
      replaceExisting = false,
      preserveCompleted = true,
      sourceRevision,
    } = options;

    const expectedNames = uniqueNames(items.map((item, index) => this.formatChecklistItem(item, index)));
    const contentHash = checklistContentHash(expectedNames);
    const reservation = acquireSyncIntent(cardId, sourceRevision, contentHash);
    if (!reservation.intent) return { success: false, error: reservation.error };
    const intent = reservation.intent;

    try {
      await this.assertChecklistWriteAllowed(cardId);
      return await this.withCardSyncLock(cardId, async () => {
        this.assertCurrentIntent(cardId, intent);
        await this.assertChecklistWriteAllowed(cardId);
        let existingChecklists = await this.getCardChecklists(cardId);
        this.assertCurrentIntent(cardId, intent);
        let managedChecklists = existingChecklists.filter(checklist =>
          isManagedChecklistName(checklist.name, checklistName),
        );
        const targetName = sourceRevision === undefined ? checklistName : `${checklistName} · v${sourceRevision}`;
        const stageName = sourceRevision === undefined
          ? checklistName
          : stagingChecklistName(checklistName, contentHash, sourceRevision);
        const existingVersions = managedChecklists
          .map(checklist => checklistRevision(checklist.name) ?? checklistStageRevision(checklist.name))
          .filter((revision): revision is number => revision !== undefined);
        const highestExistingRevision = existingVersions.length ? Math.max(...existingVersions) : undefined;

        if (sourceRevision !== undefined && highestExistingRevision !== undefined && sourceRevision < highestExistingRevision) {
          throw new Error('This checklist event is older than the latest verified Trello checklist. No changes were made.');
        }

        const sameRevisionChecklists = sourceRevision === undefined
          ? []
          : managedChecklists.filter(checklist =>
            checklistRevision(checklist.name) === sourceRevision
            || checklistStageRevision(checklist.name) === sourceRevision,
          );
        if (sameRevisionChecklists.some(checklist => {
          const stage = checklist.name === stageName;
          return !stage && !checklistMatchesNames(checklist, expectedNames);
        })) {
          throw new Error('The same checklist source revision is already verified with different contents. No changes were made.');
        }
        if (sourceRevision !== undefined && managedChecklists.some(checklist =>
          checklistStageRevision(checklist.name) === sourceRevision && checklist.name !== stageName,
        )) {
          throw new Error('A different checklist payload is already staged for this source revision. No changes were made.');
        }

        if (sourceRevision !== undefined && managedChecklists.some(checklist =>
          checklist.name === stageName && !checklistIsOrderedPrefix(checklist, expectedNames),
        )) {
          throw new Error('A staged checklist no longer matches this plan. Verify or remove it manually before retrying.');
        }

        let candidate = managedChecklists.find(checklist => checklist.name === stageName
          && checklistIsOrderedPrefix(checklist, expectedNames));
        if (!candidate) {
          candidate = managedChecklists.find(checklist => checklist.name === targetName
            && checklistMatchesNames(checklist, expectedNames));
        }
        if (!candidate && sourceRevision === undefined) {
          candidate = managedChecklists.find(checklist => checklist.name === targetName
            && checklistIsOrderedPrefix(checklist, expectedNames));
        }
        if (!candidate) {
          candidate = managedChecklists.find(checklist => checklistMatchesNames(checklist, expectedNames));
        }

        if (managedChecklists.length > 0 && !candidate) {
          const unversionedLegacy = managedChecklists.some(checklist =>
            checklistRevision(checklist.name) === undefined
            && checklistStageRevision(checklist.name) === undefined,
          );
          if (sourceRevision === undefined) {
            throw new Error('The existing checklist differs from this plan. A source revision is required before changing it. No changes were made.');
          }
          if (unversionedLegacy) {
            throw new Error('The existing checklist has no source revision, so its age cannot be verified. No changes were made.');
          }
          if (!replaceExisting) {
            throw new Error('A newer checklist revision exists. Set replaceExisting only after providing a newer source revision. No changes were made.');
          }
        }

        if (candidate && sourceRevision !== undefined) {
          const candidateRevision = checklistRevision(candidate.name) ?? checklistStageRevision(candidate.name);
          if (candidateRevision !== undefined && candidateRevision < sourceRevision && !replaceExisting) {
            throw new Error('A newer checklist revision requires a verified replacement. No changes were made.');
          }
        }

        if (candidate && !candidate.name.startsWith(`${checklistName} [sync `)
          && !checklistMatchesNames(candidate, expectedNames)
          && !(sourceRevision === undefined && candidate.name === targetName
            && checklistIsOrderedPrefix(candidate, expectedNames))) {
          throw new Error('The existing checklist is not a resumable staged copy of this plan. No changes were made.');
        }

        if (candidate && !candidate.name.startsWith(`${checklistName} [sync `)
          && checklistMatchesNames(candidate, expectedNames)) {
          if (!replaceExisting && (sourceRevision === undefined || candidate.name === targetName)) {
            await this.recordSync(cardId, candidate.id, candidate.checkItems?.length ?? 0);
            return {
              success: true,
              checklistId: candidate.id,
              checklistName: candidate.name,
              itemsCreated: 0,
            };
          }
        }

        const completedNames = new Set(
          preserveCompleted
            ? managedChecklists.flatMap(checklist => (checklist.checkItems ?? [])
              .filter(item => item.state === 'complete')
              .map(item => item.name))
            : [],
        );
        let itemsCreated = 0;

        if (!candidate) {
          this.assertCurrentIntent(cardId, intent);
          try {
            const created = await this.createChecklistUnlocked(cardId, stageName);
            candidate = { ...created, checkItems: [] };
          } catch (error) {
            if (error instanceof ScheduledJobLeaseLostError) throw error;
            await assertAptlssJobOwnership(this.context);
            existingChecklists = await this.getCardChecklists(cardId);
            candidate = existingChecklists.find(checklist => checklist.name === stageName);
            if (!candidate) throw error;
          }
        }

        const candidateId = candidate.id;
        candidate.checkItems ??= [];
        const knownNames = new Set(normalizedChecklistNames(candidate));
        if (knownNames.size !== normalizedChecklistNames(candidate).length) {
          throw new Error('The staged checklist already contains duplicate item names. It was left unchanged for review.');
        }

        for (const itemName of expectedNames) {
          this.assertCurrentIntent(cardId, intent);
          let checklistItem = candidate.checkItems.find(item => item.name === itemName);
          if (!knownNames.has(itemName)) {
            try {
              const createdItem = await this.addChecklistItemUnlocked(candidateId, itemName, 'bottom', cardId);
              checklistItem = { ...createdItem, state: 'incomplete' };
              candidate.checkItems.push(checklistItem);
            } catch (error) {
              if (error instanceof ScheduledJobLeaseLostError) throw error;
              await assertAptlssJobOwnership(this.context);
              const refreshed = await this.getCardChecklists(cardId);
              const refreshedCandidate = refreshed.find(checklist => checklist.id === candidateId);
              checklistItem = refreshedCandidate?.checkItems.find(item => item.name === itemName);
              if (!checklistItem || !refreshedCandidate) throw error;
              candidate = refreshedCandidate;
            }

            knownNames.add(itemName);
            itemsCreated++;
          }

          if (preserveCompleted && completedNames.has(itemName)) {
            if (!checklistItem) {
              throw new Error('A checklist item could not be verified while preserving its completed state.');
            }
            if (checklistItem.state !== 'complete') {
              this.assertCurrentIntent(cardId, intent);
              await this.updateChecklistItemStateUnlocked(cardId, checklistItem.id, 'complete');
              checklistItem.state = 'complete';
            }
          }
        }

        this.assertCurrentIntent(cardId, intent);
        existingChecklists = await this.getCardChecklists(cardId);
        candidate = existingChecklists.find(checklist => checklist.id === candidateId);
        if (!candidate || !checklistMatchesNames(candidate, expectedNames)) {
          throw new Error('APTLSS checklist verification failed. The previous checklist was retained.');
        }

        if (candidate.name !== targetName) {
          this.assertCurrentIntent(cardId, intent);
          try {
            await this.renameChecklist(candidate.id, cardId, targetName);
            candidate.name = targetName;
          } catch (error) {
            if (error instanceof ScheduledJobLeaseLostError) throw error;
            await assertAptlssJobOwnership(this.context);
            const refreshed = await this.getCardChecklists(cardId);
            const renamed = refreshed.find(checklist => checklist.id === candidateId && checklist.name === targetName);
            if (!renamed) throw error;
            candidate = renamed;
          }
        }

        if (replaceExisting) {
          managedChecklists = existingChecklists.filter(checklist =>
            isManagedChecklistName(checklist.name, checklistName) && checklist.id !== candidateId,
          );
          if (sourceRevision === undefined && managedChecklists.some(checklist =>
            !checklistMatchesNames(checklist, expectedNames),
          )) {
            throw new Error('Other APTLSS checklists differ from this plan. A source revision is required before replacing them.');
          }
          for (const oldChecklist of managedChecklists) {
            await this.deleteChecklistAfterVerification(oldChecklist, cardId, intent);
          }
        }

        await this.recordSync(cardId, candidateId, candidate.checkItems?.length ?? expectedNames.length);
        return {
          success: true,
          checklistId: candidateId,
          checklistName: candidate.name,
          itemsCreated,
        };
      });
    } catch (error: any) {
      if (error instanceof ScheduledJobLeaseLostError) throw error;
      await assertAptlssJobOwnership(this.context);
      console.error('[TrelloChecklistSync] Error syncing checklist:', error);
      return { success: false, error: error?.message ?? 'Checklist synchronization failed.' };
    } finally {
      if (currentSyncIntents.get(cardId)?.token === intent.token) currentSyncIntents.delete(cardId);
    }
  }

  /**
   * Record sync operation in database
   */
  private async recordSync(cardId: string, checklistId: string, itemCount: number): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;

      await assertAptlssJobOwnership(this.context);
      await db.execute(sql`
        INSERT INTO atis_checklist_sync (trello_card_id, trello_checklist_id, items_synced, synced_at)
        VALUES (${cardId}, ${checklistId}, ${itemCount}, NOW())
        ON DUPLICATE KEY UPDATE
          trello_checklist_id = ${checklistId},
          items_synced = ${itemCount},
          synced_at = NOW()
      `);
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError) throw error;
      await assertAptlssJobOwnership(this.context);
      console.error('[TrelloChecklistSync] Failed to record sync:', error);
    }
  }

  /**
   * Get sync status for a card
   */
  async getSyncStatus(cardId: string): Promise<{
    synced: boolean;
    checklistId?: string;
    syncedAt?: Date;
    itemCount?: number;
  }> {
    try {
      const db = await getDb();
      if (!db) return { synced: false };

      const result = await db.execute(sql`
        SELECT trello_checklist_id, items_synced, synced_at
        FROM atis_checklist_sync
        WHERE trello_card_id = ${cardId}
      `);

      const rows = (result as any)[0] || [];
      if (rows.length === 0) {
        return { synced: false };
      }

      return {
        synced: true,
        checklistId: rows[0].trello_checklist_id,
        syncedAt: rows[0].synced_at,
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
export function createChecklistSyncService(context?: ScheduledJobContext): TrelloChecklistSyncService {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!apiKey || !token) {
    throw new Error('TRELLO_API_KEY and TRELLO_TOKEN must be set in environment');
  }

  return new TrelloChecklistSyncService({ apiKey, token }, context);
}
