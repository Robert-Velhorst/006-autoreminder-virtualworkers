import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
import { aptlssManagerChecks, aptlssManagerRuns, aptlssManagerState, aptlssPlans, aptlssWaitingReasons, cardStates, emailTasks, taskAssignments, timeEntries, users, vaProfiles } from "../../drizzle/schema.postgres";
import { managerHistoryHash } from "../aptlssManagerHistory";
import { readManagerAssignmentState } from "../aptlssManagerAssignments";
import { WORKER_EXECUTION_HOLD_MESSAGE } from "../../shared/aptlssManager";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getActiveWorkerProfileId: vi.fn(),
  getActiveWorkerProfileResolution: vi.fn(),
  isManagerPilotWorker: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../workerOperatorContext", async importOriginal => ({
  ...(await importOriginal<typeof import("../workerOperatorContext")>()),
  getActiveWorkerProfileId: mocks.getActiveWorkerProfileId,
  getActiveWorkerProfileResolution: mocks.getActiveWorkerProfileResolution,
}));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));
vi.mock("../aptlssManagerQueue", () => ({ enqueueManagerTask: vi.fn() }));

import { emailInboxRouter, timerRouter } from "./manus";

type EmailRow = {
  id: number;
  vaId: number;
  gmailMessageId: string;
  gmailThreadId: string;
  subject: string;
  status: string;
  [key: string]: unknown;
};

function makeDb(initialRows: EmailRow[], beforeInsert?: (rows: EmailRow[], values: Record<string, unknown>) => void) {
  const rows = initialRows.map(row => ({ ...row }));
  let nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      let rowLimit = Number.POSITIVE_INFINITY;
      const query: any = {
        from(value: unknown) { table = value; return query; },
        where() { return query; },
        limit(value: number) { rowLimit = value; return query; },
        for() { return Promise.resolve(table === emailTasks ? rows.slice(0, rowLimit) : []); },
      };
      return query;
    }),
    insert: vi.fn(() => ({
      values(values: Record<string, unknown>) {
        return { onConflictDoNothing: () => ({ returning: async () => {
          beforeInsert?.(rows, values);
          if (rows.some(row => row.gmailMessageId === values.gmailMessageId)) return [];
          const created = { id: nextId++, ...values } as EmailRow;
          rows.push(created);
          return [{ id: created.id }];
        } }) };
      },
    })),
    update: vi.fn(() => ({
      set(values: Record<string, unknown>) {
        return {
          where: async () => {
            const row = rows.find(candidate => candidate.vaId === 10);
            if (row) Object.assign(row, values);
            return { rowCount: row ? 1 : 0 };
          },
        };
      },
    })),
    transaction: vi.fn(async (run: (database: any) => Promise<unknown>) => run(tx)),
  };
  return { db: tx, rows };
}

function caller(id: number, role: "worker" | "user" = "worker") {
  return emailInboxRouter.createCaller({
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id, openId: `test-${id}`, role } as TrpcContext["user"],
  } as TrpcContext);
}

function batch(subject: string, status: "pending" | "processed" | "archived" = "pending") {
  return [{
    gmailMessageId: "shared-message-id",
    gmailThreadId: "thread-from-request",
    subject,
    fromAddress: "sender@example.test",
    fromName: "Sender",
    snippet: "request-controlled content",
    receivedAt: new Date("2026-09-26T10:00:00.000Z"),
    category: "financial" as const,
    status,
  }];
}

function matchesWhere(row: Record<string, unknown>, condition: unknown): boolean {
  const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const nestedSql = chunks.filter((chunk): chunk is { queryChunks: unknown[] } =>
    typeof chunk === "object" && chunk !== null && "queryChunks" in chunk
      && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)
  );
  if (nestedSql.length) {
    const operators = chunks.flatMap(chunk => {
      if (typeof chunk !== "object" || chunk === null || !("value" in chunk)) return [];
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
    }).join("");
    return /\bor\b/i.test(operators)
      ? nestedSql.some(child => matchesWhere(row, child))
      : nestedSql.every(child => matchesWhere(row, child));
  }

  const column = chunks.find((chunk): chunk is { name: string; table: unknown } =>
    typeof chunk === "object" && chunk !== null && "name" in chunk && "table" in chunk
      && typeof (chunk as { name?: unknown }).name === "string"
  );
  if (!column) return true;

  const values: unknown[] = [];
  const collectParams = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collectParams);
    } else if (typeof value === "object" && value !== null) {
      if ("encoder" in value && "value" in value) values.push((value as { value: unknown }).value);
      else if ("queryChunks" in value) collectParams((value as { queryChunks: unknown[] }).queryChunks);
    }
  };
  collectParams(chunks);

  const operators = chunks.flatMap(chunk => {
    if (typeof chunk !== "object" || chunk === null || !("value" in chunk)) return [];
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
  }).join("");
  return /\bin\b/i.test(operators)
    ? values.includes(row[column.name])
    : row[column.name] === values[0];
}

