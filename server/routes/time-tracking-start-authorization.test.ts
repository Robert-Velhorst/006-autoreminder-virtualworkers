import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { atisCards, taskAssignments, timeEntries, users, vaProfiles } from "../../drizzle/schema.postgres";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  isManagerPilotWorker: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));
vi.mock("../aptlssManagerQueue", () => ({ enqueueManagerTask: vi.fn() }));

import timeTrackingRoutes from "./time-tracking";
import { matchesTimerWhere } from '../test/timerDatabase';

type Assignment = { id: number; taskId: string; vaId: number; founderId: number; status: string };

function makeDb(options: {
  assignment?: Assignment;
  cardMember?: boolean;
  beforeAssignmentLock?: () => Promise<void>;
  profileAfterMiddleware?: { id: number; userId: number; founderId: number; trelloMemberId: string; status: string };
  profileCollisions?: Array<{ id: number; userId: number; founderId: number; status: string }>;
  otherAccountIds?: number[];
} = {}) {
  let timeEntryReads = 0;
  let taskAssignmentReads = 0;
  let profileReads = 0;
  const inserted = vi.fn();
  const entry = { id: 100, taskId: "assigned-card", vaId: 42, founderId: 8, startTime: new Date(), endTime: null };
  const profile = { id: 7, userId: 42, founderId: 8, trelloMemberId: "member-7", status: "active" };
  const assignment = options.assignment;
  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => {
      let table: unknown;
      let condition: unknown;
      const rows = () => {
        if (table === users) return [{ id: 42, role: "worker" }, ...(options.otherAccountIds ?? []).map(id => ({ id }))];
        if (table === vaProfiles) {
          const profileRead = profileReads++;
          if (profileRead === 0) return [profile];
          return [options.profileAfterMiddleware ?? profile];
        }
        if (table === taskAssignments) {
          return assignment && matchesTimerWhere(assignment, condition) ? [assignment] : [];
        }
        if (table === atisCards) return options.cardMember
          ? [{ listName: "To Do", memberIds: JSON.stringify([profile.trelloMemberId]), isArchived: false }]
          : [];
        if (table === timeEntries) return [];
        return [];
      };
      const query: any = {
        from: vi.fn((value: unknown) => { table = value; return query; }),
        where: vi.fn((value: unknown) => { condition = value; return query; }),
        orderBy: vi.fn(() => query),
        limit: vi.fn(() => query),
        for: vi.fn(async () => {
          if (table === taskAssignments) {
            await options.beforeAssignmentLock?.();
            return rows();
          }
          return rows();
        }),
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      return query;
    }),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => ({ returning: vi.fn(async () => {
          inserted(values);
          return [{ ...entry, ...values, id: 100 }];
        }) })),
      })),
  };
  const db = { transaction: vi.fn(async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx)) };
  return { db, inserted, assignment };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 42, openId: "worker-42", role: "worker", name: "Worker" };
    next();
  });
  app.use(timeTrackingRoutes);
  return app;
}

describe("worker timer-start authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isManagerPilotWorker.mockReturnValue(false);
  });

  it("rejects a non-pilot worker's timer for a task not assigned to their profile", async () => {
    const { db, inserted } = makeDb();
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "unassigned-card" })
      .expect(403, { error: "This task is not assigned to your worker account" });

    expect(inserted).not.toHaveBeenCalled();
  });

  it("allows a non-pilot worker to start a timer for their assigned task", async () => {
    const { db, inserted } = makeDb({ assignment: { id: 11, taskId: "assigned-card", vaId: 7, founderId: 8, status: "assigned" } });
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .expect(200);

    expect(inserted).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-pilot worker's timer for an assigned task that is blocked", async () => {
    const { db, inserted } = makeDb({ assignment: { id: 11, taskId: "assigned-card", vaId: 7, founderId: 8, status: "blocked" } });
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .expect(409, { error: "This task is blocked; resolve the blocker before tracking time" });

    expect(inserted).not.toHaveBeenCalled();
  });

  it("rejects an assignment retained from the worker's former founder", async () => {
    const { db, inserted } = makeDb({ assignment: {
      id: 11,
      taskId: "assigned-card",
      vaId: 7,
      founderId: 99,
      status: "assigned",
    } });
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .expect(403, { error: "This task is not assigned to your worker account" });

    expect(inserted).not.toHaveBeenCalled();
  });

  it("rechecks the worker's current founder after the access middleware runs", async () => {
    const { db, inserted } = makeDb({
      assignment: { id: 11, taskId: "assigned-card", vaId: 7, founderId: 8, status: "assigned" },
      profileAfterMiddleware: { id: 7, userId: 42, founderId: 9, trelloMemberId: "member-7", status: "active" },
    });
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .expect(403, { error: "This task is not assigned to your worker account" });

    expect(inserted).not.toHaveBeenCalled();
  });

  it("uses the canonical account ID even when that number overlaps another profile", async () => {
    const { db, inserted } = makeDb({
      assignment: { id: 11, taskId: "assigned-card", vaId: 7, founderId: 8, status: "assigned" },
      profileCollisions: [{ id: 42, userId: 77, founderId: 8, status: "active" }],
    });
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .expect(200);

    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ trackedUserId: 42, trackedProfileId: 7, vaId: null, founderId: 8, taskId: "assigned-card" }));
  });

  it("rejects a timer when reassignment wins while the start waits for the assignment row", async () => {
    let markLockAttempt: () => void = () => {};
    let releaseLock: () => void = () => {};
    const lockAttempted = new Promise<void>(resolve => { markLockAttempt = resolve; });
    const lockReleased = new Promise<void>(resolve => { releaseLock = resolve; });
    const { db, inserted, assignment } = makeDb({
      assignment: { id: 11, taskId: "assigned-card", vaId: 7, founderId: 8, status: "assigned" },
      beforeAssignmentLock: async () => {
        markLockAttempt();
        await lockReleased;
      },
    });
    mocks.getDb.mockResolvedValue(db);

    const response = request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .then(result => result);
    await lockAttempted;
    assignment!.vaId = 9;
    releaseLock();

    expect((await response).status).toBe(403);
    expect((await response).body).toEqual({
      error: "This task is assigned to a different worker. Ask the founder to update the assignment before tracking time.",
    });
    expect(inserted).not.toHaveBeenCalled();
  });

  it("does not let a pilot worker use Trello membership to bypass assignment to another worker", async () => {
    const { db, inserted } = makeDb({
      assignment: { id: 11, taskId: "assigned-card", vaId: 9, founderId: 8, status: "assigned" },
      cardMember: true,
    });
    mocks.isManagerPilotWorker.mockReturnValue(true);
    mocks.getDb.mockResolvedValue(db);

    await request(createApp())
      .post("/time-tracking/start")
      .send({ taskId: "assigned-card" })
      .expect(403, {
        error: "This task is assigned to a different worker. Ask the founder to update the assignment before tracking time.",
      });

    expect(inserted).not.toHaveBeenCalled();
  });
});
