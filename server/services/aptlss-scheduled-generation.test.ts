import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generationItems,
  generationJobs,
  scheduledJobs,
  taskAssignments,
  users,
} from '../../drizzle/schema.postgres';
import { approvalSnapshotHash } from './aptlss-scheduled-approval';

const controls = vi.hoisted(() => ({
  getDb: vi.fn(),
  runScheduledJob: vi.fn(),
  fetchAndGenerateAptlss: vi.fn(),
}));

vi.mock('../db', () => ({ getDb: controls.getDb }));
vi.mock('../scheduledJobRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scheduledJobRuntime')>()),
  runScheduledJob: controls.runScheduledJob,
}));
vi.mock('./aptlss-generation', () => ({ fetchAndGenerateAptlss: controls.fetchAndGenerateAptlss }));

import {
  executeAptlssGenerationBatch,
  processDueAptlssGenerationJobs,
  startAptlssScheduledGenerationProcessor,
  stopAptlssScheduledGenerationProcessor,
} from './aptlss-scheduled-generation';
import {
  ScheduledJobLeaseLostError,
  type ScheduledJobContext,
  type ScheduledJobOwnershipReader,
} from '../scheduledJobRuntime';
import { assertAptlssJobOwnership } from './trello-checklist-sync';

function ownedContext(): ScheduledJobContext {
  return { signal: new AbortController().signal, assertOwnership: vi.fn().mockResolvedValue(undefined) };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function requestedScheduledStatus(condition: unknown): string | undefined {
  if (!condition || typeof condition !== 'object') return undefined;
  const node = condition as { value?: unknown; queryChunks?: unknown[] };
  if (node.value === 'pending' || node.value === 'running') return node.value;
  for (const chunk of node.queryChunks ?? []) {
    const status = requestedScheduledStatus(chunk);
    if (status) return status;
  }
  return undefined;
}

function createScheduledJobDb(job: Record<string, any>, now: Date) {
  const db = {
    transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          if (table === generationItems) return Promise.resolve([]);
          const status = requestedScheduledStatus(condition);
          let ordered = false;
          const query = {
            orderBy: () => {
              ordered = true;
              return query;
            },
            limit: () => {
              const rows =
                table === users
                  ? [{ id: 1, openId: 'founder-1', role: 'admin', sessionEpoch: '1' }]
                  : !ordered || (job.status === status && job.scheduledTime <= now)
                    ? [{ ...job }]
                    : [];
              return Object.assign(Promise.resolve(rows), { for: async () => rows });
            },
          };
          return query;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table !== scheduledJobs) return { rowCount: 1 };
          if (values.status === 'pending' && job.status !== 'running') return { rowCount: 0 };
          if (values.status === 'running' && job.status !== 'pending') return { rowCount: 0 };
          Object.assign(job, values);
          return { rowCount: 1 };
        },
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
  };
  return db;
}

function makeScheduledJob(status: string, now: Date) {
  const job = {
    id: 'scheduled-recovery',
    cardIds: JSON.stringify(['card-1']),
    scheduledTime: new Date(now.getTime() - 60_000),
    status,
    settings: '{}',
    createdAt: new Date(now.getTime() - 120_000),
    completedAt: null,
    error: null,
    createdBy: 'founder-1',
    approvedByUserId: 1,
    approvedSessionEpoch: '1',
    approvedAt: new Date(now.getTime() - 120_000),
  };
  return { ...job, approvalHash: approvalSnapshotHash(job) };
}

const generatedChecklist = {
  success: true,
  cardId: 'card-1',
  aptlss: { summary: 'Generated checklist' },
  validation: { needsReview: false },
  checklistId: 'checklist-1',
  appliedToTrello: false,
  reusedExistingChecklist: false,
  itemsCreated: 0,
};

