import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generationItems, generationJobs, scheduledJobs, users } from '../../drizzle/schema.postgres';
import { timerTestDatabase, type TestRow } from '../test/timerDatabase';
import { ScheduledJobLeaseLostError, type ScheduledJobContext } from '../scheduledJobRuntime';

const controls = vi.hoisted(() => ({ getDb: vi.fn(), run: vi.fn(), generate: vi.fn() }));
vi.mock('../db', () => ({ getDb: controls.getDb }));
vi.mock('../scheduledJobRuntime', async (original) => ({
  ...(await original<typeof import('../scheduledJobRuntime')>()),
  runScheduledJob: controls.run,
}));
vi.mock('./aptlss-generation', () => ({ fetchAndGenerateAptlss: controls.generate }));
import {
  approvalSnapshotHash,
  assertScheduledGenerationApproval,
  createScheduledGenerationApprovalContext,
  holdScheduledGenerationForApproval,
  parseScheduledGenerationApproval,
  ScheduledGenerationApprovalError,
} from './aptlss-scheduled-approval';
import { processDueAptlssGenerationJobs } from './aptlss-scheduled-generation';

const now = new Date('2026-10-21T10:00:00.000Z');
const actor = () => ({ id: 41, openId: 'founder-41', role: 'admin', sessionEpoch: '9007199254740993' });
function approvedJob(id = 'schedule-1') {
  const row = {
    id,
    createdBy: 'founder-41',
    cardIds: '["card-b","card-a"]',
    settings: '{"applyToTrello":false}',
    status: 'pending',
    scheduledTime: new Date(now.getTime() - 10_000),
    completedAt: null,
    error: null,
    approvedByUserId: 41,
    approvedSessionEpoch: '9007199254740993',
    approvedAt: new Date(now.getTime() - 20_000),
  };
  return { ...row, approvalHash: approvalSnapshotHash(row) };
}
const lease = (): ScheduledJobContext => ({
  signal: new AbortController().signal,
  assertOwnership: vi.fn().mockResolvedValue(undefined),
});
const reason = () => new ScheduledGenerationApprovalError('creator_epoch_changed');
function fixture(jobs: TestRow[] = [approvedJob()]) {
  const rows = new Map<unknown, TestRow[]>([
    [users, [actor()]],
    [scheduledJobs, jobs],
    [generationJobs, []],
    [generationItems, []],
  ]);
  const f = timerTestDatabase(rows);
  // Model the actual conflict target in the canonical batch writer, without mocking its control flow.
  const insert = f.db.insert;
  f.db.insert = vi.fn((table: unknown) => ({
    values: (value: TestRow) => ({
      onConflictDoUpdate: async ({ set, target }: { set: TestRow; target: { name: string } }) => {
        const existing = (rows.get(table) ?? []).find((row) => row[target.name] === value[target.name]);
        if (existing) Object.assign(existing, set);
        else await insert(table).values(value);
      },
    }),
  }));
  controls.getDb.mockResolvedValue(f.db);
  return { ...f, job: (id = 'schedule-1') => rows.get(scheduledJobs)!.find((row) => row.id === id)! };
}
beforeEach(() => {
  vi.clearAllMocks();
  controls.run.mockImplementation(async (_options, work) => {
    await work(lease());
    return { state: 'success' };
  });
  controls.generate.mockImplementation(async (cardId) => ({
    success: true,
    cardId,
    aptlss: { summary: 'Synthetic output' },
    validation: { needsReview: false },
    appliedToTrello: false,
  }));
});

