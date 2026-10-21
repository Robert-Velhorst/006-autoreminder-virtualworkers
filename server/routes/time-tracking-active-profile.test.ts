import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { timeEntries, users, vaProfiles } from "../../drizzle/schema.postgres";
import { timerTestDatabase } from "../test/timerDatabase";
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isManagerPilotWorker: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));
vi.mock("../aptlssManagerQueue", () => ({ enqueueManagerTask: vi.fn() }));
import routes from "./time-tracking";

const worker = { id: 42, openId: "synthetic-worker", role: "worker" };
const active = { id: 7, userId: 42, founderId: 8, status: "active", timezone: "UTC" };
function fixture(options: { actor?: typeof worker; profiles?: any[]; entries?: any[]; afterMiddleware?: any[] } = {}) {
  const actor = options.actor ?? worker;
  const rows = new Map<unknown, any[]>([[users, [actor]], [vaProfiles, options.profiles ?? [active]], [timeEntries, options.entries ?? []]]);
  const dbFixture = timerTestDatabase(rows, { beforeLock: async table => {
    if (table === users && options.afterMiddleware) rows.set(vaProfiles, options.afterMiddleware);
  } });
  mocks.getDb.mockResolvedValue(dbFixture.db);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = actor; next(); }); app.use(routes);
  return { app, ...dbFixture };
}
function entry(values: Record<string, unknown> = {}) {
  return { id: 55, trackedUserId: 42, trackedProfileId: 7, vaId: null, founderId: 8,
    taskId: "private-task", startTime: new Date("2026-10-01T09:00:00Z"), endTime: null,
    durationMinutes: null, durationSeconds: null, isVoided: false, notes: null, ...values };
}
const endpoints = ["/active", "/task/task-1", "/summary", "/weekly-progress", "/start", "/stop", "/pause"];
beforeEach(() => { vi.clearAllMocks(); mocks.isManagerPilotWorker.mockReturnValue(false); });

describe("canonical timer eligibility and ownership", () => {
  it.each([{ profiles: [] }, { profiles: [{ ...active, status: "inactive" }] }, { profiles: [active, { ...active, id: 9 }] }])("denies every timer endpoint without exactly one active profile %j", async ({ profiles }) => {
    for (const endpoint of endpoints) {
      const { app, inserts, updates } = fixture({ profiles });
      const read = ["/active", "/task/task-1", "/summary", "/weekly-progress"].includes(endpoint);
      const response = read ? await request(app).get("/time-tracking" + endpoint)
        : await request(app).post("/time-tracking" + endpoint).send({ taskId: "task-1", entryId: 55 });
      expect(response.status).toBe(403);
      expect(inserts).toEqual([]); expect(updates).toEqual([]);
    }
  });

  it.each(["user", "admin"])("preserves %s self-tracking without a worker profile", async role => {
    const { app, inserts } = fixture({ actor: { ...worker, role }, profiles: [] });
    expect((await request(app).get("/time-tracking/summary")).status).toBe(200);
    const response = await request(app).post("/time-tracking/start").send({ taskId: "self-task" });
    expect(response.status).toBe(200);
    expect(inserts[0].values).toMatchObject({ trackedUserId: 42, trackedProfileId: null, vaId: null, founderId: 42 });
  });

  it.each(["/active", "/task/private-task", "/summary", "/weekly-progress"])("does not expose a foreign founder through %s", async endpoint => {
    const { app } = fixture({ entries: [entry({ trackedUserId: 99, founderId: 99 })] });
    const response = await request(app).get("/time-tracking" + endpoint);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("private-task");
    expect(JSON.stringify(response.body)).not.toContain('"id":55');
  });

  it("never attributes legacy account/profile numbers and surfaces incomplete history", async () => {
    const { app } = fixture({ entries: [
      entry({ id: 1, vaId: 42, trackedUserId: null, trackedProfileId: null, endTime: new Date("2026-10-01T10:00:00Z"), durationMinutes: 60 }),
      entry({ id: 2, vaId: 7, trackedUserId: null, trackedProfileId: null, endTime: new Date("2026-10-01T10:00:00Z"), durationMinutes: 60 }),
    ] });
    const response = await request(app).get("/time-tracking/summary");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ entries: [], complete: false, unresolvedEntryCount: 2 });
  });

  it("reports canonical recorded minutes without including voided or unfinished duration", async () => {
    const { app } = fixture({ entries: [
      entry({ id: 1, endTime: new Date(), durationMinutes: 45 }),
      entry({ id: 2, endTime: new Date(), durationSeconds: 900, durationMinutes: 99 }),
      entry({ id: 3, endTime: new Date(), durationMinutes: 90, isVoided: true }),
      entry({ id: 4, durationMinutes: 60 }),
    ] });
    const response = await request(app).get("/time-tracking/summary");
    expect(response.status).toBe(200);
    expect(response.body.totalMinutes).toBe(60);
    expect(response.body.complete).toBe(true);
  });

  it("blocks active reads and starts while any legacy active owner remains unresolved", async () => {
    const { app, inserts } = fixture({ entries: [entry({ vaId: 42, trackedUserId: null })] });
    expect((await request(app).get("/time-tracking/active")).status).toBe(409);
    expect(inserts).toEqual([]);
  });

  it.each(["stop", "pause"])("rejects a missing ID for %s without selecting a replacement", async transition => {
    const { app, updates } = fixture({ entries: [entry()] });
    const response = await request(app).post("/time-tracking/" + transition).send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/entryId.*reload/i);
    expect(updates).toEqual([]);
  });

  it.each(["stop", "pause"])("does not %s a foreign timer even with its exact ID", async transition => {
    const { app, updates } = fixture({ entries: [entry({ trackedUserId: 99, founderId: 99 })] });
    expect((await request(app).post("/time-tracking/" + transition).send({ entryId: 55 })).status).toBe(404);
    expect(updates).toEqual([]);
  });

  it.each(["stop", "pause"])("does not %s a previous founder's entry after ownership changes", async transition => {
    const { app, updates } = fixture({ entries: [entry()], afterMiddleware: [{ ...active, founderId: 9 }] });
    expect((await request(app).post("/time-tracking/" + transition).send({ entryId: 55 })).status).toBe(409);
    expect(updates).toEqual([]);
  });

  it('reports a blocking previous-founder timer without disclosing its entry or card', async () => {
    const { app, updates, inserts } = fixture({ entries: [entry({ founderId: 9, notes: 'private previous-founder notes' })] });
    const response = await request(app).get('/time-tracking/active');
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: expect.stringMatching(/previous founder.*close the exact entry/i) });
    expect(JSON.stringify(response.body)).not.toMatch(/private-task|previous-founder notes|"id":55/);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("a delayed stop replay for A never closes a newly started B", async () => {
    const a = entry({ id: 1, endTime: new Date(), durationSeconds: 60 });
    const b = entry({ id: 2, taskId: "new-task" });
    const { app, updates, rows } = fixture({ entries: [a, b] });
    const response = await request(app).post("/time-tracking/stop").send({ entryId: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ alreadyStopped: true, entry: { id: 1 } });
    expect(rows.get(timeEntries)![1].endTime).toBeNull();
    expect(updates).toEqual([]);
  });
});
