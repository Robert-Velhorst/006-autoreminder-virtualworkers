import type { Request } from "express";
import express from "express";
import request from "supertest";
import { aptlssManagerChecks, aptlssManagerRuns, aptlssManagerState, taskAssignments, timeEntries, trelloCachedCards, users, vaProfiles } from "../../drizzle/schema";
import type { User } from "../../drizzle/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { managerHistoryHash } from "../aptlssManagerHistory";
import { WORKER_EXECUTION_HOLD_MESSAGE } from "../../shared/aptlssManager";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), invalidateCache: vi.fn(), emitToUser: vi.fn(), isManagerPilotWorker: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));
vi.mock("../services/trello-cache", () => ({ invalidateCache: mocks.invalidateCache }));
vi.mock("../services/websocket", () => ({ websocketService: { emitToUser: mocks.emitToUser } }));

import vaManagementRouter from "./va-management";

type Row = Record<string, unknown>;

function matchesWhere(row: Row, condition: unknown) {
  const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks ?? [];
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
  const column = chunks.find((chunk): chunk is { name: string } =>
    typeof chunk === "object" && chunk !== null && "name" in chunk
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
  if (/\bin\b/i.test(operators)) return values.includes(row[column.name]);
  return row[column.name] === values[0];
}

function database(rowsByTable: Map<unknown, Row[]>) {
  const updates: Array<{ table: unknown; values: Row }> = [];
  const inserts: Array<{ table: unknown; values: Row }> = [];
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      let condition: unknown;
      let limit = Number.POSITIVE_INFINITY;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: unknown) => { condition = value; return query; },
        orderBy: () => query,
        limit: (value: number) => { limit = value; return query; },
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => {
          const result = (rowsByTable.get(table) ?? [])
            .filter(row => !condition || matchesWhere(row, condition))
            .slice(0, limit);
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    }),
    update: vi.fn((table: unknown) => {
      const query: any = {
        set: (values: Row) => { updates.push({ table, values }); return query; },
        where: (condition: unknown) => {
          const affectedRows = (rowsByTable.get(table) ?? []).filter(row => matchesWhere(row, condition)).length;
          return Promise.resolve([{ affectedRows }]);
        },
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: Row) => {
        inserts.push({ table, values });
        return Promise.resolve([{ insertId: 1 }]);
      },
    })),
  };
  return { db, updates, inserts };
}

const admin = { id: 1, openId: "admin-1", name: "Admin", role: "admin" } as User;
const worker = { id: 42, openId: "worker-42", name: "Worker", role: "worker" } as User;
const standardUser = { id: 7, openId: "user-7", name: "User", role: "user" } as User;

function appFor(user: User) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    (req as Request & { user?: User }).user = user;
    next();
  });
  app.use("/api/va", vaManagementRouter);
  return app;
}

function founderTimerFixture() {
  const now = Date.now();
  const snapshot = {
    runId: 1, trigger: "timer_changed", changes: [],
    assessedAt: new Date(now - 30_000).toISOString(), nextCheckAt: new Date(now + 5 * 60_000).toISOString(),
    policy: { enabled: true, intervalMinutes: 10, mode: "shadow" },
    actions: [{ cardId: "current-card", blocked: false, evidenceIds: ["trello-evidence"] }],
    evidence: [{ id: "trello-evidence", cardId: "current-card", source: "trello", kind: "source", metadata: { authority: "official", truthClass: "confirmed" } }],
  };
  const base = { ...snapshot, assessedAt: new Date(now - 60 * 60_000).toISOString(), nextCheckAt: new Date(now - 50 * 60_000).toISOString() };
  const state = { vaId: worker.id, currentCheckId: 2, inputHash: "input", sourceHash: "sources", enabled: true, intervalMinutes: 10, mode: "shadow" };
  const check = {
    id: 2, vaId: worker.id, runId: 1, inputHash: "input", sourceHash: "sources",
    baseSnapshotHash: managerHistoryHash(base), snapshotHash: managerHistoryHash(snapshot),
    snapshotPatchJson: JSON.stringify({ version: 1, values: {
      assessedAt: snapshot.assessedAt, nextCheckAt: snapshot.nextCheckAt,
      trigger: snapshot.trigger, changes: snapshot.changes, proposal: null,
    } }),
  };
  const cache = {
    userId: worker.id, cardId: "current-card",
    cachedAt: new Date(now - 60_000), expiresAt: new Date(now + 5 * 60_000),
  };
  const rows = new Map<unknown, Row[]>([
    [vaProfiles, [{ id: 8, userId: worker.id, founderId: admin.id }]],
    [aptlssManagerState, [state]],
    [aptlssManagerRuns, [{ id: 1, vaId: worker.id, snapshotJson: JSON.stringify(base) }]],
    [aptlssManagerChecks, [check]],
    [trelloCachedCards, [cache]],
  ]);
  return { ...database(rows), rows, check, cache };
}