describe('scheduled approval integrity and fresh authority', () => {
  it('canonicalizes nested settings and card order without changing the frozen input', () => {
    const row = approvedJob();
    row.settings = '{"z":{"b":2,"a":1},"a":false}';
    const equivalent = { ...row, cardIds: '["card-a","card-b"]', settings: '{"a":false,"z":{"a":1,"b":2}}' };
    expect(approvalSnapshotHash(row)).toBe(approvalSnapshotHash(equivalent));
    expect(row.cardIds).toBe('["card-b","card-a"]');
  });
  it.each([
    { id: 'another-job' },
    { createdBy: 'another-owner' },
    { cardIds: '["card-c"]' },
    { settings: '{"applyToTrello":true}' },
    { scheduledTime: new Date(now.getTime() + 1) },
    { approvedByUserId: 42 },
    { approvedSessionEpoch: '9007199254740994' },
    { approvedAt: now },
  ])('rejects an altered bound field %#', (change) => {
    expect(() => parseScheduledGenerationApproval({ ...approvedJob(), ...change })).toThrow(
      ScheduledGenerationApprovalError,
    );
  });
  it.each([
    { approvedByUserId: null },
    { approvedAt: null },
    { approvedSessionEpoch: '01' },
    { approvedSessionEpoch: '-1' },
    { cardIds: '["card-a","card-a"]' },
    { cardIds: '[" card-a"]' },
    { cardIds: 'null' },
    { settings: '[]' },
    { settings: 'invalid' },
    { approvalHash: '0'.repeat(64) },
    { approvedByUserId: null, settings: '{"_approval":{"approvedByUserId":41}}' },
  ])('fails closed for incomplete or malformed proof %#', (change) => {
    expect(() => parseScheduledGenerationApproval({ ...approvedJob(), ...change })).toThrow(
      ScheduledGenerationApprovalError,
    );
  });
  it.each([
    ['creator_missing', null],
    ['creator_identity_changed', { openId: 'replaced' }],
    ['creator_not_admin', { role: 'worker' }],
    ['creator_epoch_changed', { sessionEpoch: '9007199254740994' }],
  ])('requires fresh actor authority: %s', async (expected, changed) => {
    const f = fixture();
    f.rows.set(users, changed ? [{ ...actor(), ...changed }] : []);
    await expect(assertScheduledGenerationApproval(approvedJob(), f.db)).rejects.toMatchObject({
      reason: expected,
    });
    expect(controls.getDb).not.toHaveBeenCalled();
  });
  it('uses the supplied connection without locks or a nested checkout; ordinary logout is not an epoch change', async () => {
    const f = fixture();
    f.rows.get(users)![0].revokedSessionJti = 'synthetic-logout';
    await expect(assertScheduledGenerationApproval(approvedJob(), f.db)).resolves.toMatchObject({
      approvedByUserId: 41,
    });
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(controls.getDb).not.toHaveBeenCalled();
  });
});

