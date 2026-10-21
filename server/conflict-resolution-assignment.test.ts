import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  taskAssignments,
  taskScheduleHistory,
  users,
} from "../drizzle/schema.postgres";
import { timerTestDatabase } from "./test/timerDatabase";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), invalidate: vi.fn() }));
vi.mock("./db", () => ({ getDb: controls.getDb }));
vi.mock("./services/trello-cache", () => ({
  invalidateCache: controls.invalidate,
}));
import {
  detectConflicts,
  resolveConflicts,
} from "./services/conflict-resolution-service";

function assignment(id: number, changes: Record<string, unknown> = {}) {
  return {
    id,
    founderId: 7,
    taskId: `card:checklist:item-${id}`,
    vaId: 3,
    status: "assigned",
    startTime: new Date("2026-10-22T08:00:00Z"),
    endTime: new Date("2026-10-22T09:00:00Z"),
    ...changes,
  };
}
function fixture(
  assignments = [assignment(2), assignment(1)],
  failHistory = 0
) {
  let histories = 0;
  const store = timerTestDatabase(
    new Map<unknown, any[]>([
      [users, [{ id: 7, role: "admin", openId: "founder-7" }]],
      [taskAssignments, assignments],
      [taskScheduleHistory, []],
    ]),
    {
      afterInsert: table => {
        if (table === taskScheduleHistory && ++histories === failHistory)
          throw new Error("History rejected");
      },
    }
  );
  controls.getDb.mockResolvedValue(store.db);
  return store;
}
beforeEach(() => {
  vi.clearAllMocks();
  controls.invalidate.mockResolvedValue(undefined);
});

