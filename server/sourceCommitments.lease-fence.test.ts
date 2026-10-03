import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitments } from "../drizzle/schema";
import { ScheduledJobLeaseLostError, type ScheduledJobOwnershipReader } from "./scheduledJobRuntime";
import { syncWorkerTrelloCommitments, upsertSourceCommitment } from "./sourceCommitments";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getWorkerCards: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./services/trello-manus", () => ({ getWorkerCards: mocks.getWorkerCards }));

const input = {
  workspaceOwnerId: 1, assignedUserId: 2, sourceType: "trello" as const,
  sourceId: "card-1", title: "Deadline", dueAt: new Date("2026-10-02T12:00:00Z"),
};

function harness(latestState?: string, loseAfter?: string, checkWrites = true) {
  let owned = true;
  let reads = 0;
  let writes = 0;
  const trace: string[] = [];
  const durable: string[] = [];
  const staged: string[] = [];
  const commitment = { ...input, id: 10, status: "open", sourceUrl: null, context: null };
  const rows = [latestState ? [{ ...commitment, assignedUserId: 3 }] : [], [commitment],
    latestState ? [{ id: 20, ruleId: 30, recipientUserId: 3, state: latestState }] : []];
  const context = {
    signal: new AbortController().signal,
    assertOwnership: vi.fn(async (_reader?: ScheduledJobOwnershipReader) => {
      trace.push("checkpoint");
      if (!owned) throw new ScheduledJobLeaseLostError();
    }),
  };
  const touch = (event: string) => {
    trace.push(event);
    if (loseAfter === event) owned = false;
  };
  const write = async () => {
    const event = `write-${++writes}`;
    if (checkWrites) expect(trace.at(-1)).toBe("checkpoint");
    staged.push(event);
    touch(event);
    return [{ insertId: 100 + writes }];
  };
  const tx = {
    select: () => {
      const query = {
        from: () => query, where: () => query, orderBy: () => query, limit: () => query,
        for: async () => {
          touch(`read-${++reads}`);
          return rows[reads - 1];
        },
      };
      return query;
    },
    insert: (table: unknown) => ({ values: () => table === commitments
      ? { onDuplicateKeyUpdate: write }
      : { then: (resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) => write().then(resolve, reject) } }),
    update: () => ({ set: () => ({ where: write }) }),
  };
  mocks.getDb.mockResolvedValue({ transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const result = await work(tx);
    durable.push(...staged);
    return result;
  } });
  return { context, durable, staged, tx, trace, lose: () => { owned = false; } };
}

describe("source commitment scheduled ownership fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "scheduled", "awaiting_approval"])(
    "uses the same transaction for every checkpoint when the latest schedule is %s", async (latest) => {
      const state = harness(latest);
      await expect(upsertSourceCommitment(input, state.context)).resolves.toMatchObject({
        state: latest ? "updated" : "created",
      });
      expect(state.context.assertOwnership.mock.calls.map(([reader]) => reader)).toEqual([
        undefined, undefined, ...Array(8).fill(state.tx), undefined,
      ]);
      for (const [reader] of state.context.assertOwnership.mock.calls.slice(2, -1)) {
        expect(reader).toBe(state.tx);
      }
      expect(state.trace.slice(0, 4)).toEqual(["checkpoint", "checkpoint", "checkpoint", "read-1"]);
      expect(state.durable).toHaveLength(4);
    },
  );

  it("checks transaction ownership before locking the first business row", async () => {
    const state = harness();
    const db = await mocks.getDb();
    const transaction = db.transaction;
    db.transaction = async (work: (tx: unknown) => Promise<unknown>) => {
      state.lose();
      return transaction(work);
    };
    await expect(upsertSourceCommitment(input, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.context.assertOwnership).toHaveBeenLastCalledWith(state.tx);
    expect(state.trace).not.toContain("read-1");
    expect(state.staged).toEqual([]);
    expect(state.durable).toEqual([]);
  });

  it.each(["read-1", "read-2", "read-3", "write-1", "write-2", "write-3", "write-4"])(
    "rolls back creation when ownership is lost after %s", async (event) => {
      const state = harness(undefined, event);
      await expect(upsertSourceCommitment(input, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
      expect(state.durable).toEqual([]);
      if (event === "read-1") expect(state.staged).toEqual([]);
    },
  );

  it.each(["scheduled", "awaiting_approval"])("fences each reassignment write for %s", async (latest) => {
    for (const event of ["write-2", "write-3", "write-4"]) {
      const state = harness(latest, event);
      await expect(upsertSourceCommitment(input, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
      expect(state.durable).toEqual([]);
      expect(state.staged).toHaveLength(Number(event.slice(-1)));
    }
  });

  it("rejects an already aborted signal before database access", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(upsertSourceCommitment(input, {
      signal: controller.signal, assertOwnership: vi.fn(),
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("does not persist cards returned after losing ownership during the provider read", async () => {
    const state = harness();
    mocks.getWorkerCards.mockImplementation(async () => {
      state.lose();
      return [{ id: "card-1", name: "Deadline", due: input.dueAt.toISOString() }];
    });
    await expect(syncWorkerTrelloCommitments({
      userId: 2, workspaceOwnerId: 1, trelloMemberId: "member", context: state.context,
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("stops before the next card if ownership is lost during the first upsert", async () => {
    const state = harness(undefined, "write-4");
    mocks.getWorkerCards.mockResolvedValue([1, 2].map(id => ({ id: `card-${id}`, name: "Deadline", due: input.dueAt.toISOString() })));
    await expect(syncWorkerTrelloCommitments({
      userId: 2, workspaceOwnerId: 1, trelloMemberId: "member", context: state.context,
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
    expect(state.durable).toEqual([]);
  });

  it("keeps direct upserts without a scheduled context compatible", async () => {
    const state = harness(undefined, undefined, false);
    await expect(upsertSourceCommitment(input)).resolves.toMatchObject({ state: "created" });
    expect(state.durable).toHaveLength(4);
  });

  it("propagates loss during transaction commit rather than reporting success", async () => {
    const state = harness();
    const db = await mocks.getDb();
    const transaction = db.transaction;
    db.transaction = async (work: (tx: unknown) => Promise<unknown>) => {
      const result = await transaction(work);
      state.lose();
      return result;
    };
    await expect(upsertSourceCommitment(input, state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.durable).toHaveLength(4);
  });
});