describe('approval write and hold fencing', () => {
  it.each(['completed', 'needs_review', 'completed_with_errors', 'failed'])(
    'permits its own %s persistence but not further provider work',
    async (status) => {
      const f = fixture();
      const owner = lease();
      const scope = createScheduledGenerationApprovalContext(approvedJob(), owner, f.db);
      await scope.write(async (tx) => {
        await tx.update(scheduledJobs).set({ status }).where(undefined!);
      });
      expect(f.job().status).toBe(status);
      await expect(scope.context.assertOwnership()).rejects.toMatchObject({ reason: 'approval_changed' });
      expect(owner.signal.aborted).toBe(false);
    },
  );
  it('rolls back writes on post-action epoch change and retains a typed approval reason', async () => {
    const f = fixture();
    const owner = lease();
    const scope = createScheduledGenerationApprovalContext(approvedJob(), owner, f.db);
    await expect(
      scope.write(async (tx) => {
        await tx.update(scheduledJobs).set({ status: 'completed' }).where(undefined!);
        f.rows.get(users)![0].sessionEpoch = '9007199254740994';
      }),
    ).rejects.toMatchObject({ reason: 'creator_epoch_changed' });
    expect(f.job().status).toBe('pending');
    expect(scope.failure).toBeInstanceOf(ScheduledGenerationApprovalError);
    expect(owner.signal.aborted).toBe(false);
  });
  it('holds using lease-only authority after a sticky approval error, without touching generation history', async () => {
    const f = fixture();
    const owner = lease();
    const original = approvedJob();
    const scope = createScheduledGenerationApprovalContext(original, owner, f.db);
    f.rows.get(users)![0].sessionEpoch = '9007199254740994';
    await expect(scope.context.assertOwnership()).rejects.toMatchObject({ reason: 'creator_epoch_changed' });
    expect(await holdScheduledGenerationForApproval(original, scope.failure!, owner, f.db)).toBe(true);
    expect(f.job()).toMatchObject({ status: 'awaiting_approval', completedAt: null });
    expect(f.rows.get(generationItems)).toEqual([]);
    expect(f.rows.get(generationJobs)).toEqual([]);
  });
  it.each(['approved', 'legacy', 'changed-source'])(
    'does not clobber a concurrently replaced %s approval',
    async (variant) => {
      const original: TestRow = approvedJob();
      if (variant !== 'approved')
        Object.assign(original, {
          approvedByUserId: null,
          approvedAt: null,
          approvedSessionEpoch: null,
          approvalHash: null,
        });
      const f = fixture([structuredClone(original)]);
      if (variant === 'changed-source') f.job().settings = '{"applyToTrello":true}';
      else
        Object.assign(f.job(), approvedJob(), { approvedAt: now, approvedSessionEpoch: '9007199254740994' });
      const fresh = structuredClone(f.job());
      expect(await holdScheduledGenerationForApproval(original as any, reason(), lease(), f.db)).toBe(false);
      expect(f.job()).toEqual(fresh);
    },
  );
  it('cannot hold or write after true lease loss, even when an approval reason was already captured', async () => {
    const f = fixture();
    const owner = lease();
    const scope = createScheduledGenerationApprovalContext(approvedJob(), owner, f.db);
    f.rows.get(users)![0].role = 'worker';
    await expect(scope.context.assertOwnership()).rejects.toBeInstanceOf(ScheduledGenerationApprovalError);
    vi.mocked(owner.assertOwnership).mockRejectedValue(new ScheduledJobLeaseLostError());
    await expect(
      holdScheduledGenerationForApproval(approvedJob(), scope.failure!, owner, f.db),
    ).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(f.job().status).toBe('pending');
  });
  it('does not rewrite an already completed job as an approval hold', async () => {
    const f = fixture();
    f.job().status = 'completed';
    expect(await holdScheduledGenerationForApproval(approvedJob(), reason(), lease(), f.db)).toBe(false);
    expect(f.job().status).toBe('completed');
    expect(f.updates).toEqual([]);
  });
});