function makeTimerDb(
  assignments: Array<{ taskId: string; vaId: number; founderId: number; status: string }> = [],
  history = new Map<unknown, Record<string, unknown>[]>(),
) {
  const inserted: Record<string, unknown>[] = [];
  const rowsFor = (table: unknown, condition?: unknown) => {
    if (table === users) return [{ id: 10, role: "worker" }];
    if (table === vaProfiles) return [{ id: 77, founderId: 3, status: "active" }];
    if (table === taskAssignments) return condition
      ? assignments.filter(assignment => matchesWhere(assignment, condition))
      : assignments;
    if (table === aptlssPlans) return [{
      vaId: 10,
      cardId: "stale-card",
      cardName: "Previously assigned card",
      cardUrl: "https://trello.com/c/stale-card",
      boardName: "Operations",
      listName: "Doing",
    }];
    if (table === aptlssWaitingReasons || table === cardStates || table === timeEntries) return [];
    return history.get(table) ?? [];
  };
  const tx: any = {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => {
      let table: unknown;
      let condition: unknown;
      let rowLimit = Number.POSITIVE_INFINITY;
      const query: any = {
        from(value: unknown) { table = value; return query; },
        where(value: unknown) { condition = value; return query; },
        orderBy() { return query; },
        limit(value: number) { rowLimit = value; return query; },
        for() { return Promise.resolve(rowsFor(table, condition).slice(0, rowLimit)); },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve(rowsFor(table, condition).slice(0, rowLimit)).then(resolve, reject);
        },
      };
      return query;
    }),
    insert: vi.fn(() => ({ values: vi.fn((values: Record<string, unknown>) => ({ returning: async () => {
      inserted.push(values);
      return [{ id: 101 }];
    } })) })),
  };
  return {
    db: { transaction: vi.fn(async (run: (transaction: any) => Promise<unknown>) => run(tx)) },
    tx,
    inserted,
  };
}

async function compactTimerFixture() {
  const history = new Map<unknown, Record<string, unknown>[]>();
  const assignmentRows = [{ taskId: "stale-card", vaId: 77, founderId: 3, status: "assigned" }];
  const fixture = makeTimerDb(assignmentRows, history);
  const assignments = await readManagerAssignmentState(fixture.tx, 10);
  const now = Date.now();
  const snapshot = {
    runId: 1, trigger: "timer_changed", changes: [],
    executionCoverageComplete: true, assignmentFingerprint: assignments.fingerprint,
    assessedAt: new Date(now - 30_000).toISOString(), nextCheckAt: new Date(now + 5 * 60_000).toISOString(),
    policy: { enabled: true, intervalMinutes: 10, mode: "shadow" },
    actions: [], evidence: [], interventions: [],
  };
  const base = { ...snapshot, assessedAt: new Date(now - 60 * 60_000).toISOString(), nextCheckAt: new Date(now - 50 * 60_000).toISOString() };
  const state = { vaId: 10, currentCheckId: 2, inputHash: "input", sourceHash: "sources", enabled: true, intervalMinutes: 10, mode: "shadow" };
  const check = {
    id: 2, vaId: 10, runId: 1, inputHash: "input", sourceHash: "sources",
    baseSnapshotHash: managerHistoryHash(base), snapshotHash: managerHistoryHash(snapshot),
    snapshotPatchJson: JSON.stringify({ version: 1, values: {
      assessedAt: snapshot.assessedAt, nextCheckAt: snapshot.nextCheckAt,
      trigger: snapshot.trigger, changes: snapshot.changes, proposal: null,
    } }),
  };
  history.set(aptlssManagerRuns, [{ id: 1, vaId: 10, snapshotJson: JSON.stringify(base) }]);
  history.set(aptlssManagerState, [state]);
  history.set(aptlssManagerChecks, [check]);
  return { ...fixture, history, state, check, assignmentRows };
}

function startWorkerTimer() {
  return timerRouter.createCaller({
    req: {} as TrpcContext["req"], res: {} as TrpcContext["res"],
    user: { id: 10, openId: "test-10", role: "worker" } as TrpcContext["user"],
  } as TrpcContext).start({ cardId: "stale-card", cardName: "Current card", cardUrl: "https://trello.com/c/stale-card" });
}

const workerBEmail: EmailRow = {
  id: 41,
  vaId: 20,
  gmailMessageId: "shared-message-id",
  gmailThreadId: "worker-b-thread",
  subject: "Worker B private subject",
  status: "pending",
};