function createGenerationBatchDb(
  assignmentRows: Array<{ taskId: string; vaId: number; status: string }> = [],
) {
  const jobs = new Map<string, Record<string, any>>();
  const items = new Map<string, Record<string, any>>();
  let failItemWriteForCardId: string | null = null;
  return {
    jobs,
    items,
    failItemWriteForCardId(value: string | null) {
      failItemWriteForCardId = value;
    },
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === taskAssignments) {
              return { limit: async (count: number) => assignmentRows.slice(0, count) };
            }
            return Promise.resolve(
              table === generationItems ? [...items.values()].map((item) => ({ ...item })) : [],
            );
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, any>) => ({
          onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
            if (
              table === generationItems &&
              row.cardId === failItemWriteForCardId &&
              row.status !== 'outcome_unknown'
            ) {
              throw new Error('Simulated interruption while saving generation progress');
            }
            const rows = table === generationJobs ? jobs : items;
            rows.set(row.id, { ...rows.get(row.id), ...row, ...set });
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            const rows = table === generationJobs ? jobs : items;
            for (const [id, row] of rows) rows.set(id, { ...row, ...values });
            return { rowCount: rows.size ? 1 : 0 };
          },
        }),
      }),
    },
  };
}

describe('processDueAptlssGenerationJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '');
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('runs a batch only for the processor whose pending-to-running update claimed the row', async () => {
    const now = new Date('2026-09-25T12:00:00.000Z');
    const job = makeScheduledJob('pending', now);
    const firstClaimAttempt = deferred();
    const releaseFirstClaim = deferred();
    const batchStarted = deferred();
    const releaseBatch = deferred<{
      aptlss: { summary: string };
      validation: { needsReview: boolean };
      checklistId: string;
      appliedToTrello: boolean;
    }>();
    const currentReadStatuses: string[] = [];
    const claimStatuses: string[] = [];
    let claimAttempts = 0;

    const db = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            if (table === generationItems) return Promise.resolve([]);
            const status = requestedScheduledStatus(condition);
            let ordered = false;
            const query = {
              orderBy: () => {
                ordered = true;
                return query;
              },
              limit: () => {
                if (!ordered && table === scheduledJobs) currentReadStatuses.push(job.status);
                const rows =
                  table === users
                    ? [{ id: 1, openId: 'founder-1', role: 'admin', sessionEpoch: '1' }]
                    : !ordered || (job.status === status && job.scheduledTime <= now)
                      ? [{ ...job }]
                      : [];
                return Object.assign(Promise.resolve(rows), { for: async () => rows });
              },
            };
            return query;
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (table === scheduledJobs && values.status === 'running') {
              claimAttempts += 1;
              if (claimAttempts === 1) {
                firstClaimAttempt.resolve();
                await releaseFirstClaim.promise;
              }
              claimStatuses.push(job.status);
              if (job.status !== 'pending') return { rowCount: 0 };
              Object.assign(job, values);
              return { rowCount: 1 };
            }
            if (table === scheduledJobs) Object.assign(job, values);
            if (table === generationJobs || table === generationItems) return { rowCount: 1 };
            return { rowCount: 1 };
          },
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoUpdate: async () => undefined }),
      }),
    };

    controls.getDb.mockResolvedValue(db);
    controls.runScheduledJob.mockImplementation(
      async (_options: unknown, work: (context: ScheduledJobContext) => Promise<unknown>) => {
        await work(ownedContext());
        return { state: 'success' };
      },
    );
    controls.fetchAndGenerateAptlss.mockImplementation(async () => {
      batchStarted.resolve();
      return releaseBatch.promise;
    });

    const processorA = processDueAptlssGenerationJobs(now);
    await firstClaimAttempt.promise;

    const processorB = processDueAptlssGenerationJobs(now);
    await batchStarted.promise;

    releaseFirstClaim.resolve();
    await processorA;

    expect(currentReadStatuses.filter((status) => status === 'pending').length).toBeGreaterThanOrEqual(2);
    expect(claimStatuses).toEqual(['pending', 'running']);
    expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledTimes(1);

    releaseBatch.resolve({
      aptlss: { summary: 'Generated checklist' },
      validation: { needsReview: false },
      checklistId: 'checklist-1',
      appliedToTrello: false,
    });
    await processorB;
    expect(job.status).toBe('completed');
  });

  it('does not recover or run a still-heartbeating scheduled job', async () => {
    const now = new Date('2026-09-25T12:00:00.000Z');
    const job = makeScheduledJob('running', now);
    const db = createScheduledJobDb(job, now);
    controls.getDb.mockResolvedValue(db);
    controls.runScheduledJob.mockImplementation(
      async (_options: unknown, work: (context: ScheduledJobContext) => Promise<unknown>) => {
        if (job.status === 'running') return { state: 'skipped', reason: 'lease_held' };
        await work(ownedContext());
        return { state: 'success' };
      },
    );

    await processDueAptlssGenerationJobs(now);

    expect(job.status).toBe('running');
    expect(controls.runScheduledJob).toHaveBeenCalledTimes(1);
    expect(controls.fetchAndGenerateAptlss).not.toHaveBeenCalled();
  });

  it.each(['expired', 'missing'] as const)(
    'recovers and resumes a running job when its lease is %s',
    async (initialLeaseState) => {
      const now = new Date('2026-09-25T12:00:00.000Z');
      const job = makeScheduledJob('running', now);
      const db = createScheduledJobDb(job, now);
      let leaseState: 'expired' | 'missing' | 'active' = initialLeaseState;
      const acquiredFrom: Array<'expired' | 'missing'> = [];
      controls.getDb.mockResolvedValue(db);
      controls.runScheduledJob.mockImplementation(
        async (_options: unknown, work: (context: ScheduledJobContext) => Promise<unknown>) => {
          if (leaseState === 'active') return { state: 'skipped', reason: 'lease_held' };
          acquiredFrom.push(leaseState);
          leaseState = 'active';
          try {
            await work(ownedContext());
          } finally {
            leaseState = 'missing';
          }
          return { state: 'success' };
        },
      );
      controls.fetchAndGenerateAptlss.mockResolvedValue(generatedChecklist);

      const result = await processDueAptlssGenerationJobs(now);

      expect(acquiredFrom[0]).toBe(initialLeaseState);
      expect(acquiredFrom).toEqual([initialLeaseState, 'missing']);
      expect(controls.runScheduledJob).toHaveBeenCalledTimes(2);
      expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledTimes(1);
      expect(job.status).toBe('completed');
      expect(result.processed).toBe(1);
    },
  );
});

