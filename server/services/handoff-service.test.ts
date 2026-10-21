import { beforeEach, describe, expect, it, vi } from "vitest";
import { dailyBriefings, taskAssignments, users, vaProfiles } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("../db", () => ({ getDb }));

import { saveHandoffNote, getHandoffContext, generateShiftSummary } from "./handoff-service";

const actor = { id: 42, role: 'worker' as const };
function fixture(assignments: Record<string, any>[] = []) {
  const rows = new Map<unknown, any[]>([
    [users, [{ id: 42, role: 'worker' }, { id: 43, role: 'worker' }, { id: 8, role: 'admin' }, { id: 9, role: 'admin' }]],
    [vaProfiles, [{ id: 7, userId: 42, founderId: 8, status: 'active', timezone: 'UTC' },
      { id: 10, userId: 43, founderId: 9, status: 'active', timezone: 'UTC' }]],
    [taskAssignments, assignments], [dailyBriefings, []],
  ]);
  const store = timerTestDatabase(rows);
  getDb.mockResolvedValue(store.db);
  return store;
}
const task = (changes: Record<string, unknown> = {}) => ({ id: 1, founderId: 8, vaId: 7,
  taskId: 'assigned-task', status: 'assigned', handoffNotes: 'Original', lastWorkedAt: null, ...changes });

describe("saveHandoffNote", () => {
  beforeEach(() => {
    getDb.mockReset();
  });

  it("does not report success when no assignment belongs to the worker", async () => {
    const store = fixture();
    await expect(saveHandoffNote("unassigned-task", 7, "Ready for review", actor)).rejects.toMatchObject({ status: 404 });
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
  });

  it("reports success only after updating the worker-owned assignment", async () => {
    const store = fixture([task()]);
    await expect(saveHandoffNote("assigned-task", 7, "Ready for review", actor)).resolves.toBe(true);
    expect(store.rows.get(taskAssignments)![0].handoffNotes).toBe('Ready for review');
    expect(await getHandoffContext('assigned-task', actor)).toMatchObject({ notes: 'Ready for review', vaId: 7 });
  });

  it.each(['assigned', 'in_progress', 'completed', 'blocked'])('rejects duplicate rows across statuses before notes, context or briefing work (%s)', async status => {
    const store = fixture([task(), task({ id: 2, status })]);
    const before = structuredClone(store.rows.get(taskAssignments));
    await expect(saveHandoffNote('assigned-task', 7, 'New note', actor)).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_DUPLICATE' });
    await expect(getHandoffContext('assigned-task', actor)).rejects.toMatchObject({ status: 409 });
    await expect(generateShiftSummary(7, actor)).rejects.toMatchObject({ status: 409 });
    expect(store.rows.get(taskAssignments)).toEqual(before);
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
  });

  it('detects a cross-worker duplicate before ownership filtering', async () => {
    const store = fixture([task(), task({ id: 2, vaId: 999, status: 'completed' })]);
    await expect(saveHandoffNote('assigned-task', 7, 'New note', actor)).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_DUPLICATE' });
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
  });

  it('keeps identical full keys in different founder scopes independent', async () => {
    const store = fixture([task(), task({ id: 2, founderId: 9, vaId: 10, handoffNotes: 'Other founder' })]);
    await saveHandoffNote('assigned-task', 7, 'Own founder', { id: 8, role: 'admin' });
    expect(await getHandoffContext('assigned-task', { id: 8, role: 'admin' })).toMatchObject({ notes: 'Own founder' });
    expect(await getHandoffContext('assigned-task', { id: 9, role: 'admin' })).toMatchObject({ notes: 'Other founder' });
    expect(store.rows.get(taskAssignments)![1].handoffNotes).toBe('Other founder');
  });

  it('does not expose a globally matching task to a different founder', async () => {
    const store = fixture([task({ founderId: 9, vaId: 10 })]);
    await expect(getHandoffContext('assigned-task', { id: 8, role: 'admin' })).rejects.toMatchObject({ status: 404 });
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
  });

  it('persists separate checklist tasks in one shift without treating the shared card as duplicate', async () => {
    const store = fixture([task({ taskId: 'card:list:first' }), task({ id: 2, taskId: 'card:list:second' })]);
    await expect(generateShiftSummary(7, actor)).resolves.toBe(true);
    const briefing = store.rows.get(dailyBriefings)![0];
    expect(briefing).toMatchObject({ founderId: 8, vaId: 7 });
    expect(JSON.parse(briefing.content)).toMatchObject({ counts: { assigned: 2 }, handoffs: [
      { taskId: 'card:list:first' }, { taskId: 'card:list:second' },
    ] });
  });

  it('propagates unavailable storage rather than returning false or null', async () => {
    getDb.mockResolvedValue(null);
    await expect(saveHandoffNote('assigned-task', 7, 'Note', actor)).rejects.toMatchObject({ status: 503 });
    await expect(getHandoffContext('assigned-task', actor)).rejects.toMatchObject({ status: 503 });
    await expect(generateShiftSummary(7, actor)).rejects.toMatchObject({ status: 503 });
  });

  it.each(['actor', 'founder'])('rechecks current %s eligibility before generating a briefing', async identity => {
    const store = fixture([task()]);
    store.rows.get(users)!.find(row => row.id === (identity === 'actor' ? 42 : 8))!.role = 'user';
    await expect(generateShiftSummary(7, actor)).rejects.toMatchObject({ status: 403 });
    expect(store.inserts).toEqual([]); expect(store.updates).toEqual([]);
  });
});