describe("VA management authorization and profile scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReset();
    mocks.isManagerPilotWorker.mockReturnValue(false);
  });

  it("does not let case-insensitive worker paths bypass the role boundary", async () => {
    const { db } = database(new Map([[vaProfiles, [
      { id: 8, userId: admin.id, founderId: admin.id, status: "active", name: "Linked profile" },
    ]]]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin)).get("/api/va/WORKER/profile");

    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    ["worker", worker],
    ["standard user", standardUser],
  ] as const)("denies %s access to founder-managed worker profiles", async (_label, user) => {
    const { db } = database(new Map());
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(user)).get("/api/va/vas");

    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("limits founder/admin profile listings to the current tenant", async () => {
    const { db } = database(new Map([[vaProfiles, [
      { id: 8, userId: 42, founderId: admin.id, status: "active", name: "Own worker" },
      { id: 9, userId: 43, founderId: 99, status: "active", name: "Other founder worker" },
    ]]]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin)).get("/api/va/vas");

    expect(response.status).toBe(200);
    expect(response.body.map((profile: { id: number }) => profile.id)).toEqual([8]);
  });

  it("rejects attempts to change a profile's account or founder ownership", async () => {
    const existing = {
      id: 8,
      userId: 42,
      founderId: admin.id,
      name: "Worker",
      email: "worker@example.test",
      skills: null,
    };
    const { db, updates } = database(new Map([[vaProfiles, [existing]]]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .put("/api/va/vas/8")
      .send({ name: "Renamed", userId: 99, founderId: 77 });

    expect(response.status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("does not change credentials for a linked account whose role is not worker", async () => {
    const existing = {
      id: 8,
      userId: admin.id,
      founderId: admin.id,
      name: "Mislinked profile",
      email: "admin@example.test",
      skills: null,
    };
    const { db, updates } = database(new Map([
      [vaProfiles, [existing]],
      [users, [{ id: admin.id, role: "admin" }]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .put("/api/va/vas/8")
      .send({ password: "a-valid-long-password" });

    expect(response.status).toBe(409);
    expect(updates).toEqual([]);
  });

  it("keeps supported profile updates while ignoring unrelated fields", async () => {
    const existing = {
      id: 8,
      userId: 42,
      founderId: admin.id,
      name: "Worker",
      email: "worker@example.test",
      skills: null,
    };
    const { db, updates } = database(new Map([[vaProfiles, [existing]]]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .put("/api/va/vas/8")
      .send({ name: "Renamed", status: "inactive", founderRole: "admin" });

    expect(response.status).toBe(200);
    expect(updates).toEqual([{
      table: vaProfiles,
      values: { name: "Renamed", status: "inactive", skills: null },
    }]);
  });

  it("builds worker task results from the unique active profile, not inactive profiles", async () => {
    const { db } = database(new Map([
      [vaProfiles, [
        { id: 3, userId: worker.id, founderId: 7, status: "active", trelloMemberId: null },
        { id: 4, userId: worker.id, founderId: 7, status: "inactive", trelloMemberId: null },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "active-task", vaId: 3, founderId: 7, status: "assigned" },
        { id: 41, taskId: "inactive-task", vaId: 4, founderId: 7, status: "assigned" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker)).get("/api/va/worker/tasks");

    expect(response.status).toBe(200);
    expect(response.body.tasks.map((task: { id: string }) => task.id)).toEqual(["active-task"]);
  });

  it("does not expose another founder's assignment through a matching worker profile ID", async () => {
    const { db } = database(new Map([
      [vaProfiles, [
        { id: 3, userId: worker.id, founderId: 7, status: "active", trelloMemberId: null },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "own-task", vaId: 3, founderId: 7, status: "assigned" },
        { id: 32, taskId: "foreign-task", vaId: 3, founderId: 99, status: "assigned" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker)).get("/api/va/worker/tasks");

    expect(response.status).toBe(200);
    expect(response.body.tasks.map((task: { id: string }) => task.id)).toEqual(["own-task"]);
  });

  it.each(["complete", "review"] as const)(
    "cannot use the %s action on a foreign founder's assignment with a matching worker profile ID",
    async action => {
    const { db, updates } = database(new Map([
      [vaProfiles, [
        { id: 3, userId: worker.id, founderId: 7, status: "active", trelloMemberId: null },
      ]],
      [taskAssignments, [
        { id: 32, taskId: "foreign-task", vaId: 3, founderId: 99, status: "assigned" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker))
      .post(`/api/va/worker/tasks/foreign-task/${action}`)
      .send({ completed: true });

    expect(response.status).toBe(404);
    expect(updates).toEqual([{ table: taskAssignments, values: { status: "completed" } }]);
    expect(mocks.invalidateCache).not.toHaveBeenCalled();
    expect(mocks.emitToUser).not.toHaveBeenCalled();
    },
  );

  it("rejects handoff notes from a worker who is no longer assigned to that task", async () => {
    const { db, inserts } = database(new Map([
      [vaProfiles, [
        { id: 8, userId: 42, founderId: admin.id, status: "active", name: "Previous worker" },
        { id: 9, userId: 43, founderId: admin.id, status: "active", name: "Current worker" },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "shared-task", vaId: 9, founderId: admin.id, status: "in_progress" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .post("/api/va/handoff")
      .send({
        taskId: "shared-task",
        fromVaId: 8,
        toVaId: 9,
        whereLeftOff: "Previous worker's stale handoff",
      });

    expect(response.status).toBe(409);
    expect(inserts).toEqual([]);
  });

  it("accepts a handoff note from the worker currently assigned to the task", async () => {
    const { db, inserts } = database(new Map([
      [vaProfiles, [
        { id: 9, userId: 43, founderId: admin.id, status: "active", name: "Current worker" },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "shared-task", vaId: 9, founderId: admin.id, status: "in_progress" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .post("/api/va/handoff")
      .send({
        taskId: "shared-task",
        fromVaId: 9,
        whereLeftOff: "Verified current handoff",
      });

    expect(response.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toMatchObject({ taskId: "shared-task", fromVaId: 9, founderId: admin.id });
  });

  it("fails closed when duplicate task assignments disagree about the current worker", async () => {
    const { db, inserts } = database(new Map([
      [vaProfiles, [
        { id: 8, userId: 42, founderId: admin.id, status: "active", name: "Previous worker" },
        { id: 9, userId: 43, founderId: admin.id, status: "active", name: "Current worker" },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "shared-task", vaId: 8, founderId: admin.id, status: "assigned" },
        { id: 32, taskId: "shared-task", vaId: 9, founderId: admin.id, status: "in_progress" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .post("/api/va/handoff")
      .send({
        taskId: "shared-task",
        fromVaId: 8,
        toVaId: 9,
        whereLeftOff: "Handoff against conflicting assignment rows",
      });

    expect(response.status).toBe(409);
    expect(inserts).toEqual([]);
  });

  it("does not treat a completed former assignment as current when ownership changed", async () => {
    const { db, inserts } = database(new Map([
      [vaProfiles, [
        { id: 8, userId: 42, founderId: admin.id, status: "active", name: "Previous worker" },
        { id: 9, userId: 43, founderId: admin.id, status: "active", name: "Current worker" },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "shared-task", vaId: 8, founderId: admin.id, status: "completed" },
        { id: 32, taskId: "shared-task", vaId: 9, founderId: admin.id, status: "in_progress" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .post("/api/va/handoff")
      .send({
        taskId: "shared-task",
        fromVaId: 9,
        whereLeftOff: "Current worker handoff",
      });

    expect(response.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toMatchObject({ taskId: "shared-task", fromVaId: 9, founderId: admin.id });
  });

  it("rejects handoff creation when only completed assignments remain", async () => {
    const { db, inserts } = database(new Map([
      [vaProfiles, [
        { id: 8, userId: 42, founderId: admin.id, status: "active", name: "Previous worker" },
      ]],
      [taskAssignments, [
        { id: 31, taskId: "shared-task", vaId: 8, founderId: admin.id, status: "completed" },
      ]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .post("/api/va/handoff")
      .send({
        taskId: "shared-task",
        fromVaId: 8,
        whereLeftOff: "Stale completed handoff",
      });

    expect(response.status).toBe(404);
    expect(inserts).toEqual([]);
  });

  it("starts a founder timer using the compact check's current source-assessment time", async () => {
    const { db, inserts } = founderTimerFixture();
    mocks.getDb.mockResolvedValue(db);
    mocks.isManagerPilotWorker.mockReturnValue(true);

    const response = await request(appFor(admin)).post("/api/va/time-entries/start").send({ taskId: "current-card:checklist:item", vaId: 8 });

    expect(response.status).toBe(200);
    expect(inserts).toEqual([{ table: timeEntries, values: expect.objectContaining({ taskId: "current-card:checklist:item", vaId: 8, founderId: admin.id }) }]);
    expect(mocks.isManagerPilotWorker).toHaveBeenCalledWith(worker.id);
  });

  it.each(["snapshot hash", "missing check", "missing run", "foreign worker check"])(
    "holds a founder timer when current manager history has %s", async invalid => {
      const { db, inserts, rows, check } = founderTimerFixture();
      if (invalid === "snapshot hash") check.snapshotHash = "invalid";
      if (invalid === "missing check") rows.delete(aptlssManagerChecks);
      if (invalid === "missing run") rows.delete(aptlssManagerRuns);
      if (invalid === "foreign worker check") check.vaId = 99;
      mocks.getDb.mockResolvedValue(db);
      mocks.isManagerPilotWorker.mockReturnValue(true);

      const response = await request(appFor(admin)).post("/api/va/time-entries/start").send({ taskId: "current-card", vaId: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: WORKER_EXECUTION_HOLD_MESSAGE });
      expect(inserts).toHaveLength(0);
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it.each(["missing history", "source changed", "source expired"])("does not start a founder timer with %s", async invalid => {
    const { db, inserts, rows, cache } = founderTimerFixture();
    if (invalid === "missing history") {
      rows.delete(aptlssManagerRuns);
      rows.delete(aptlssManagerState);
      rows.delete(aptlssManagerChecks);
    }
    if (invalid === "source changed") cache.cachedAt = new Date(Date.now() - 10_000);
    if (invalid === "source expired") cache.expiresAt = new Date(Date.now() - 1_000);
    mocks.getDb.mockResolvedValue(db);
    mocks.isManagerPilotWorker.mockReturnValue(true);

    const response = await request(appFor(admin)).post("/api/va/time-entries/start").send({ taskId: "current-card", vaId: 8 });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(invalid === "missing history" ? WORKER_EXECUTION_HOLD_MESSAGE
      : "A source required by the next step is out of date or not verified. Check that source before starting work.");
    expect(inserts).toHaveLength(0);
  });
});