describe('scheduled generation ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '');
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', '');
  });

  afterEach(() => {
    stopAptlssScheduledGenerationProcessor();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    'forwards the same reader in parent-before-child order (parent=%s)',
    async (withParent) => {
      const now = new Date('2026-09-25T12:00:00Z');
      const job = makeScheduledJob('pending', now);
      const db = createScheduledJobDb(job, now);
      controls.getDb.mockResolvedValue(db);
      const parent = ownedContext();
      const child = ownedContext();
      const reader = { select: db.select } as ScheduledJobOwnershipReader;
      const trace: string[] = [];
      vi.mocked(parent.assertOwnership).mockImplementation(async (received) => {
        await Promise.resolve();
        if (received === reader) trace.push('parent');
        else if (received) expect(received).toBe(db);
      });
      vi.mocked(child.assertOwnership).mockImplementation(async (received) => {
        if (received === reader) trace.push('child');
        else if (received) expect(received).toBe(db);
      });
      controls.runScheduledJob.mockImplementation(async (_options, work) => {
        await work(child);
        return { state: 'success' };
      });
      controls.fetchAndGenerateAptlss.mockImplementation(
        async (_cardId, _settings, chained: ScheduledJobContext) => {
          expect(chained.signal).toBe(withParent ? chained.signal : child.signal);
          await assertAptlssJobOwnership(chained, reader);
          expect(trace).toEqual(withParent ? ['parent', 'child', 'parent', 'child'] : ['child', 'child']);
          return generatedChecklist;
        },
      );
      await expect(
        processDueAptlssGenerationJobs(now, withParent ? parent : undefined),
      ).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(trace).toEqual(withParent ? ['parent', 'child', 'parent', 'child'] : ['child', 'child']);
      expect(child.assertOwnership).toHaveBeenCalledWith(reader);
      expect(child.assertOwnership).toHaveBeenCalledWith(undefined);
      if (withParent) {
        expect(parent.assertOwnership).toHaveBeenCalledWith(reader);
        expect(parent.assertOwnership).toHaveBeenCalledWith(undefined);
      }
      for (const owner of withParent ? [parent, child] : [child]) {
        const readerCalls = vi
          .mocked(owner.assertOwnership)
          .mock.calls.filter(([received]) => received === reader);
        expect(readerCalls).toHaveLength(2);
        expect(readerCalls[0][0]).toBe(reader);
      }
    },
  );

  it.each(['parent', 'child'] as const)(
    'propagates reader-backed %s loss without checking later owners',
    async (lostOwner) => {
      const now = new Date('2026-09-25T12:00:00Z');
      const job = makeScheduledJob('pending', now);
      controls.getDb.mockResolvedValue(createScheduledJobDb(job, now));
      const parent = ownedContext();
      const child = ownedContext();
      const reader = { select: vi.fn() } as ScheduledJobOwnershipReader;
      const loss = new ScheduledJobLeaseLostError();
      const trace: string[] = [];
      for (const [name, context] of [
        ['parent', parent],
        ['child', child],
      ] as const) {
        vi.mocked(context.assertOwnership).mockImplementation(async (received) => {
          if (!received || received !== reader) return;
          expect(received).toBe(reader);
          trace.push(name);
          if (name === lostOwner) throw loss;
        });
      }
      controls.runScheduledJob.mockImplementation(async (_options, work) => {
        await work(child);
        return { state: 'success' };
      });
      controls.fetchAndGenerateAptlss.mockImplementation(
        async (_cardId, _settings, chained: ScheduledJobContext) => {
          await assertAptlssJobOwnership(chained, reader);
          return generatedChecklist;
        },
      );
      await expect(processDueAptlssGenerationJobs(now, parent)).rejects.toBe(loss);
      expect(trace).toEqual(lostOwner === 'parent' ? ['parent'] : ['parent', 'child']);
      expect(job).toMatchObject({ status: 'running', completedAt: null });
    },
  );

  it.each([
    ['parent', 'result'],
    ['child', 'result'],
    ['parent', 'error'],
    ['child', 'error'],
  ] as const)(
    'does not finalize replacement state after %s ownership is lost during a late %s',
    async (lostOwner, outcome) => {
      const now = new Date('2026-09-25T12:00:00Z');
      const job = makeScheduledJob('pending', now);
      controls.getDb.mockResolvedValue(createScheduledJobDb(job, now));
      const parent = ownedContext();
      const child = ownedContext();
      const loss = new ScheduledJobLeaseLostError();
      const started = deferred();
      const release = deferred<typeof generatedChecklist>();
      controls.runScheduledJob.mockImplementation(async (_options, work) => {
        await work(child);
        return { state: 'success' };
      });
      controls.fetchAndGenerateAptlss.mockImplementation(async () => {
        started.resolve();
        return release.promise;
      });
      const processing = processDueAptlssGenerationJobs(now, parent);
      const rejected = expect(processing).rejects.toBe(loss);
      await started.promise;
      const context = lostOwner === 'parent' ? parent : child;
      vi.mocked(context.assertOwnership).mockRejectedValue(loss);
      Object.assign(job, { status: 'needs_review', error: 'Replacement owner state' });
      if (outcome === 'result') release.resolve(generatedChecklist);
      else release.reject(new Error('Late provider failure'));
      await rejected;
      expect(job).toMatchObject({
        status: 'needs_review',
        error: 'Replacement owner state',
        completedAt: null,
      });
      expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledTimes(1);
      expect(parent.assertOwnership).toHaveBeenCalled();
      expect(child.assertOwnership).toHaveBeenCalled();
    },
  );

  it('does not recover running rows under an aborted parent', async () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const job = makeScheduledJob('running', now);
    controls.getDb.mockResolvedValue(createScheduledJobDb(job, now));
    const controller = new AbortController();
    controller.abort();
    await expect(
      processDueAptlssGenerationJobs(now, {
        signal: controller.signal,
        assertOwnership: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(job.status).toBe('running');
    expect(controls.runScheduledJob).not.toHaveBeenCalled();
  });

  it('does not reset a running row after losing the acquired recovery lease', async () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const job = makeScheduledJob('running', now);
    controls.getDb.mockResolvedValue(createScheduledJobDb(job, now));
    const loss = new ScheduledJobLeaseLostError();
    const child = ownedContext();
    vi.mocked(child.assertOwnership).mockRejectedValue(loss);
    controls.runScheduledJob.mockImplementation(async (_options, work) => {
      await work(child);
      return { state: 'success' };
    });
    await expect(processDueAptlssGenerationJobs(now)).rejects.toBe(loss);
    expect(job.status).toBe('running');
    expect(controls.fetchAndGenerateAptlss).not.toHaveBeenCalled();
  });

  it('rechecks ownership before scheduled finalization after the batch is durable', async () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const job = makeScheduledJob('pending', now);
    const db = createScheduledJobDb(job, now);
    const child = ownedContext();
    const loss = new ScheduledJobLeaseLostError();
    const update = db.update;
    db.update = (table) => ({
      set: (values) => ({
        where: async () => {
          const result = await update(table).set(values).where();
          if (table === generationJobs && values.completedAt) {
            Object.assign(job, { status: 'needs_review', error: 'Replacement owner state' });
            vi.mocked(child.assertOwnership).mockRejectedValue(loss);
          }
          return result;
        },
      }),
    });
    controls.getDb.mockResolvedValue(db);
    controls.runScheduledJob.mockImplementation(async (_options, work) => {
      await work(child);
      return { state: 'success' };
    });
    controls.fetchAndGenerateAptlss.mockResolvedValue(generatedChecklist);
    await expect(processDueAptlssGenerationJobs(now)).rejects.toBe(loss);
    expect(job).toMatchObject({
      status: 'needs_review',
      error: 'Replacement owner state',
      completedAt: null,
    });
  });

  it.each(['parent', 'child'] as const)(
    'passes the %s abort signal through the chained generation context',
    async (lostOwner) => {
      const now = new Date('2026-09-25T12:00:00Z');
      const job = makeScheduledJob('pending', now);
      controls.getDb.mockResolvedValue(createScheduledJobDb(job, now));
      const parentController = new AbortController();
      const childController = new AbortController();
      const parent = { ...ownedContext(), signal: parentController.signal };
      const child = { ...ownedContext(), signal: childController.signal };
      controls.runScheduledJob.mockImplementation(async (_options, work) => {
        await work(child);
        return { state: 'success' };
      });
      controls.fetchAndGenerateAptlss.mockImplementation(
        async (_cardId, _settings, chained: ScheduledJobContext) => {
          await chained.assertOwnership();
          expect(chained.signal.aborted).toBe(false);
          (lostOwner === 'parent' ? parentController : childController).abort();
          expect(chained.signal.aborted).toBe(true);
          return generatedChecklist;
        },
      );
      await expect(processDueAptlssGenerationJobs(now, parent)).rejects.toBeInstanceOf(
        ScheduledJobLeaseLostError,
      );
      expect(job.status).toBe('running');
    },
  );

  it('records ordinary failures while owned without checking a child lease released by the runtime', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = new Date('2026-09-25T12:00:00Z');
    const job = makeScheduledJob('pending', now);
    const db = createScheduledJobDb(job, now);
    db.insert = () => {
      throw new Error('Synthetic persistence failure');
    };
    controls.getDb.mockResolvedValue(db);
    const child = ownedContext();
    controls.runScheduledJob.mockImplementation(async (_options, work) => {
      try {
        await work(child);
        return { state: 'success' };
      } finally {
        vi.mocked(child.assertOwnership).mockRejectedValue(new ScheduledJobLeaseLostError());
      }
    });
    await expect(processDueAptlssGenerationJobs(now, ownedContext())).resolves.toMatchObject({
      failed: 1,
      processed: 0,
    });
    expect(job.status).toBe('failed');
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    'propagates lease loss without retrying (applyToTrello=%s)',
    async (applyToTrello) => {
      const state = createGenerationBatchDb();
      controls.getDb.mockResolvedValue(state.db);
      const loss = new ScheduledJobLeaseLostError();
      controls.fetchAndGenerateAptlss.mockRejectedValue(loss);
      await expect(
        executeAptlssGenerationBatch({
          jobId: 'lost-batch',
          cardIds: ['card-1', 'card-2'],
          createdBy: 'founder-1',
          settings: { maxRetries: 3, applyToTrello },
          context: ownedContext(),
        }),
      ).rejects.toBe(loss);
      expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledTimes(1);
      if (applyToTrello)
        expect(state.items.get('item_lost-batch_0')).toMatchObject({
          status: 'outcome_unknown',
          attempts: 0,
        });
      expect(state.items.size).toBe(applyToTrello ? 1 : 0);
      expect(state.jobs.get('lost-batch')).toMatchObject({
        status: 'running',
        completedCards: 0,
        failedCards: 0,
      });
    },
  );

  it('does not persist a late generation result after cancellation', async () => {
    const state = createGenerationBatchDb();
    controls.getDb.mockResolvedValue(state.db);
    const controller = new AbortController();
    controls.fetchAndGenerateAptlss.mockImplementation(async () => {
      controller.abort();
      return generatedChecklist;
    });
    await expect(
      executeAptlssGenerationBatch({
        jobId: 'lost-preview',
        cardIds: ['card-1'],
        createdBy: 'founder-1',
        settings: { applyToTrello: false, maxRetries: 3 },
        context: { signal: controller.signal, assertOwnership: vi.fn().mockResolvedValue(undefined) },
      }),
    ).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.items.size).toBe(0);
    expect(state.jobs.get('lost-preview')?.status).toBe('running');
  });

  it('aborts the retry wait immediately without another generation attempt', async () => {
    vi.useFakeTimers();
    const state = createGenerationBatchDb();
    controls.getDb.mockResolvedValue(state.db);
    const controller = new AbortController();
    controls.fetchAndGenerateAptlss.mockRejectedValue(new Error('Transient model failure'));
    const processing = executeAptlssGenerationBatch({
      jobId: 'retry-abort',
      cardIds: ['card-1'],
      createdBy: 'founder-1',
      settings: { applyToTrello: false, maxRetries: 3 },
      context: { signal: controller.signal, assertOwnership: vi.fn().mockResolvedValue(undefined) },
    });
    const rejected = expect(processing).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledTimes(1);
    expect(state.items.size).toBe(0);
  });

  it('cancels the initial timeout when stopped before the first tick', async () => {
    vi.useFakeTimers();
    startAptlssScheduledGenerationProcessor();
    stopAptlssScheduledGenerationProcessor();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(controls.getDb).not.toHaveBeenCalled();
  });
});