describe("legacy Manus route ownership and timer authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveWorkerProfileId.mockImplementation(async (id: number) => id);
    mocks.getActiveWorkerProfileResolution.mockImplementation(async (id: number) => ({ profileId: id, ambiguous: false }));
    mocks.isManagerPilotWorker.mockReturnValue(false);
  });

  it("does not let one worker overwrite another worker's globally unique Gmail message", async () => {
    const { db, rows } = makeDb([workerBEmail]);
    mocks.getDb.mockResolvedValue(db);

    await expect(caller(10).upsertBatch(batch("Attacker replacement", "archived")))
      .rejects.toMatchObject({ code: "CONFLICT" });

    expect(rows).toEqual([workerBEmail]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("fails closed if another worker wins the insert race after the ownership lookup", async () => {
    const raceWinner = { ...workerBEmail };
    const { db, rows } = makeDb([], existingRows => {
      if (existingRows.length === 0) existingRows.push(raceWinner);
    });
    mocks.getDb.mockResolvedValue(db);

    await expect(caller(10).upsertBatch(batch("Attacker replacement", "archived")))
      .rejects.toMatchObject({ code: "CONFLICT" });

    expect(rows).toEqual([workerBEmail]);
  });

  it("still updates an existing email task owned by the authenticated worker", async () => {
    const ownedEmail: EmailRow = { ...workerBEmail, vaId: 10 };
    const { db, rows } = makeDb([ownedEmail]);
    mocks.getDb.mockResolvedValue(db);

    await expect(caller(10).upsertBatch(batch("Worker A updated subject", "processed")))
      .resolves.toEqual({ success: true, upserted: 1 });

    expect(rows[0]).toMatchObject({
      vaId: 10,
      gmailMessageId: "shared-message-id",
      subject: "Worker A updated subject",
      status: "processed",
    });
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("rejects generic authenticated accounts before accessing email-task storage", async () => {
    const { db } = makeDb([]);
    mocks.getDb.mockResolvedValue(db);

    await expect(caller(10, "user").upsertBatch(batch("Not authorized")))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects a stale-plan timer start when no current task assignment exists", async () => {
    const { db, inserted } = makeTimerDb();
    mocks.getDb.mockResolvedValue(db);

    await expect(timerRouter.createCaller({
      req: {} as TrpcContext["req"],
      res: {} as TrpcContext["res"],
      user: { id: 10, openId: "test-10", role: "worker" } as TrpcContext["user"],
    } as TrpcContext).start({
      cardId: "stale-card",
      cardName: "Stale card from client",
      cardUrl: "https://trello.com/c/stale-card",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(inserted).toHaveLength(0);
  });

  it("still starts a timer for a card with a current worker assignment", async () => {
    const { db, inserted } = makeTimerDb([
      { taskId: "stale-card", vaId: 77, founderId: 3, status: "assigned" },
    ]);
    mocks.getDb.mockResolvedValue(db);

    await expect(timerRouter.createCaller({
      req: {} as TrpcContext["req"],
      res: {} as TrpcContext["res"],
      user: { id: 10, openId: "test-10", role: "worker" } as TrpcContext["user"],
    } as TrpcContext).start({
      cardId: "stale-card",
      cardName: "Stale card from client",
      cardUrl: "https://trello.com/c/stale-card",
    })).resolves.toMatchObject({ cardId: "stale-card" });

    expect(inserted).toHaveLength(1);
  });

  it("accepts fresh reconstructed compact history instead of the expired retained full run", async () => {
    const { db, inserted } = await compactTimerFixture();
    mocks.getDb.mockResolvedValue(db);
    mocks.isManagerPilotWorker.mockReturnValue(true);

    await expect(startWorkerTimer()).resolves.toMatchObject({ cardId: "stale-card" });

    expect(inserted).toEqual([expect.objectContaining({ taskId: "stale-card", trackedUserId: 10, vaId: null, founderId: 3 })]);
  });

  it.each(["snapshot hash", "missing check", "missing run", "disabled policy", "changed assignments"])(
    "holds worker execution for compact history with %s", async invalid => {
      const { db, tx, inserted, history, state, check, assignmentRows } = await compactTimerFixture();
      if (invalid === "snapshot hash") check.snapshotHash = "invalid";
      if (invalid === "missing check") history.delete(aptlssManagerChecks);
      if (invalid === "missing run") history.delete(aptlssManagerRuns);
      if (invalid === "disabled policy") state.enabled = false;
      if (invalid === "changed assignments") {
        assignmentRows.push({ ...assignmentRows[0], taskId: "new-assignment" });
      }
      mocks.getDb.mockResolvedValue(db);
      mocks.isManagerPilotWorker.mockReturnValue(true);

      await expect(startWorkerTimer()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: WORKER_EXECUTION_HOLD_MESSAGE });

      expect(inserted).toHaveLength(0);
      expect(tx.insert).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      description: "another worker profile",
      assignment: { taskId: "stale-card", vaId: 78, founderId: 3, status: "assigned" },
    },
    {
      description: "a different founder",
      assignment: { taskId: "stale-card", vaId: 77, founderId: 4, status: "assigned" },
    },
    {
      description: "a completed assignment",
      assignment: { taskId: "stale-card", vaId: 77, founderId: 3, status: "completed" },
    },
  ])("rejects a timer when the matching card belongs to $description", async ({ assignment }) => {
    const { db, inserted } = makeTimerDb([assignment]);
    mocks.getDb.mockResolvedValue(db);

    await expect(timerRouter.createCaller({
      req: {} as TrpcContext["req"],
      res: {} as TrpcContext["res"],
      user: { id: 10, openId: "test-10", role: "worker" } as TrpcContext["user"],
    } as TrpcContext).start({
      cardId: "stale-card",
      cardName: "Stale card from client",
      cardUrl: "https://trello.com/c/stale-card",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(inserted).toHaveLength(0);
  });
});