describe('due worker approval lifecycle', () => {
  it.each(['completed', 'needs_review', 'completed_with_errors'])(
    'finishes a real canonical batch as %s',
    async (status) => {
      const f = fixture();
      if (status === 'needs_review')
        controls.generate.mockImplementation(async (cardId) => ({
          success: true,
          cardId,
          aptlss: { summary: 'Synthetic output' },
          validation: { needsReview: true },
          appliedToTrello: false,
        }));
      if (status === 'completed_with_errors')
        controls.generate.mockImplementation(async (cardId) => {
          if (cardId === 'card-a') throw new Error('Synthetic model failure');
          return {
            success: true,
            cardId,
            aptlss: { summary: 'Synthetic output' },
            validation: { needsReview: false },
            appliedToTrello: false,
          };
        });
      const result = await processDueAptlssGenerationJobs(now);
      expect(result).toMatchObject({ processed: 1, failed: 0, awaitingApproval: 0 });
      expect(f.job()).toMatchObject({ status, completedAt: expect.any(Date) });
      expect(f.rows.get(generationItems)).toHaveLength(2);
      if (status === 'completed_with_errors')
        expect(f.rows.get(generationJobs)).toMatchObject([{ completedCards: 1, failedCards: 1 }]);
    },
  );
  it('does not retain persistence transactions across generation, and passes through the active reader', async () => {
    const f = fixture();
    let insideWrite = false;
    const transaction = f.db.transaction;
    f.db.transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      insideWrite = true;
      try {
        return await transaction(work);
      } finally {
        insideWrite = false;
      }
    });
    controls.generate.mockImplementation(async (cardId, _settings, context) => {
      expect(insideWrite).toBe(false);
      const checkouts = controls.getDb.mock.calls.length;
      await context.assertOwnership(f.db);
      expect(controls.getDb.mock.calls.length).toBe(checkouts);
      expect(insideWrite).toBe(false);
      return {
        success: true,
        cardId,
        aptlss: { summary: 'Synthetic output' },
        validation: { needsReview: false },
        appliedToTrello: false,
      };
    });
    expect(await processDueAptlssGenerationJobs(now)).toMatchObject({ processed: 1 });
    expect(controls.generate).toHaveBeenCalledTimes(2);
  });
  it('holds a legacy pending job without inference and continues an unrelated approved job', async () => {
    const legacy = {
      ...approvedJob('legacy'),
      approvedByUserId: null,
      approvedAt: null,
      approvedSessionEpoch: null,
      approvalHash: null,
    };
    const f = fixture([legacy, approvedJob()]);
    expect(await processDueAptlssGenerationJobs(now)).toMatchObject({
      awaitingApproval: 1,
      processed: 1,
      failed: 0,
    });
    expect(f.job('legacy').status).toBe('awaiting_approval');
    expect(controls.generate).toHaveBeenCalledTimes(2);
    expect(f.rows.get(generationItems)!.every((row) => row.jobId === 'schedule-1')).toBe(true);
  });
  it('holds post-provider revocation without saving its result or dispatching the next card', async () => {
    const f = fixture();
    controls.generate.mockImplementation(async () => {
      f.rows.get(users)![0].sessionEpoch = '9007199254740994';
      return {
        success: true,
        cardId: 'card-b',
        aptlss: { summary: 'Rejected stale result' },
        validation: { needsReview: false },
      };
    });
    expect(await processDueAptlssGenerationJobs(now)).toMatchObject({
      awaitingApproval: 1,
      processed: 0,
      failed: 0,
    });
    expect(f.job()).toMatchObject({ status: 'awaiting_approval', completedAt: null });
    expect(f.rows.get(generationItems)).toEqual([]);
    expect(controls.generate).toHaveBeenCalledTimes(1);
  });
  it('retains the approval reason when a downstream ownership wrapper converts it to lease loss', async () => {
    const f = fixture();
    controls.generate.mockImplementation(async (_card, _settings, context) => {
      f.rows.get(users)![0].role = 'worker';
      try {
        await context.assertOwnership();
      } catch {
        throw new ScheduledJobLeaseLostError();
      }
    });
    expect(await processDueAptlssGenerationJobs(now)).toMatchObject({ awaitingApproval: 1, failed: 0 });
    expect(f.job().error).toContain('creator_not_admin');
  });
  it('does not continue other due jobs or hold state on real lease loss', async () => {
    const f = fixture([approvedJob(), approvedJob('second')]);
    controls.generate.mockRejectedValue(new ScheduledJobLeaseLostError());
    await expect(processDueAptlssGenerationJobs(now)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(f.job().status).toBe('running');
    expect(f.job('second').status).toBe('pending');
    expect(controls.generate).toHaveBeenCalledTimes(1);
  });
  it('preserves unknown Trello outcomes through approval hold and explicit reapproval', async () => {
    const row = approvedJob();
    row.settings = '{"applyToTrello":true}';
    row.approvalHash = approvalSnapshotHash(row);
    const f = fixture([row]);
    controls.generate.mockImplementation(async () => {
      f.rows.get(users)![0].sessionEpoch = '9007199254740994';
      throw new Error('Synthetic post-dispatch interruption');
    });
    await processDueAptlssGenerationJobs(now);
    expect(f.rows.get(generationItems)).toMatchObject([{ status: 'outcome_unknown' }]);
    Object.assign(f.job(), { status: 'pending', approvedSessionEpoch: '9007199254740994', approvedAt: now });
    f.job().approvalHash = approvalSnapshotHash(f.job() as any);
    controls.generate.mockClear();
    await processDueAptlssGenerationJobs(now);
    expect(controls.generate).not.toHaveBeenCalledWith('card-b', expect.anything(), expect.anything());
    expect(f.rows.get(generationItems)!.find((row) => row.cardId === 'card-b')!.status).toBe(
      'outcome_unknown',
    );
  });
});