describe('executeAptlssGenerationBatch replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '');
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('does not regenerate a persisted card after a later card result fails to save', async () => {
    const state = createGenerationBatchDb();
    controls.getDb.mockResolvedValue(state.db);
    controls.fetchAndGenerateAptlss.mockImplementation(async (cardId: string) => ({
      ...generatedChecklist,
      cardId,
    }));
    state.failItemWriteForCardId('card-2');

    const input = {
      jobId: 'scheduled-replay',
      cardIds: ['card-1', 'card-2'],
      createdBy: 'founder-1',
      settings: { maxRetries: 1, applyToTrello: false },
    };

    await expect(executeAptlssGenerationBatch(input)).rejects.toThrow('Simulated interruption');
    expect(controls.fetchAndGenerateAptlss.mock.calls.map(([cardId]) => cardId)).toEqual([
      'card-1',
      'card-2',
    ]);
    expect(state.items.get('item_scheduled-replay_0')).toMatchObject({
      status: 'completed',
      cardId: 'card-1',
    });

    controls.fetchAndGenerateAptlss.mockClear();
    state.failItemWriteForCardId(null);
    const replay = await executeAptlssGenerationBatch(input);

    expect(controls.fetchAndGenerateAptlss.mock.calls.map(([cardId]) => cardId)).toEqual(['card-2']);
    expect(replay).toMatchObject({ total: 2, completed: 2, failed: 0, needsReview: 0 });
    expect(replay.results.map((result) => result.cardId)).toEqual(['card-1', 'card-2']);
    expect(state.jobs.get('scheduled-replay')).toMatchObject({
      status: 'completed',
      completedCards: 2,
      failedCards: 0,
    });
  });

  it('keeps partial card results distinct when a valid job ID uses its full database length', async () => {
    const state = createGenerationBatchDb();
    const jobId = 'j'.repeat(64);
    const input = {
      jobId,
      cardIds: ['card-1', 'card-2'],
      createdBy: 'founder-1',
      settings: { maxRetries: 1, applyToTrello: false },
    };
    controls.getDb.mockResolvedValue(state.db);
    controls.fetchAndGenerateAptlss.mockImplementation(async (cardId: string) => ({
      ...generatedChecklist,
      cardId,
    }));
    state.failItemWriteForCardId('card-2');

    await expect(executeAptlssGenerationBatch(input)).rejects.toThrow('Simulated interruption');
    expect(state.items.size).toBe(1);
    expect(state.items.values().next().value).toMatchObject({ cardId: 'card-1', status: 'completed' });

    state.failItemWriteForCardId(null);
    controls.fetchAndGenerateAptlss.mockClear();
    await executeAptlssGenerationBatch(input);

    expect(controls.fetchAndGenerateAptlss.mock.calls.map(([cardId]) => cardId)).toEqual(['card-2']);
    expect(state.items.size).toBe(2);

    controls.fetchAndGenerateAptlss.mockClear();
    await executeAptlssGenerationBatch(input);
    expect(controls.fetchAndGenerateAptlss).not.toHaveBeenCalled();
  });

  it('does not repeat a Trello write when saving its generation result fails', async () => {
    const state = createGenerationBatchDb();
    let trelloWrites = 0;
    controls.getDb.mockResolvedValue(state.db);
    controls.fetchAndGenerateAptlss.mockImplementation(
      async (cardId: string, settings: { applyToTrello?: boolean }) => {
        if (settings.applyToTrello) trelloWrites += 1;
        return { ...generatedChecklist, cardId, appliedToTrello: Boolean(settings.applyToTrello) };
      },
    );
    state.failItemWriteForCardId('card-1');
    const input = {
      jobId: 'scheduled-uncertain-write',
      cardIds: ['card-1'],
      createdBy: 'founder-1',
      settings: { maxRetries: 3 },
    };

    await expect(executeAptlssGenerationBatch(input)).rejects.toThrow('Simulated interruption');
    expect(trelloWrites).toBe(1);

    state.failItemWriteForCardId(null);
    const replay = await executeAptlssGenerationBatch(input);

    expect(trelloWrites).toBe(1);
    expect(replay).toMatchObject({ total: 1, completed: 0, failed: 1 });
    expect(replay.results[0]?.error).toContain('Verify the Trello checklist');
  });

  it('does not automatically retry a Trello write with an unknown outcome', async () => {
    const state = createGenerationBatchDb();
    let trelloCalls = 0;
    controls.getDb.mockResolvedValue(state.db);
    controls.fetchAndGenerateAptlss.mockImplementation(async () => {
      trelloCalls += 1;
      throw new Error('Trello timed out after the checklist may have been applied');
    });
    const input = {
      jobId: 'scheduled-trello-timeout',
      cardIds: ['card-1'],
      createdBy: 'founder-1',
      settings: { maxRetries: 3 },
    };

    const first = await executeAptlssGenerationBatch(input);
    expect(first).toMatchObject({ completed: 0, failed: 1 });
    expect(trelloCalls).toBe(1);
    expect(state.items.get('item_scheduled-trello-timeout_0')).toMatchObject({ status: 'outcome_unknown' });

    const replay = await executeAptlssGenerationBatch(input);
    expect(replay).toMatchObject({ completed: 0, failed: 1 });
    expect(trelloCalls).toBe(1);
  });

  it.each([
    {
      label: 'pilot-owned',
      assignments: [{ taskId: 'card-1', vaId: 9, status: 'assigned' }],
      expectedError: 'pilot worker',
    },
    {
      label: 'unassigned',
      assignments: [],
      expectedError: 'ownership is missing',
    },
    {
      label: 'ambiguous ownership',
      assignments: [
        { taskId: 'card-1', vaId: 10, status: 'assigned' },
        { taskId: 'card-1:checklist-1:item-1', vaId: 11, status: 'in_progress' },
      ],
      expectedError: 'ownership is ambiguous',
    },
  ])('does not start generation for $label cards', async ({ assignments, expectedError }) => {
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
    const state = createGenerationBatchDb(assignments);
    controls.getDb.mockResolvedValue(state.db);

    const result = await executeAptlssGenerationBatch({
      jobId: `blocked-${expectedError.replaceAll(' ', '-')}`,
      cardIds: ['card-1'],
      createdBy: 'founder-1',
      settings: { maxRetries: 3, validateBeforeGenerate: false },
    });

    expect(controls.fetchAndGenerateAptlss).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: 0, failed: 1 });
    expect(result.results[0]?.error).toContain(expectedError);
    expect(state.items.get(`item_blocked-${expectedError.replaceAll(' ', '-')}_0`)).toMatchObject({
      status: 'failed',
      attempts: 0,
    });
  });

  it('retains scheduled Trello application for one clearly assigned non-pilot worker', async () => {
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', '9');
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', 'true');
    const state = createGenerationBatchDb([
      { taskId: 'card-1:checklist-1:item-1', vaId: 10, status: 'assigned' },
    ]);
    controls.getDb.mockResolvedValue(state.db);
    controls.fetchAndGenerateAptlss.mockResolvedValue({ ...generatedChecklist, appliedToTrello: true });

    const result = await executeAptlssGenerationBatch({
      jobId: 'scheduled-non-pilot',
      cardIds: ['card-1'],
      createdBy: 'founder-1',
    });

    expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledWith(
      'card-1',
      expect.objectContaining({
        applyToTrello: true,
      }),
      undefined,
    );
    expect(result).toMatchObject({ completed: 1, failed: 0 });
  });

  it('honors an explicit opt-out from applying generated checklists to Trello', async () => {
    const state = createGenerationBatchDb();
    controls.getDb.mockResolvedValue(state.db);
    controls.fetchAndGenerateAptlss.mockResolvedValue(generatedChecklist);

    await executeAptlssGenerationBatch({
      jobId: 'scheduled-no-trello-write',
      cardIds: ['card-1'],
      createdBy: 'founder-1',
      settings: { applyToTrello: false },
    });

    expect(controls.fetchAndGenerateAptlss).toHaveBeenCalledWith(
      'card-1',
      expect.objectContaining({
        applyToTrello: false,
      }),
      undefined,
    );
  });
});
