import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { taskAssignments } from '../../../drizzle/schema.postgres';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  fetchWithRetry: vi.fn(),
}));

vi.mock('../../db', () => ({ getDb: mocks.getDb }));
vi.mock('../../utils/retry', () => ({ fetchWithRetry: mocks.fetchWithRetry }));

import { TrelloChecklistSyncService } from '../trello-checklist-sync';

beforeEach(() => {
  vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '');
  vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', '');
  mocks.getDb.mockReset().mockResolvedValue(null);
  mocks.fetchWithRetry.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

function createOwnershipDb(assignments: Array<{ taskId: string; vaId: number; status: string }>) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (count: number) => table === taskAssignments ? assignments.slice(0, count) : [],
        }),
      }),
    }),
    execute: vi.fn().mockResolvedValue([[]]),
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, statusText: 'OK', json: async () => body } as Response;
}

type RemoteChecklist = {
  id: string;
  name: string;
  checkItems: Array<{ id: string; name: string; state: 'complete' | 'incomplete' }>;
};

function installTrelloState(cardId: string, initial: RemoteChecklist[] = []) {
  const checklists = structuredClone(initial);
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let nextChecklist = checklists.length + 1;
  let nextItem = checklists.reduce((max, checklist) => Math.max(max, checklist.checkItems.length), 0) + 1;
  let loseNextItemResponse = false;
  let loseNextChecklistResponse = false;

  mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.pathname === `/1/cards/${cardId}/checklists` && method === 'GET') {
      return jsonResponse(structuredClone(checklists));
    }
    if (url.pathname === `/1/cards/${cardId}/checklists` && method === 'POST') {
      const checklist = {
        id: `checklist-${nextChecklist++}`,
        name: String(body?.name),
        checkItems: [],
      } satisfies RemoteChecklist;
      checklists.push(checklist);
      if (loseNextChecklistResponse) {
        loseNextChecklistResponse = false;
        throw new Error('Simulated response loss after Trello accepted the checklist.');
      }
      return jsonResponse({ id: checklist.id, name: checklist.name });
    }

    const addItemMatch = url.pathname.match(/^\/1\/checklists\/([^/]+)\/checkItems$/);
    if (addItemMatch && method === 'POST') {
      const checklist = checklists.find(candidate => candidate.id === addItemMatch[1]);
      if (!checklist) throw new Error(`Unknown checklist ${addItemMatch[1]}`);
      const item = { id: `item-${nextItem++}`, name: String(body?.name), state: 'incomplete' as const };
      checklist.checkItems.push(item);
      if (loseNextItemResponse) {
        loseNextItemResponse = false;
        throw new Error('Simulated response loss after Trello accepted the item.');
      }
      return jsonResponse({ id: item.id, name: item.name });
    }

    const checklistMatch = url.pathname.match(/^\/1\/checklists\/([^/]+)$/);
    if (checklistMatch && method === 'PUT') {
      const checklist = checklists.find(candidate => candidate.id === checklistMatch[1]);
      if (!checklist) throw new Error(`Unknown checklist ${checklistMatch[1]}`);
      checklist.name = url.searchParams.get('name') ?? String(body?.name);
      return jsonResponse({ id: checklist.id, name: checklist.name });
    }
    if (checklistMatch && method === 'DELETE') {
      const index = checklists.findIndex(candidate => candidate.id === checklistMatch[1]);
      if (index >= 0) checklists.splice(index, 1);
      return jsonResponse({ success: true });
    }

    const stateMatch = url.pathname.match(/^\/1\/cards\/([^/]+)\/checkItem\/([^/]+)$/);
    if (stateMatch && method === 'PUT') {
      const item = checklists.flatMap(checklist => checklist.checkItems)
        .find(candidate => candidate.id === stateMatch[2]);
      if (!item) throw new Error(`Unknown checklist item ${stateMatch[2]}`);
      item.state = url.searchParams.get('state') === 'complete' ? 'complete' : 'incomplete';
      return jsonResponse({ success: true });
    }

    throw new Error(`Unexpected mocked Trello request: ${method} ${url.pathname}`);
  });

  return {
    checklists,
    calls,
    loseNextChecklistResponse() { loseNextChecklistResponse = true; },
    loseNextItemResponse() { loseNextItemResponse = true; },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Trello Checklist Sync Service', () => {
  describe('Checklist item formatting', () => {
    it('should format APTLSS checklist item with type label', () => {
      const item = {
        step: 'Review the document',
        timeMinutes: 30,
        aptlssType: 'T' as const,
      };

      const typeLabels: Record<string, string> = {
        A: '🎯 Action',
        P: '📋 Process',
        T: '✅ Task',
        L: '📚 Learn',
        S: '🤝 Support',
      };

      const typeLabel = typeLabels[item.aptlssType];
      const timeStr = item.timeMinutes >= 60 
        ? `${Math.floor(item.timeMinutes / 60)}h ${item.timeMinutes % 60}m`
        : `${item.timeMinutes}m`;
      
      const formatted = `[${typeLabel}] ${item.step} (${timeStr})`;

      expect(formatted).toBe('[✅ Task] Review the document (30m)');
    });

    it('should format time with hours and minutes', () => {
      const formatTime = (minutes: number) => {
        if (minutes >= 60) {
          return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        }
        return `${minutes}m`;
      };

      expect(formatTime(30)).toBe('30m');
      expect(formatTime(60)).toBe('1h 0m');
      expect(formatTime(90)).toBe('1h 30m');
      expect(formatTime(120)).toBe('2h 0m');
    });

    it('should handle all APTLSS types', () => {
      const types = ['A', 'P', 'T', 'L', 'S'];
      const typeLabels: Record<string, string> = {
        A: '🎯 Action',
        P: '📋 Process',
        T: '✅ Task',
        L: '📚 Learn',
        S: '🤝 Support',
      };

      types.forEach(type => {
        expect(typeLabels[type]).toBeDefined();
        expect(typeLabels[type].length).toBeGreaterThan(0);
      });
    });
  });

  describe('replay and ordering protection', () => {
    const service = new TrelloChecklistSyncService({ apiKey: 'key', token: 'token' });
    const firstPlan = { step: 'Review the source', timeMinutes: 10, aptlssType: 'T' as const };
    const secondPlan = { step: 'Record the verified deadline', timeMinutes: 15, aptlssType: 'T' as const };
    const syncOptions = { checklistName: 'APTLSS Execution Checklist', replaceExisting: true };

    it('replays the same revision without creating another checklist or item', async () => {
      const remote = installTrelloState('replay-card');
      const options = { ...syncOptions, sourceRevision: 3 };

      const first = await service.syncChecklistToCard('replay-card', [firstPlan, firstPlan], options);
      const replay = await service.syncChecklistToCard('replay-card', [firstPlan, firstPlan], options);

      expect(first.success).toBe(true);
      expect(replay.success).toBe(true);
      expect(replay.itemsCreated).toBe(0);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].checkItems).toHaveLength(1);
      expect(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/checklists'))).toHaveLength(1);
      expect(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/checkItems'))).toHaveLength(1);
    });

    it('rejects a delayed lower revision without changing the latest verified checklist', async () => {
      const remote = installTrelloState('delayed-card');
      const latest = await service.syncChecklistToCard(
        'delayed-card',
        [secondPlan],
        { ...syncOptions, sourceRevision: 12 },
      );
      const callsBeforeReplay = remote.calls.length;
      const delayed = await service.syncChecklistToCard(
        'delayed-card',
        [firstPlan],
        { ...syncOptions, sourceRevision: 11 },
      );

      expect(latest.success).toBe(true);
      expect(delayed.success).toBe(false);
      expect(delayed.error).toContain('older than the latest verified');
      expect(remote.calls).toHaveLength(callsBeforeReplay + 1);
      expect(remote.calls.at(-1)).toMatchObject({ method: 'GET', path: '/1/cards/delayed-card/checklists' });
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].name).toBe('APTLSS Execution Checklist · v12');
      expect(remote.checklists[0].checkItems.map(item => item.name)).toEqual([
        '[✅ Task] Record the verified deadline (15m)',
      ]);
    });

    it('rejects reordered content submitted under an already verified revision', async () => {
      const remote = installTrelloState('reordered-card');
      const original = await service.syncChecklistToCard(
        'reordered-card',
        [firstPlan, secondPlan],
        { ...syncOptions, sourceRevision: 30 },
      );
      const callsBeforeReplay = remote.calls.length;
      const replay = await service.syncChecklistToCard(
        'reordered-card',
        [secondPlan, firstPlan],
        { ...syncOptions, sourceRevision: 30 },
      );

      expect(original.success).toBe(true);
      expect(replay.success).toBe(false);
      expect(replay.error).toContain('same checklist source revision');
      expect(remote.calls).toHaveLength(callsBeforeReplay + 1);
      expect(remote.checklists[0].checkItems.map(item => item.name)).toEqual([
        '[✅ Task] Review the source (10m)',
        '[✅ Task] Record the verified deadline (15m)',
      ]);
    });

    it('leaves differently named APTLSS checklists untouched during replacement', async () => {
      const remote = installTrelloState('unrelated-checklist-card', [
        {
          id: 'managed-checklist-v1',
          name: 'APTLSS Execution Checklist · v1',
          checkItems: [{ id: 'managed-item-v1', name: '[✅ Task] Review the source (10m)', state: 'incomplete' }],
        },
        {
          id: 'unrelated-checklist-v1',
          name: 'APTLSS Case Notes · v1',
          checkItems: [{ id: 'unrelated-item', name: 'Keep this note', state: 'complete' }],
        },
      ]);

      const result = await service.syncChecklistToCard(
        'unrelated-checklist-card',
        [secondPlan],
        { ...syncOptions, sourceRevision: 2 },
      );

      expect(result.success).toBe(true);
      expect(remote.checklists.some(checklist => checklist.id === 'unrelated-checklist-v1')).toBe(true);
      expect(remote.checklists.find(checklist => checklist.id === 'unrelated-checklist-v1')?.checkItems[0]).toMatchObject({
        id: 'unrelated-item',
        name: 'Keep this note',
        state: 'complete',
      });
      expect(remote.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/unrelated-checklist-v1'))).toBe(false);
      expect(remote.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/managed-checklist-v1'))).toBe(true);
    });

    it('lets the later overlapping revision win when the earlier event is delayed in a read', async () => {
      const remote = installTrelloState('overlap-card');
      const originalHandler = mocks.fetchWithRetry.getMockImplementation()!;
      const firstReadStarted = deferred<void>();
      const releaseFirstRead = deferred<void>();
      let delayedFirstRead = true;
      mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
        const url = new URL(String(rawUrl));
        if (delayedFirstRead && (init?.method ?? 'GET') === 'GET') {
          delayedFirstRead = false;
          firstReadStarted.resolve(undefined);
          await releaseFirstRead.promise;
        }
        return originalHandler(rawUrl, init);
      });

      const earlier = service.syncChecklistToCard(
        'overlap-card',
        [firstPlan],
        { ...syncOptions, sourceRevision: 20 },
      );
      await firstReadStarted.promise;
      const later = service.syncChecklistToCard(
        'overlap-card',
        [secondPlan],
        { ...syncOptions, sourceRevision: 21 },
      );
      releaseFirstRead.resolve(undefined);

      const [earlierResult, laterResult] = await Promise.all([earlier, later]);

      expect(earlierResult.success).toBe(false);
      expect(earlierResult.error).toContain('superseded');
      expect(laterResult.success).toBe(true);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].name).toBe('APTLSS Execution Checklist · v21');
      expect(remote.checklists[0].checkItems.map(item => item.name)).toEqual([
        '[✅ Task] Record the verified deadline (15m)',
      ]);
    });

    it('serializes a completion update with replacement and applies it to the replacement item', async () => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      mocks.getDb.mockResolvedValue(createOwnershipDb([
        { taskId: 'completion-race-card:old-checklist:old-item', vaId: 10, status: 'assigned' },
      ]));
      const remote = installTrelloState('completion-race-card', [{
        id: 'old-checklist',
        name: 'APTLSS Execution Checklist · v1',
        checkItems: [{ id: 'old-item', name: '[✅ Task] Review the source (10m)', state: 'incomplete' }],
      }]);
      const originalHandler = mocks.fetchWithRetry.getMockImplementation()!;
      const stageCreated = deferred<void>();
      const releaseStageResponse = deferred<void>();
      let pauseStageResponse = true;
      mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
        const response = await originalHandler(rawUrl, init);
        const url = new URL(String(rawUrl));
        if (pauseStageResponse && (init?.method ?? 'GET') === 'POST'
          && url.pathname === '/1/cards/completion-race-card/checklists') {
          pauseStageResponse = false;
          stageCreated.resolve(undefined);
          await releaseStageResponse.promise;
        }
        return response;
      });

      const syncPromise = service.syncChecklistToCard(
        'completion-race-card',
        [firstPlan, secondPlan],
        { ...syncOptions, sourceRevision: 2 },
      );
      await stageCreated.promise;
      const completionPromise = service.updateChecklistItemState('completion-race-card', 'old-item', 'complete');
      await new Promise(resolve => setTimeout(resolve, 0));
      releaseStageResponse.resolve(undefined);

      const [syncResult] = await Promise.all([syncPromise, completionPromise]);

      expect(syncResult.success).toBe(true);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].checkItems).toEqual([
        { id: 'item-2', name: '[✅ Task] Review the source (10m)', state: 'complete' },
        { id: 'item-3', name: '[✅ Task] Record the verified deadline (15m)', state: 'incomplete' },
      ]);
    });

    it('keeps the old verified checklist if staging a replacement fails, then resumes safely', async () => {
      const remote = installTrelloState('replace-card');
      const originalHandler = mocks.fetchWithRetry.getMockImplementation()!;
      let failNewItem = true;
      mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
        const url = new URL(String(rawUrl));
        const body = init?.body ? JSON.parse(String(init.body)) as { name?: string } : undefined;
        if (failNewItem && (init?.method ?? 'GET') === 'POST'
          && url.pathname.endsWith('/checkItems') && body?.name?.includes('Record the verified deadline')) {
          failNewItem = false;
          throw new Error('Simulated Trello write failure before item creation.');
        }
        return originalHandler(rawUrl, init);
      });

      const oldResult = await service.syncChecklistToCard(
        'replace-card',
        [firstPlan],
        { ...syncOptions, sourceRevision: 1 },
      );
      const oldChecklistId = oldResult.checklistId!;
      const failedReplacement = await service.syncChecklistToCard(
        'replace-card',
        [secondPlan],
        { ...syncOptions, sourceRevision: 2 },
      );

      expect(oldResult.success).toBe(true);
      expect(failedReplacement.success).toBe(false);
      expect(remote.checklists.some(checklist => checklist.id === oldChecklistId)).toBe(true);
      expect(remote.calls.some(call => call.method === 'DELETE')).toBe(false);

      const resumed = await service.syncChecklistToCard(
        'replace-card',
        [secondPlan],
        { ...syncOptions, sourceRevision: 2 },
      );

      expect(resumed.success).toBe(true);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].name).toBe('APTLSS Execution Checklist · v2');
      expect(remote.checklists[0].checkItems.map(item => item.name)).toEqual([
        '[✅ Task] Record the verified deadline (15m)',
      ]);
      expect(remote.calls.some(call => call.method === 'DELETE' && call.path.includes(oldChecklistId))).toBe(true);
    });

    it('restores completed state when a staged replacement resumes after a failed state update', async () => {
      const remote = installTrelloState('preserve-completion-card', [{
        id: 'old-completed-checklist',
        name: 'APTLSS Execution Checklist · v1',
        checkItems: [{
          id: 'old-completed-item',
          name: '[✅ Task] Review the source (10m)',
          state: 'complete',
        }],
      }]);
      const originalHandler = mocks.fetchWithRetry.getMockImplementation()!;
      let failCompletionUpdate = true;
      mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
        const url = new URL(String(rawUrl));
        if (failCompletionUpdate && (init?.method ?? 'GET') === 'PUT'
          && url.pathname.startsWith('/1/cards/preserve-completion-card/checkItem/')
          && url.searchParams.get('state') === 'complete') {
          failCompletionUpdate = false;
          throw new Error('Simulated failure before preserving the completed state.');
        }
        return originalHandler(rawUrl, init);
      });

      const options = { ...syncOptions, sourceRevision: 2 };
      const failed = await service.syncChecklistToCard(
        'preserve-completion-card',
        [firstPlan, secondPlan],
        options,
      );

      expect(failed.success).toBe(false);
      expect(remote.checklists).toHaveLength(2);
      expect(remote.checklists.find(checklist => checklist.id === 'old-completed-checklist')?.checkItems[0].state)
        .toBe('complete');

      const resumed = await service.syncChecklistToCard(
        'preserve-completion-card',
        [firstPlan, secondPlan],
        options,
      );

      expect(resumed.success).toBe(true);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].name).toBe('APTLSS Execution Checklist · v2');
      expect(remote.checklists[0].checkItems.map(item => ({ name: item.name, state: item.state }))).toEqual([
        { name: '[✅ Task] Review the source (10m)', state: 'complete' },
        { name: '[✅ Task] Record the verified deadline (15m)', state: 'incomplete' },
      ]);
    });

    it('reconciles a lost add-item response before another POST can duplicate it', async () => {
      const remote = installTrelloState('lost-response-card');
      remote.loseNextItemResponse();

      const result = await service.syncChecklistToCard(
        'lost-response-card',
        [firstPlan],
        { ...syncOptions, sourceRevision: 1 },
      );

      expect(result.success).toBe(true);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].checkItems).toHaveLength(1);
      expect(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/checkItems'))).toHaveLength(1);
    });

    it('recovers a created checklist when Trello accepts the POST but the response is lost', async () => {
      const remote = installTrelloState('lost-checklist-response-card');
      remote.loseNextChecklistResponse();

      const result = await service.syncChecklistToCard(
        'lost-checklist-response-card',
        [firstPlan],
        { ...syncOptions, sourceRevision: 1 },
      );

      expect(result.success).toBe(true);
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].checkItems).toHaveLength(1);
      expect(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/checklists'))).toHaveLength(1);
    });

    it('does not guess whether a different unversioned checklist request is stale or current', async () => {
      const remote = installTrelloState('unknown-order-card', [{
        id: 'existing-checklist',
        name: 'APTLSS Execution Checklist',
        checkItems: [{ id: 'existing-item', name: '[✅ Task] Review the source (10m)', state: 'complete' }],
      }]);

      const result = await service.syncChecklistToCard('unknown-order-card', [secondPlan], syncOptions);

      expect(result.success).toBe(false);
      expect(result.error).toContain('source revision is required');
      expect(remote.checklists).toHaveLength(1);
      expect(remote.checklists[0].checkItems[0].state).toBe('complete');
      expect(remote.calls.every(call => call.method === 'GET')).toBe(true);
    });

    it('bounds PostgreSQL lock waiting and holds a transaction-scoped lock before provider work', async () => {
      const txExecute = vi.fn()
        .mockResolvedValue({ rows: [], rowCount: 1 });
      const db = {
        transaction: vi.fn(async (callback: (tx: { execute: typeof txExecute }) => Promise<unknown>) =>
          callback({ execute: txExecute })),
        execute: vi.fn().mockResolvedValue([[]]),
      };
      mocks.getDb.mockResolvedValue(db);
      installTrelloState('db-lock-card');

      const result = await service.syncChecklistToCard('db-lock-card', [firstPlan], syncOptions);

      expect(result.success).toBe(true);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(txExecute).toHaveBeenCalledTimes(2);
      const queries = txExecute.mock.calls.map(([statement]) => new PgDialect().sqlToQuery(statement));
      expect(queries[0].sql).toContain("set_config('lock_timeout'");
      expect(queries[0].params).toEqual(['10s']);
      expect(queries[1].sql).toContain('pg_advisory_xact_lock(hashtextextended(');
      expect(queries[1].params[0]).toMatch(/^aptlss-checklist-[a-f0-9]{40}$/);
      expect(txExecute.mock.invocationCallOrder[1]).toBeLessThan(mocks.fetchWithRetry.mock.invocationCallOrder[0]);
    });

    it('does not contact the provider when PostgreSQL cannot acquire the card lock', async () => {
      const txExecute = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }));
      mocks.getDb.mockResolvedValue({ transaction: async (work: (tx: unknown) => unknown) => work({ execute: txExecute }) });
      const result = await service.syncChecklistToCard('db-timeout-card', [firstPlan], syncOptions);
      expect(result.success).toBe(false);
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('pilot write boundary', () => {
    const service = new TrelloChecklistSyncService({ apiKey: 'key', token: 'token' });
    const item = { step: 'Review the source', timeMinutes: 10, aptlssType: 'T' as const };

    it.each([
      {
        label: 'pilot ownership',
        assignments: [{ taskId: 'card-1', vaId: 9, status: 'assigned' }],
        expectedReason: 'pilot worker',
      },
      {
        label: 'missing ownership',
        assignments: [],
        expectedReason: 'ownership is missing',
      },
      {
        label: 'ambiguous ownership',
        assignments: [
          { taskId: 'card-1', vaId: 10, status: 'assigned' },
          { taskId: 'card-1:checklist-1:item-1', vaId: 11, status: 'in_progress' },
        ],
        expectedReason: 'ownership is ambiguous',
      },
    ])('blocks Trello requests for $label', async ({ assignments, expectedReason }) => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      mocks.getDb.mockResolvedValue(createOwnershipDb(assignments));

      const result = await service.syncChecklistToCard('card-1', [item]);

      expect(result.success).toBe(false);
      expect(result.error).toContain(expectedReason);
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    });

    it('retains checklist writes for a clearly assigned non-pilot card', async () => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      const db = createOwnershipDb([
        { taskId: 'card-1:checklist-1:item-1', vaId: 10, status: 'assigned' },
      ]);
      mocks.getDb.mockResolvedValue(db);
      const remoteChecklists: Array<{ id: string; name: string; checkItems: Array<{ id: string; name: string; state: 'incomplete' }> }> = [];
      mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
        const url = new URL(String(rawUrl));
        const method = init?.method ?? 'GET';
        if (url.pathname === '/1/cards/card-1/checklists' && method === 'GET') {
          return jsonResponse(remoteChecklists);
        }
        if (url.pathname === '/1/cards/card-1/checklists' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { name: string };
          const checklist = { id: 'checklist-1', name: body.name, checkItems: [] };
          remoteChecklists.push(checklist);
          return jsonResponse({ id: checklist.id, name: checklist.name });
        }
        if (url.pathname === '/1/checklists/checklist-1/checkItems' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { name: string };
          remoteChecklists[0].checkItems.push({ id: 'item-1', name: body.name, state: 'incomplete' });
          return jsonResponse({ id: 'item-1', name: body.name });
        }
        if (url.pathname === '/1/checklists/checklist-1' && method === 'PUT') {
          const name = url.searchParams.get('name') ?? '';
          remoteChecklists[0].name = name;
          return jsonResponse({ id: 'checklist-1', name });
        }
        throw new Error(`Unexpected mocked Trello request: ${method} ${url.pathname}`);
      });

      const result = await service.syncChecklistToCard('card-1', [item]);

      expect(result.success).toBe(true);
      expect(result.checklistId).toBe('checklist-1');
      expect(mocks.fetchWithRetry.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('fails closed for low-level checklist writes that lack a card ID', async () => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      mocks.getDb.mockResolvedValue(createOwnershipDb([]));

      await expect(service.addChecklistItem('checklist-1', 'Step')).rejects.toThrow('Card ownership is unavailable');
      await expect(service.deleteChecklist('checklist-1')).rejects.toThrow('Card ownership is unavailable');
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    });

    it('fails closed when shadow safeguards are enabled without a valid worker allowlist', async () => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '');
      vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');

      const result = await service.syncChecklistToCard('card-1', [item]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('allowlist is invalid');
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    });

    it('blocks every low-level checklist mutation for a pilot-owned card', async () => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      mocks.getDb.mockResolvedValue(createOwnershipDb([
        { taskId: 'card-1', vaId: 9, status: 'assigned' },
      ]));

      await expect(service.createChecklist('card-1', 'APTLSS')).rejects.toThrow('pilot worker');
      await expect(service.addChecklistItem('checklist-1', 'Step', 'bottom', 'card-1')).rejects.toThrow('pilot worker');
      await expect(service.updateChecklistItemState('card-1', 'item-1', 'complete')).rejects.toThrow('pilot worker');
      await expect(service.deleteChecklist('checklist-1', 'card-1')).rejects.toThrow('pilot worker');
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    });

    it.each([
      ['addChecklistItem', () => service.addChecklistItem('pilot-checklist', 'Injected step', 'bottom', 'owned-card')],
      ['deleteChecklist', () => service.deleteChecklist('pilot-checklist', 'owned-card')],
      ['updateChecklistItemState', () => service.updateChecklistItemState('owned-card', 'pilot-item', 'complete')],
    ])('does not let %s mutate an object from a different card', async (_operation, invoke) => {
      vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
      mocks.getDb.mockResolvedValue(createOwnershipDb([
        { taskId: 'owned-card:checklist-owned:item-owned', vaId: 10, status: 'assigned' },
      ]));
      const calls: Array<{ method: string; path: string }> = [];
      mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
        const url = new URL(String(rawUrl));
        const method = init?.method ?? 'GET';
        calls.push({ method, path: url.pathname });
        if (method === 'GET' && url.pathname === '/1/cards/owned-card/checklists') {
          return jsonResponse([]);
        }
        return jsonResponse({ id: 'unexpected-write' });
      });

      await expect(invoke()).rejects.toThrow(/does not belong to the authorized Trello card/);
      expect(calls).toEqual([{ method: 'GET', path: '/1/cards/owned-card/checklists' }]);
    });
  });

  describe('Sync result handling', () => {
    it('should return success result with checklist info', () => {
      const result = {
        success: true,
        checklistId: 'checklist123',
        checklistName: '✨ APTLSS Checklist (AI-Generated)',
        itemsCreated: 5,
      };

      expect(result.success).toBe(true);
      expect(result.checklistId).toBe('checklist123');
      expect(result.itemsCreated).toBe(5);
    });

    it('should return error result on failure', () => {
      const result = {
        success: false,
        error: 'Failed to create checklist',
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to create checklist');
    });

    it('should handle existing checklist warning', () => {
      const result = {
        success: true,
        checklistId: 'existing123',
        checklistName: 'APTLSS Checklist',
        itemsCreated: 0,
        error: 'APTLSS checklist already exists. Use replaceExisting=true to update.',
      };

      expect(result.success).toBe(true);
      expect(result.itemsCreated).toBe(0);
      expect(result.error).toContain('already exists');
    });
  });

  describe('Bulk sync operations', () => {
    it('should aggregate bulk sync results', () => {
      const results = [
        { success: true, itemsCreated: 5 },
        { success: true, itemsCreated: 3 },
        { success: false, error: 'Card not found' },
        { success: true, itemsCreated: 7 },
      ];

      const total = results.length;
      const success = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      expect(total).toBe(4);
      expect(success).toBe(3);
      expect(failed).toBe(1);
    });

    it('should filter cards without checklists', () => {
      const cards = [
        { cardId: 1, trelloId: 'abc', checklist: [{ step: 'Step 1' }] },
        { cardId: 2, trelloId: 'def', checklist: [] },
        { cardId: 3, trelloId: 'ghi', checklist: [{ step: 'Step 1' }, { step: 'Step 2' }] },
      ];

      const toSync = cards.filter(c => c.checklist.length > 0);

      expect(toSync).toHaveLength(2);
      expect(toSync[0].cardId).toBe(1);
      expect(toSync[1].cardId).toBe(3);
    });
  });

  describe('Completion sync', () => {
    it('should determine correct state for completion', () => {
      const getState = (completed: boolean) => completed ? 'complete' : 'incomplete';

      expect(getState(true)).toBe('complete');
      expect(getState(false)).toBe('incomplete');
    });

    it('should find checklist item by index', () => {
      const checkItems = [
        { id: 'item1', name: 'Step 1', state: 'incomplete' },
        { id: 'item2', name: 'Step 2', state: 'incomplete' },
        { id: 'item3', name: 'Step 3', state: 'complete' },
      ];

      const stepIndex = 1;
      const item = checkItems[stepIndex];

      expect(item.id).toBe('item2');
      expect(item.name).toBe('Step 2');
    });

    it('should validate step index bounds', () => {
      const checkItems = [
        { id: 'item1', name: 'Step 1' },
        { id: 'item2', name: 'Step 2' },
      ];

      const isValidIndex = (index: number) => index >= 0 && index < checkItems.length;

      expect(isValidIndex(0)).toBe(true);
      expect(isValidIndex(1)).toBe(true);
      expect(isValidIndex(2)).toBe(false);
      expect(isValidIndex(-1)).toBe(false);
    });
  });

  describe('Preserve completed items', () => {
    it('should track completed items by name', () => {
      const existingItems = [
        { id: '1', name: '[✅ Task] Step 1 (10m)', state: 'complete' as const },
        { id: '2', name: '[✅ Task] Step 2 (15m)', state: 'incomplete' as const },
        { id: '3', name: '[📋 Process] Step 3 (20m)', state: 'complete' as const },
      ];

      const completedItems = new Set<string>();
      existingItems
        .filter(item => item.state === 'complete')
        .forEach(item => completedItems.add(item.name));

      expect(completedItems.size).toBe(2);
      expect(completedItems.has('[✅ Task] Step 1 (10m)')).toBe(true);
      expect(completedItems.has('[📋 Process] Step 3 (20m)')).toBe(true);
      expect(completedItems.has('[✅ Task] Step 2 (15m)')).toBe(false);
    });

    it('should restore completion state for matching items', () => {
      const completedItems = new Set(['[✅ Task] Step 1 (10m)', '[📋 Process] Step 3 (20m)']);
      
      const newItems = [
        '[✅ Task] Step 1 (10m)',
        '[✅ Task] Step 2 (15m)',
        '[📋 Process] Step 3 (20m)',
      ];

      const itemsToComplete = newItems.filter(name => completedItems.has(name));

      expect(itemsToComplete).toHaveLength(2);
      expect(itemsToComplete).toContain('[✅ Task] Step 1 (10m)');
      expect(itemsToComplete).toContain('[📋 Process] Step 3 (20m)');
    });
  });

  describe('Sync status tracking', () => {
    it('should return synced status with metadata', () => {
      const syncStatus = {
        synced: true,
        checklistId: 'checklist123',
        itemsSynced: 5,
        syncedAt: new Date('2025-12-23T10:00:00Z'),
      };

      expect(syncStatus.synced).toBe(true);
      expect(syncStatus.itemsSynced).toBe(5);
      expect(syncStatus.syncedAt).toBeInstanceOf(Date);
    });

    it('should return not synced status', () => {
      const syncStatus = {
        synced: false,
        reason: 'No Trello ID',
      };

      expect(syncStatus.synced).toBe(false);
      expect(syncStatus.reason).toBe('No Trello ID');
    });
  });
});
