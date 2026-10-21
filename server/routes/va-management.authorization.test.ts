import type { Request } from "express";
import express from "express";
import request from "supertest";
import { aptlssManagerChecks, aptlssManagerRuns, aptlssManagerState, taskAssignments, timeEntries, trelloCachedCards, users, vaProfiles, workerInvitations, workerLifecycleAudit } from "../../drizzle/schema.postgres";
import type { User } from "../../drizzle/schema.postgres";
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
  if (/is null/i.test(operators)) return row[column.name] == null;
  if (/\bin\b/i.test(operators)) return values.includes(row[column.name]);
  return row[column.name] === values[0];
}

function database(rowsByTable: Map<unknown, Row[]>, failInsert?: unknown) {
  const updates: Array<{ table: unknown; values: Row }> = [];
  const inserts: Array<{ table: unknown; values: Row }> = [];
  const locks: unknown[] = [];
  const db: any = {
    transaction: async (callback: (tx: any) => Promise<unknown>) => {
      const snapshot = new Map([...rowsByTable].map(([table, rows]) => [table, structuredClone(rows)]));
      const updateCount = updates.length;
      const insertCount = inserts.length;
      try { return await callback(db); }
      catch (error) {
        rowsByTable.clear();
        snapshot.forEach((rows, table) => rowsByTable.set(table, rows));
        updates.length = updateCount;
        inserts.length = insertCount;
        throw error;
      }
    },
    select: vi.fn(() => {
      let table: unknown;
      let condition: unknown;
      let limit = Number.POSITIVE_INFINITY;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: unknown) => { condition = value; return query; },
        orderBy: () => query,
        for: () => { locks.push(table); return query; },
        limit: (value: number) => { limit = value; return query; },
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => {
          const result = (rowsByTable.get(table) ?? [])
            .filter(row => !condition || matchesWhere(row, condition))
            .slice(0, limit).map(row => structuredClone(row));
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    }),
    update: vi.fn((table: unknown) => {
      let values: Row;
      let condition: unknown;
      const execute = () => {
        const rows = (rowsByTable.get(table) ?? []).filter(row => matchesWhere(row, condition));
        rows.forEach(row => Object.assign(row, values));
        return rows;
      };
      const query: any = {
        set: (value: Row) => { values = value; updates.push({ table, values }); return query; },
        where: (value: unknown) => { condition = value; return query; },
        returning: async () => execute(),
        then: (resolve: any, reject: any) => Promise.resolve({ rowCount: execute().length }).then(resolve, reject),
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: Row) => {
        const execute = () => {
          if (table === failInsert) throw new Error('Injected insert failure');
          inserts.push({ table, values });
          const rows = rowsByTable.get(table) ?? [];
          const row = { id: Math.max(0, ...rows.map(row => Number(row.id))) + 1,
            ...(table === vaProfiles ? { status: 'active' } : {}), ...values };
          rowsByTable.set(table, [...rows, row]);
          return [row];
        };
        return { returning: async () => execute(), then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
      },
    })),
  };
  return { db, updates, inserts, locks };
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
    [users, [admin, worker]],
    [vaProfiles, [{ id: 8, userId: worker.id, founderId: admin.id, status: 'active' }]],
    [taskAssignments, [{ id: 1, vaId: 8, founderId: admin.id, taskId: 'current-card', status: 'assigned' }]],
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
    const { db, updates } = database(new Map<unknown, Row[]>([[vaProfiles, [existing]], [users, [worker]]]));
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(admin))
      .put("/api/va/vas/8")
      .send({ name: "Renamed", status: "inactive", founderRole: "admin" });

    expect(response.status).toBe(200);
    expect(updates).toEqual([{
      table: vaProfiles,
      values: { name: "Renamed", status: "inactive", skills: null },
    }, { table: workerInvitations, values: { revokedAt: expect.any(Date) } }]);
  });

  function lifecycleFixture(failInsert?: unknown) {
    const rows = new Map<unknown, Row[]>([
      [users, [{ ...worker, email: 'worker@example.test', passwordHash: 'original-hash' }]],
      [vaProfiles, [{ id: 8, userId: worker.id, founderId: admin.id, status: 'active',
        name: 'Worker', email: 'worker@example.test', skills: null }]],
      [workerInvitations, [
        { id: 1, userId: worker.id, vaId: 8, acceptedAt: null, revokedAt: null },
        { id: 2, userId: worker.id, vaId: 8, acceptedAt: new Date(), revokedAt: null },
        { id: 3, userId: 99, vaId: 9, acceptedAt: null, revokedAt: null },
      ]],
      [timeEntries, [{ id: 1, vaId: 8, durationMinutes: 45 }]],
    ]);
    const fixture = database(rows, failInsert);
    mocks.getDb.mockResolvedValue(fixture.db);
    return { ...fixture, rows };
  }

  it('atomically creates the worker account, profile and minimal audit', async () => {
    const { rows } = lifecycleFixture();
    const response = await request(appFor(admin)).post('/api/va/vas').send({
      name: 'Synthetic worker', email: 'new@example.test', password: 'synthetic-password-only',
    });
    expect(response.status).toBe(200);
    const created = rows.get(vaProfiles)!.find(row => row.id === response.body.id)!;
    expect(rows.get(users)!.find(row => row.id === created.userId)).toMatchObject({ role: 'worker', openId: 'new@example.test' });
    expect(rows.get(workerLifecycleAudit)).toEqual([expect.objectContaining({ actorUserId: admin.id,
      workerProfileId: created.id, founderId: admin.id, action: 'create', previousStatus: null, nextStatus: 'active' })]);
    expect(Object.keys(rows.get(workerLifecycleAudit)![0]).sort()).toEqual([
      'action', 'actorUserId', 'founderId', 'id', 'nextStatus', 'previousStatus', 'userId', 'workerProfileId',
    ]);
  });

  it.each([vaProfiles, workerLifecycleAudit])('rolls back account creation when a dependent insert fails', async table => {
    const { rows } = lifecycleFixture(table);
    const response = await request(appFor(admin)).post('/api/va/vas').send({
      name: 'Synthetic worker', email: 'new@example.test', password: 'synthetic-password-only',
    });
    expect(response.status).toBe(500);
    expect(rows.get(users)).toHaveLength(1);
    expect(rows.get(vaProfiles)).toHaveLength(1);
    expect(rows.get(workerLifecycleAudit) ?? []).toEqual([]);
  });

  it('checks email conflicts before changing password and locks user before profile', async () => {
    const { rows, updates, locks } = lifecycleFixture();
    rows.get(users)!.push({ id: 99, role: 'worker', openId: 'taken@example.test' });
    const response = await request(appFor(admin)).put('/api/va/vas/8').send({
      email: 'taken@example.test', password: 'synthetic-new-password',
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Email already registered');
    expect(rows.get(users)![0].passwordHash).toBe('original-hash');
    expect(updates).toEqual([]);
    expect(locks).toEqual([users, vaProfiles]);
  });

  it('rolls back credential and profile updates when the audit fails', async () => {
    const { rows } = lifecycleFixture(workerLifecycleAudit);
    const response = await request(appFor(admin)).put('/api/va/vas/8').send({
      email: 'changed@example.test', password: 'synthetic-new-password', status: 'on_leave',
    });
    expect(response.status).toBe(500);
    expect(rows.get(users)![0]).toMatchObject({ openId: worker.openId, passwordHash: 'original-hash' });
    expect(rows.get(vaProfiles)![0]).toMatchObject({ email: 'worker@example.test', status: 'active' });
  });

  it('soft-offboards only the owned worker and revokes only pending invitations, retaining history', async () => {
    const { rows } = lifecycleFixture();
    const response = await request(appFor(admin)).delete('/api/va/vas/8');
    expect(response.status).toBe(200);
    expect(rows.get(vaProfiles)![0].status).toBe('inactive');
    expect(rows.get(users)).toHaveLength(1);
    expect(rows.get(timeEntries)).toEqual([{ id: 1, vaId: 8, durationMinutes: 45 }]);
    expect(rows.get(workerInvitations)!.map(row => row.revokedAt !== null)).toEqual([true, false, false]);
    expect(rows.get(workerLifecycleAudit)![0]).toMatchObject({ action: 'offboard', previousStatus: 'active', nextStatus: 'inactive' });
  });

  it('rolls back offboarding and invitation revocation if the audit fails', async () => {
    const { rows } = lifecycleFixture(workerLifecycleAudit);
    expect((await request(appFor(admin)).delete('/api/va/vas/8')).status).toBe(500);
    expect(rows.get(vaProfiles)![0].status).toBe('active');
    expect(rows.get(workerInvitations)![0].revokedAt).toBeNull();
  });

  it.each(['inactive', 'on_leave'])('explicit PUT %s cancels pending invitations even without a status transition', async status => {
    const { rows } = lifecycleFixture();
    rows.get(vaProfiles)![0].status = status;
    expect((await request(appFor(admin)).put('/api/va/vas/8').send({ status })).status).toBe(200);
    expect(rows.get(workerInvitations)![0].revokedAt).toBeInstanceOf(Date);
    expect(rows.get(workerInvitations)![1].revokedAt).toBeNull();
    expect(rows.get(workerInvitations)![2].revokedAt).toBeNull();
  });

  it('ordinary profile edits do not cancel a pending invitation', async () => {
    const { rows } = lifecycleFixture();
    rows.get(vaProfiles)![0].status = 'inactive';
    expect((await request(appFor(admin)).put('/api/va/vas/8').send({ name: 'Renamed' })).status).toBe(200);
    expect(rows.get(workerInvitations)![0].revokedAt).toBeNull();
  });

  it.each(['put', 'delete'] as const)('%s rejects missing, foreign and ambiguous profiles without writes', async method => {
    const { rows, updates } = lifecycleFixture();
    expect((await request(appFor(admin))[method]('/api/va/vas/999').send({ name: 'Changed' })).status).toBe(404);
    rows.get(vaProfiles)![0].founderId = 99;
    expect((await request(appFor(admin))[method]('/api/va/vas/8').send({ name: 'Changed' })).status).toBe(404);
    rows.get(vaProfiles)![0].founderId = admin.id;
    rows.get(vaProfiles)!.push({ ...rows.get(vaProfiles)![0], id: 9, status: 'inactive' });
    expect((await request(appFor(admin))[method]('/api/va/vas/8').send({ name: 'Changed' })).status).toBe(409);
    expect(updates).toEqual([]);
  });

  it.each(['deleted', '', null, 1])('rejects invalid status %s before persistence', async status => {
    const { updates, inserts } = lifecycleFixture();
    expect((await request(appFor(admin)).put('/api/va/vas/8').send({ status })).status).toBe(400);
    expect((await request(appFor(admin)).post('/api/va/vas').send({ name: 'Test', email: 'new@example.test', password: 'synthetic-password', status })).status).toBe(400);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it.each([worker, standardUser])('rejects lifecycle writes by role $role', async actor => {
    const { updates, inserts } = lifecycleFixture();
    expect((await request(appFor(actor)).post('/api/va/vas').send({})).status).toBe(403);
    expect((await request(appFor(actor)).put('/api/va/vas/8').send({ status: 'inactive' })).status).toBe(403);
    expect((await request(appFor(actor)).delete('/api/va/vas/8')).status).toBe(403);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
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
    expect(inserts).toEqual([{ table: timeEntries, values: expect.objectContaining({ taskId: "current-card:checklist:item", trackedUserId: worker.id, trackedProfileId: 8, vaId: null, founderId: admin.id }) }]);
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