describe("atomic canonical conflict resolution", () => {
  it("permits distinct workers to occupy the same slot without changes or history", async () => {
    const f = fixture([assignment(1), assignment(2, { vaId: 5 })]);
    expect(await detectConflicts(7, 'founder-7')).toEqual([]);
    expect(await resolveConflicts(7, 'founder-7')).toMatchObject({ resolved: 0, failed: 0, conflicts: [], resolutions: [] });
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
    expect(controls.invalidate).not.toHaveBeenCalled();
  });

  it("ignores another worker's occupied slot while repairing the affected worker", async () => {
    const f = fixture([assignment(1), assignment(2), assignment(3, { vaId: 5,
      endTime: new Date('2026-10-22T12:00:00Z') })]);
    expect(await resolveConflicts(7, 'founder-7')).toMatchObject({ resolved: 1, failed: 0,
      resolutions: [{ taskId: 'card:checklist:item-1', newStartTime: new Date('2026-10-22T09:00:00Z'),
        newEndTime: new Date('2026-10-22T10:00:00Z') }] });
    expect(await detectConflicts(7, 'founder-7')).toEqual([]);
    expect(f.rows.get(taskScheduleHistory)).toHaveLength(1);
    expect(f.rows.get(taskAssignments)!.find(row => row.id === 3).endTime).toEqual(new Date('2026-10-22T12:00:00Z'));
  });

  it("rechecks duplicates at the assignment lock boundary before any write", async () => {
    const f = fixture();
    const execute = f.db.execute.getMockImplementation();
    let inserted = false;
    f.db.execute.mockImplementation(async (query: any) => {
      if (!inserted) {
        inserted = true;
        f.rows.get(taskAssignments)!.push(assignment(99, {
          taskId: "card:checklist:item-1", vaId: 8, status: "completed",
        }));
      }
      return execute(query);
    });
    await expect(resolveConflicts(7, "founder-7")).rejects.toMatchObject({ status: 409 });
    expect(f.updates).toEqual([]);
    expect(f.inserts).toEqual([]);
    expect(controls.invalidate).not.toHaveBeenCalled();
  });

  it("checks the persisted founder role under its account lock", async () => {
    const f = fixture();
    f.rows.get(users)![0].role = "worker";
    await expect(resolveConflicts(7, "founder-7")).rejects.toMatchObject({ status: 403 });
    expect(f.updates).toEqual([]);
    expect(f.inserts).toEqual([]);
  });

  it.each([
    { vaId: 8, status: "completed" },
    { vaId: 3, status: "blocked", startTime: null },
  ])(
    "rejects duplicates before schedule/status/worker filtering: %j",
    async duplicate => {
      const f = fixture([
        assignment(1),
        assignment(2, { taskId: "card:checklist:item-1", ...duplicate }),
      ]);
      await expect(detectConflicts(7, "founder-7")).rejects.toMatchObject({
        status: 409,
      });
      await expect(resolveConflicts(7, "founder-7")).rejects.toMatchObject({
        status: 409,
      });
      expect(f.updates).toEqual([]);
      expect(f.inserts).toEqual([]);
      expect(controls.invalidate).not.toHaveBeenCalled();
    }
  );

  it("locks full keys lexically before writes and preserves founder/history identities after commit", async () => {
    const f = fixture([
      assignment(2),
      assignment(1),
      assignment(3, { founderId: 9, taskId: "card:checklist:item-1" }),
    ]);
    const locks: string[] = [];
    f.db.execute.mockImplementation(async (query: any) => {
      const sql = new PgDialect().sqlToQuery(query);
      locks.push(sql.params[0] as string);
      return { rows: [] };
    });
    const update = f.db.update.getMockImplementation();
    f.db.update.mockImplementation((table: any) => {
      expect(locks).toEqual([
        JSON.stringify(["task_assignment", 7, "card:checklist:item-1"]),
        JSON.stringify(["task_assignment", 7, "card:checklist:item-2"]),
      ]);
      return update(table);
    });
    let committed = false;
    const transaction = f.db.transaction.getMockImplementation();
    f.db.transaction.mockImplementation(async (work: any) => {
      const value = await transaction(work);
      committed = true;
      return value;
    });
    controls.invalidate.mockImplementation(async () => {
      expect(committed).toBe(true);
    });
    expect(await resolveConflicts(7, "founder-7")).toMatchObject({
      resolved: 1,
      failed: 0,
    });
    expect(f.rows.get(taskScheduleHistory)).toEqual([
      expect.objectContaining({
        founderId: 7,
        assignmentId: 2,
        taskId: "card:checklist:item-2",
        changedBy: "founder-7",
        source: "conflict_resolution",
      }),
    ]);
    expect(
      f.rows.get(taskAssignments)!.find(row => row.id === 3).startTime
    ).toEqual(new Date("2026-10-22T08:00:00Z"));
    expect(controls.invalidate).toHaveBeenCalledOnce();
  });

  it("rolls back every earlier move and history if a later history write fails", async () => {
    const f = fixture([assignment(1), assignment(2), assignment(3)], 2);
    const before = structuredClone(f.rows.get(taskAssignments));
    await expect(resolveConflicts(7, "founder-7")).rejects.toThrow(
      "History rejected"
    );
    expect(f.rows.get(taskAssignments)).toEqual(before);
    expect(f.rows.get(taskScheduleHistory)).toEqual([]);
    expect(controls.invalidate).not.toHaveBeenCalled();
  });

  it.each(["wrong-open-id", "worker-7"])(
    "rejects unverified founder identity %s",
    async openId => {
      const f = fixture();
      await expect(resolveConflicts(7, openId)).rejects.toMatchObject({
        status: 403,
      });
      expect(f.updates).toEqual([]);
      expect(f.inserts).toEqual([]);
      expect(controls.invalidate).not.toHaveBeenCalled();
    }
  );

  it("locks every globally sorted key in bounded batches beyond 100 rows without truncation", async () => {
    const f = fixture(Array.from({ length: 105 }, (_, i) => assignment(105 - i,
      i < 2 ? {} : { startTime: null, endTime: null })));
    const locks: string[] = [];
    f.db.execute.mockImplementation(async (query: any) => {
      locks.push(new PgDialect().sqlToQuery(query).params[0] as string);
      return { rows: [] };
    });
    expect(await resolveConflicts(7, "founder-7")).toMatchObject({ resolved: 1, failed: 0 });
    const keys = f.rows.get(taskAssignments)!.map(row => row.taskId).sort();
    expect(locks).toEqual(keys.map(key => JSON.stringify(['task_assignment', 7, key])));
    expect(locks).toHaveLength(105);
    expect(f.rows.get(taskScheduleHistory)).toHaveLength(1);
  });

  it("rejects a duplicate beyond the first batch before any writes", async () => {
    const f = fixture([...Array.from({ length: 105 }, (_, i) => assignment(i + 1)),
      assignment(999, { taskId: 'card:checklist:item-105', vaId: 9, status: 'completed' })]);
    await expect(resolveConflicts(7, 'founder-7')).rejects.toMatchObject({ status: 409 });
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
    expect(controls.invalidate).not.toHaveBeenCalled();
  });

  it("moves past a previously disjoint task rather than introducing another collision", async () => {
    const f = fixture([
      assignment(1),
      assignment(2, { startTime: new Date('2026-10-22T08:30:00Z'), endTime: new Date('2026-10-22T09:30:00Z') }),
      assignment(3, { startTime: new Date('2026-10-22T09:30:00Z'), endTime: new Date('2026-10-22T10:30:00Z') }),
      assignment(4, { startTime: new Date('2026-10-22T10:30:00Z'), endTime: new Date('2026-10-22T11:30:00Z') }),
    ]);
    expect(await resolveConflicts(7, 'founder-7')).toMatchObject({ resolved: 1, failed: 0,
      resolutions: [{ taskId: 'card:checklist:item-1', newStartTime: new Date('2026-10-22T11:30:00Z') }] });
    expect(await detectConflicts(7, 'founder-7')).toEqual([]);
    expect(f.rows.get(taskScheduleHistory)).toHaveLength(1);
  });

  it("does not record a successful repair for unimplemented compression", async () => {
    const f = fixture();
    expect(await resolveConflicts(7, "founder-7", "compress")).toMatchObject({
      resolved: 0,
      failed: 1,
      resolutions: [],
    });
    expect(f.updates).toEqual([]);
    expect(f.inserts).toEqual([]);
    expect(controls.invalidate).not.toHaveBeenCalled();
  });
});
