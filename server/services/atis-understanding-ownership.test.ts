import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader } from '../scheduledJobRuntime';
import { processAllCardsUnderstanding, processCardUnderstanding, processCardUnderstandingOutcome } from './atis-understanding';
import { codexLlmFixture } from '../test/codexLlmFixture';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), invokeLLM: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../_core/llm', () => ({ invokeLLM: mocks.invokeLLM }));

const understanding = {
  goal: 'Review the retained report', deliverable: 'Reviewed report', taskType: 'review',
  entities: { people: [], organizations: [], cases: [], systems: [], documents: [] },
  deadlines: [], estimatedMinutes: 30, dependencies: [], produces: [], domain: 'General',
  complexity: 'simple', clarityScore: 8, missingInfo: [], confidenceScore: 90,
  aptlssChecklist: [{ name: '[P] Process - Review the report', estimatedMinutes: 30, priority: 'P' }],
};
const cards = [
  { id: 1, trelloId: 'card0001', boardId: 10, name: 'First report', description: 'Review this report' },
  { id: 2, trelloId: 'card0002', boardId: 10, name: 'Second report', description: 'Review this report' },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(existing = false, missing = false) {
  const events: string[] = [];
  const saved: Array<Record<string, unknown>> = [];
  let staged: Array<Record<string, unknown>> | undefined;
  let readCard = 0;
  let batchRead = 0;
  const hooks = { onUnderstandingRead: () => {}, onWrite: () => {} };
  const write = (kind: string, data: Record<string, unknown>) => {
    events.push(kind);
    (staged ?? saved).push(data);
    hooks.onWrite();
    return Promise.resolve();
  };
  function select() {
    let table: Parameters<typeof getTableName>[0];
    let batch = false;
    const query = {
      from(value: typeof table) { table = value; return query; },
      where() { return query; }, limit() { return query; }, orderBy() { return query; },
      leftJoin() { batch = true; return query; },
      then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve().then(() => {
          const name = getTableName(table);
          if (batch) return batchRead++ === 0 ? cards : [];
          if (name === 'atis_cards') return missing ? [] : [cards[readCard++]];
          if (name === 'atis_boards') return [{ name: 'Fixture board' }];
          if (name === 'atis_card_understanding') {
            events.push('read-understanding');
            hooks.onUnderstandingRead();
            return existing ? [{ id: 40 }] : [];
          }
          return [];
        }).then(resolve, reject);
      },
    };
    return query;
  }
  const mutations = (transaction: boolean) => {
    const persist = (kind: string, data: Record<string, unknown>) => {
      if (Boolean(staged) !== transaction) throw new Error('Understanding write used the wrong database connection');
      return write(kind, data);
    };
    return {
      insert: vi.fn(() => ({ values: (data: Record<string, unknown>) => persist('insert', data) })),
      update: vi.fn(() => ({ set: (data: Record<string, unknown>) => ({ where: () => persist('update', data) }) })),
    };
  };
  const tx = { select, ...mutations(true) };
  const db = {
    select,
    ...mutations(false),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<void>) => {
      events.push('begin');
      staged = [];
      try {
        await work(tx);
        saved.push(...staged);
        events.push('commit');
      } catch (error) {
        events.push('rollback');
        throw error;
      } finally { staged = undefined; }
    }),
  };
  const controller = new AbortController();
  const assertOwnership = vi.fn(async (transaction?: ScheduledJobOwnershipReader) => {
    events.push(transaction === (tx as unknown) ? 'assert-tx' : 'assert');
    if (controller.signal.aborted) throw new ScheduledJobLeaseLostError();
  });
  const context: ScheduledJobContext = { signal: controller.signal, assertOwnership };
  mocks.getDb.mockResolvedValue(db);
  return { db, tx, context, controller, assertOwnership, events, saved, hooks };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(understanding) } }] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('ATIS understanding ownership', () => {
  it('persists actual subscription-backed generated output with both guidance and transactional ownership', async () => {
    const state = fixture();
    const bridge = await codexLlmFixture({ turns: [{ answer: JSON.stringify(understanding) }] });
    const actual = await vi.importActual<typeof import('../_core/llm')>('../_core/llm');
    mocks.invokeLLM.mockImplementation(actual.invokeLLM);
    try {
      expect(await processCardUnderstandingOutcome(1, { context: state.context, guidance: { goal: 'Checked subscription goal' } }))
        .toEqual({ kind: 'generated', understanding });
      const calls = await bridge.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0].input.conversation[1].content).toContain('Checked subscription goal');
      expect(state.saved).toHaveLength(1);
      expect(state.events).toContain('assert-tx');
      expect(state.events.at(-1)).toBe('commit');
    } finally { await bridge.close(); }
  });

  it('discards an actual subscription completion after authority changes while the model is running', async () => {
    const state = fixture(); let revoked = false;
    const lost = new ScheduledJobLeaseLostError();
    state.assertOwnership.mockImplementation(async () => { if (revoked) throw lost; });
    const bridge = await codexLlmFixture({ turns: [{ answer: JSON.stringify(understanding), hold: true }] });
    const actual = await vi.importActual<typeof import('../_core/llm')>('../_core/llm');
    mocks.invokeLLM.mockImplementation(actual.invokeLLM);
    try {
      const pending = processCardUnderstandingOutcome(1, { context: state.context });
      const rejected = expect(pending).rejects.toBe(lost);
      await bridge.waitFile('calls.jsonl'); revoked = true;
      await bridge.release('allow-turn'); await rejected;
      expect(state.saved).toEqual([]);
      expect(state.db.transaction).not.toHaveBeenCalled();
      expect(await bridge.calls()).toHaveLength(1);
    } finally { await bridge.close(); }
  });

  it.each(['role', 'sessionEpoch', 'lease'])('refuses actual LLM dispatch after %s revocation during subscription readiness', async () => {
    const state = fixture();
    let revoked = false;
    const lost = new ScheduledJobLeaseLostError();
    state.assertOwnership.mockImplementation(async () => { if (revoked) throw lost; });
    const bridge = await codexLlmFixture({ holdLogin: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const actual = await vi.importActual<typeof import('../_core/llm')>('../_core/llm');
    mocks.invokeLLM.mockImplementation(actual.invokeLLM);
    try {
      const pending = processCardUnderstandingOutcome(1, { context: state.context, guidance: { goal: 'Keep this guidance' } });
      const rejection = expect(pending).rejects.toBe(lost);
      await bridge.waitFile('login-ready');
      revoked = true;
      await bridge.release('allow-login');
      await rejection;
      expect(await bridge.calls()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.saved).toEqual([]);
      expect(state.db.transaction).not.toHaveBeenCalled();
    } finally { await bridge.close(); }
  });
  it('passes guidance and scheduled context together through the model and fenced writes', async () => {
    const state = fixture();
    const guidance = { goal: 'Compare both source reports', deliverable: 'A checked comparison', successCriteria: ['Cite both sources'] };
    expect(await processCardUnderstandingOutcome(1, { context: state.context, guidance }))
      .toEqual({ kind: 'generated', understanding });
    const prompt = mocks.invokeLLM.mock.calls[0][0].messages[1].content;
    for (const text of [guidance.goal, guidance.deliverable, guidance.successCriteria[0]]) expect(prompt).toContain(text);
    expect(state.events.slice(state.events.indexOf('begin')))
      .toEqual(['begin', 'assert-tx', 'read-understanding', 'assert-tx', 'insert', 'assert-tx', 'commit']);
    expect(state.db.insert).not.toHaveBeenCalled();
  });

  it('reports generated even when a valid model result has low confidence', async () => {
    const state = fixture();
    mocks.invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...understanding, confidenceScore: 20 }) } }] });
    expect(await processCardUnderstandingOutcome(1, { context: state.context }))
      .toMatchObject({ kind: 'generated', understanding: { confidenceScore: 20 } });
    expect(state.saved).toHaveLength(1);
  });

  it('explicitly reports provider fallback only after committing its fenced record', async () => {
    const state = fixture();
    mocks.invokeLLM.mockRejectedValue(new Error('Fixture provider failure'));
    expect(await processCardUnderstandingOutcome(1, { context: state.context, guidance: { goal: 'Checked goal' } }))
      .toMatchObject({ kind: 'fallback', understanding: { confidenceScore: 20 } });
    expect(state.saved).toHaveLength(1);
    expect(state.events.at(-1)).toBe('commit');
  });

  it('reports missing without a provider call or a persisted success', async () => {
    const state = fixture(false, true);
    expect(await processCardUnderstandingOutcome(999, { context: state.context })).toEqual({ kind: 'missing', understanding: null });
    expect(mocks.invokeLLM).not.toHaveBeenCalled(); expect(state.saved).toEqual([]);
  });
  it('does not count a disappeared card as processed through the legacy batch wrapper', async () => {
    vi.useFakeTimers();
    const state = fixture(false, true);
    const progress = vi.fn();
    const pending = processAllCardsUnderstanding(progress, 2, state.context);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ processed: 0, failed: 2 });
    expect(progress.mock.calls.filter(([item]) => item.status === 'failed')).toHaveLength(2);
    expect(mocks.invokeLLM).not.toHaveBeenCalled(); expect(state.saved).toEqual([]);
  });

  it('does not permit a missing ownership context on the new outcome API', async () => {
    await expect(processCardUnderstandingOutcome(1, {} as any)).rejects.toThrow('scheduled ownership context');
    expect(mocks.getDb).not.toHaveBeenCalled(); expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });

  it.each([new ScheduledJobLeaseLostError(), new DOMException('Cancelled', 'AbortError')])
    ('does not save generated or fallback results after model-time ownership loss: %s', async error => {
      const state = fixture();
      mocks.invokeLLM.mockImplementation(async () => {
        state.assertOwnership.mockRejectedValue(error);
        return { choices: [{ message: { content: JSON.stringify(understanding) } }] };
      });
      await expect(processCardUnderstandingOutcome(1, { context: state.context, guidance: { goal: 'A scoped goal' } })).rejects.toBe(error);
      expect(mocks.invokeLLM).toHaveBeenCalledOnce();
      expect(state.db.transaction).not.toHaveBeenCalled(); expect(state.saved).toEqual([]);
    });

  it('does not read or call the provider after cancellation', async () => {
    const state = fixture();
    state.controller.abort();
    await expect(processCardUnderstanding(1, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(state.saved).toEqual([]);
  });

  it('checks ownership again immediately before the provider call', async () => {
    const state = fixture();
    let checks = 0;
    state.assertOwnership.mockImplementation(async () => {
      if (++checks === 3) throw new ScheduledJobLeaseLostError();
    });
    await expect(processCardUnderstanding(1, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(state.db.transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])('fences %s-existing understanding writes through commit', async existing => {
    const state = fixture(existing);
    expect(await processCardUnderstanding(1, state.context)).toEqual(understanding);
    const events = state.events.slice(state.events.indexOf('begin'));
    expect(events).toEqual(['begin', 'assert-tx', 'read-understanding', 'assert-tx', existing ? 'update' : 'insert', 'assert-tx', 'commit']);
    expect(state.saved[0]).toMatchObject({ cardId: 1, goal: understanding.goal, confidenceScore: 90 });
    expect(state.db.transaction).toHaveBeenCalledOnce();
  });

  it('does not write when cancellation happens during the transaction read', async () => {
    const state = fixture();
    state.hooks.onUnderstandingRead = () => state.controller.abort();
    await expect(processCardUnderstanding(1, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.events).not.toContain('insert');
    expect(state.events).toContain('rollback');
    expect(state.saved).toEqual([]);
  });

  it('rolls back a staged write when cancellation happens before commit', async () => {
    const state = fixture();
    state.hooks.onWrite = () => state.controller.abort();
    await expect(processCardUnderstanding(1, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.events).toContain('insert');
    expect(state.events).not.toContain('commit');
    expect(state.saved).toEqual([]);
  });

  it('keeps ordinary provider failures as fenced low-confidence fallbacks', async () => {
    const state = fixture();
    mocks.invokeLLM.mockRejectedValue(new Error('Fixture provider failure'));
    expect(await processCardUnderstanding(1, state.context)).toMatchObject({ confidenceScore: 20 });
    expect(state.saved[0]).toMatchObject({ confidenceScore: 20, goal: 'Complete task: First report' });
    expect(state.events.slice(-3)).toEqual(['insert', 'assert-tx', 'commit']);
  });

  it('does not save fallback when a provider failure coincides with cancellation', async () => {
    const state = fixture();
    mocks.invokeLLM.mockImplementation(async () => {
      state.controller.abort();
      throw new Error('Fixture provider failure');
    });
    await expect(processCardUnderstanding(1, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.db.transaction).not.toHaveBeenCalled();
    expect(state.saved).toEqual([]);
  });

  it.each([new ScheduledJobLeaseLostError(), new DOMException('Cancelled', 'AbortError')])('propagates cancellation errors instead of fallback: %s', async error => {
    const state = fixture();
    mocks.invokeLLM.mockRejectedValue(error);
    await expect(processCardUnderstanding(1, state.context)).rejects.toBe(error);
    expect(state.saved).toEqual([]);
  });

  it('discards an in-flight LLM result and stops the next card after cancellation', async () => {
    const state = fixture();
    const started = deferred();
    const finish = deferred();
    mocks.invokeLLM.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return { choices: [{ message: { content: JSON.stringify(understanding) } }] };
    });
    const progress = vi.fn();
    const processing = processAllCardsUnderstanding(progress, 2, state.context);
    const rejected = expect(processing).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    await started.promise;
    state.controller.abort();
    finish.resolve();
    await rejected;
    expect(mocks.invokeLLM).toHaveBeenCalledOnce();
    expect(state.saved).toEqual([]);
    expect(progress.mock.calls.map(([value]) => value.status)).toEqual(['processing']);
  });

  it('stops the batch when ownership is lost without an aborted signal during provider failure', async () => {
    const state = fixture();
    let lost = false;
    state.assertOwnership.mockImplementation(async () => {
      if (lost) throw new ScheduledJobLeaseLostError();
    });
    mocks.invokeLLM.mockImplementation(async () => {
      lost = true;
      throw new Error('Fixture provider failure');
    });
    const progress = vi.fn();
    await expect(processAllCardsUnderstanding(progress, 2, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.controller.signal.aborted).toBe(false);
    expect(mocks.invokeLLM).toHaveBeenCalledOnce();
    expect(state.db.transaction).not.toHaveBeenCalled();
    expect(progress.mock.calls.map(([value]) => value.status)).toEqual(['processing']);
  });

  it('awaits asynchronous processing and success progress before starting another card', async () => {
    vi.useFakeTimers();
    const state = fixture();
    const processingSeen = deferred();
    const processingRelease = deferred();
    const successSeen = deferred();
    const successRelease = deferred();
    const progress = vi.fn(async (value: { current: number; status: string }) => {
      if (value.current !== 1) return;
      if (value.status === 'processing') { processingSeen.resolve(); await processingRelease.promise; }
      if (value.status === 'success') { successSeen.resolve(); await successRelease.promise; }
    });
    const processing = processAllCardsUnderstanding(progress, 2, state.context);
    await processingSeen.promise;
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    processingRelease.resolve();
    await successSeen.promise;
    expect(mocks.invokeLLM).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    successRelease.resolve();
    await vi.runAllTimersAsync();
    expect(await processing).toEqual({ processed: 2, failed: 0 });
    expect(mocks.invokeLLM).toHaveBeenCalledTimes(2);
    expect(state.saved).toHaveLength(2);
  });

  it('propagates progress cancellation without starting the next card', async () => {
    const state = fixture();
    const cancelled = new DOMException('Cancelled progress', 'AbortError');
    await expect(processAllCardsUnderstanding(async () => { throw cancelled; }, 2, state.context)).rejects.toBe(cancelled);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(state.saved).toEqual([]);
  });

  it('awaits failure progress before continuing an ordinary per-card failure', async () => {
    vi.useFakeTimers();
    const state = fixture();
    mocks.getDb.mockResolvedValueOnce(state.db).mockRejectedValueOnce(new Error('Fixture card read failure'));
    const failureSeen = deferred();
    const failureRelease = deferred();
    const progress = vi.fn(async (value: { status: string }) => {
      if (value.status === 'failed') { failureSeen.resolve(); await failureRelease.promise; }
    });
    const processing = processAllCardsUnderstanding(progress, 2, state.context);
    await failureSeen.promise;
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    failureRelease.resolve();
    await vi.runAllTimersAsync();
    expect(await processing).toEqual({ processed: 1, failed: 1 });
    expect(mocks.invokeLLM).toHaveBeenCalledOnce();
    expect(progress.mock.calls.map(([value]) => value.status)).toEqual(['processing', 'failed', 'processing', 'success']);
  });

  it('preserves unguarded callers and interview guidance without requiring a transaction', async () => {
    const state = fixture();
    expect(await processCardUnderstanding(1, { goal: 'Clarified interview goal' })).toEqual(understanding);
    expect(mocks.invokeLLM.mock.calls[0][0].messages[1].content).toContain('Clarified interview goal');
    expect(state.db.transaction).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(1);
    expect(state.assertOwnership).not.toHaveBeenCalled();
  });
});
