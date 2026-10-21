import express from "express";
import request from "supertest";
import superjson from "superjson";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), workerResolution: vi.fn(), workerContext: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../workerOperatorContext", async importOriginal => ({
  ...await importOriginal<typeof import("../workerOperatorContext")>(),
  getActiveWorkerProfileResolution: mocks.workerResolution,
  resolveWorkerOperatorContextById: mocks.workerContext,
}));
import { router } from "../_core/trpc";
import { settingsRouter } from "./settings";
import { getBrowserTabStatus } from "../browserTabHygiene";

type Row = { id: number; vaId: number | null; key: string; value: string };
const actors = new Map([
  [101, "worker"], [202, "worker"], [303, "worker"], [404, "worker"],
  [1, "admin"], [2, "user"], [3, "founder"],
]);
const scheduleA = { startTime: "08:00", endTime: "17:00", breaks: [{ name: "Break", startTime: "12:00", durationMinutes: 30 }], typingPractice: true, typingPracticeMinutes: 15 };
const scheduleB = { startTime: "10:00", endTime: "19:00", breaks: [{ name: "Break", startTime: "14:00", durationMinutes: 45 }], typingPractice: false, typingPracticeMinutes: 0 };

// Real Drizzle SQL and real HTTP/tRPC handlers; only the native pg boundary is
// replaced. The store enforces the canonical globally unique app_settings.key.
function memoryPostgres(initial: Row[] = []) {
  const rows = structuredClone(initial);
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const query = vi.fn(async (config: { text: string; rowMode?: string }, params: unknown[] = []) => {
    const text = config.text;
    queries.push({ text, params });
    const output = (result: Row[]) => ({ rows: result.map(row => text.startsWith("insert")
      ? [row.id] : text.startsWith('select "value"') ? [row.value] : [row.id, row.vaId, row.key, row.value]), rowCount: result.length });
    if (text.startsWith("select")) {
      const keys = params.filter((value): value is string => typeof value === "string");
      const owner = params.find(value => typeof value === "number");
      return output(rows.filter(row => keys.includes(row.key)
        && (!text.includes('"app_settings"."vaId" =') || row.vaId === owner)));
    }
    if (text.startsWith("insert")) {
      const [vaId, key, value] = params as [number, string, string];
      const existing = rows.find(row => row.key === key);
      if (existing) {
        const guard = /where "app_settings"\."vaId" = \$(\d+)/.exec(text);
        if (guard && existing.vaId !== params[Number(guard[1]) - 1]) return output([]);
        existing.value = value;
        return output([existing]);
      }
      const row = { id: Math.max(0, ...rows.map(item => item.id)) + 1, vaId, key, value };
      rows.push(row);
      return output([row]);
    }
    throw new Error("Unexpected settings fixture SQL");
  });
  return { db: drizzle({ query } as unknown as Client), rows, queries };
}

const app = express().use(express.json()).use("/api/trpc", createExpressMiddleware({
  router: router({ settings: settingsRouter }),
  createContext: ({ req, res }) => {
    const id = Number(req.headers["x-fixture-actor"]);
    const role = actors.get(id);
    return { req, res, user: role ? {
      id, openId: `synthetic-${id}`, role, name: `Synthetic ${id}`, email: null,
      loginMethod: "local", passwordHash: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } : null } as TrpcContext;
  },
}));

function get(actor: number, method: string) {
  return request(app).get(`/api/trpc/settings.${method}`).set("x-fixture-actor", String(actor));
}
function set(actor: number, method: string, input: unknown) {
  return request(app).post(`/api/trpc/settings.${method}`).set("x-fixture-actor", String(actor)).send(superjson.serialize(input));
}
function result(response: request.Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return superjson.deserialize(response.body.result.data);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workerResolution.mockImplementation(async (id: number) => ({
    profileId: [101, 202].includes(id) ? id + 1000 : null, ambiguous: id === 404,
  }));
  mocks.workerContext.mockResolvedValue({ timezone: "UTC", workEndTime: "18:00" });
});

describe("personal app settings HTTP worker isolation", () => {
  it("feeds each HTTP-saved schedule into real browser hygiene status without trusting retained legacy values", async () => {
    const database = memoryPostgres([{ id: 1, vaId: 101, key: "daily_schedule", value: JSON.stringify({ endTime: "23:00" }) }]);
    mocks.getDb.mockResolvedValue(database.db);
    result(await set(101, "setSchedule", scheduleA));
    result(await set(202, "setSchedule", scheduleB));
    expect((await getBrowserTabStatus(101)).workEnd).toBe("17:00");
    expect((await getBrowserTabStatus(202)).workEnd).toBe("19:00");
    expect(database.rows[0].key).toBe("daily_schedule");
    expect(database.rows[0].value).toContain("23:00");
  });

  it.each([
    { key: "daily_schedule", vaId: 101 }, { key: "daily_schedule", vaId: 202 },
    { key: "daily_schedule:101", vaId: 202 }, { key: "daily_schedule:101", vaId: null },
  ])("browser status rejects unverified schedule $key owner $vaId without writing", async ({ key, vaId }) => {
    const database = memoryPostgres([{ id: 1, vaId, key, value: JSON.stringify(scheduleB) }]);
    mocks.getDb.mockResolvedValue(database.db);
    await expect(getBrowserTabStatus(101)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(database.queries.every(query => query.text.startsWith("select"))).toBe(true);
  });

  it("does not use another worker's canonical schedule when this worker has none", async () => {
    const database = memoryPostgres([{ id: 1, vaId: 202, key: "daily_schedule:202", value: JSON.stringify(scheduleB) }]);
    mocks.getDb.mockResolvedValue(database.db);
    expect((await getBrowserTabStatus(101)).workEnd).toBe("18:00");
    expect((await getBrowserTabStatus(202)).workEnd).toBe("19:00");
  });

  it("round-trips two workers' goals, schedules and badge preferences independently, including repeated updates", async () => {
    const database = memoryPostgres(); mocks.getDb.mockResolvedValue(database.db);
    result(await set(101, "setDailyGoal", { hours: 6 }));
    result(await set(202, "setDailyGoal", { hours: 10 }));
    result(await set(101, "setSchedule", scheduleA));
    result(await set(202, "setSchedule", scheduleB));
    result(await set(101, "setReplyMonitorBadge", { enabled: false }));
    result(await set(202, "setReplyMonitorBadge", { enabled: true }));
    expect(result(await get(101, "getDailyGoal"))).toEqual({ hours: 6 });
    expect(result(await get(202, "getDailyGoal"))).toEqual({ hours: 10 });
    expect(result(await get(101, "getSchedule"))).toEqual(scheduleA);
    expect(result(await get(202, "getSchedule"))).toEqual(scheduleB);
    expect(result(await get(101, "getReplyMonitorBadge"))).toEqual({ enabled: false });
    expect(result(await get(202, "getReplyMonitorBadge"))).toEqual({ enabled: true });
    result(await set(202, "setDailyGoal", { hours: 12 }));
    expect(result(await get(101, "getDailyGoal"))).toEqual({ hours: 6 });
    expect(result(await get(202, "getDailyGoal"))).toEqual({ hours: 12 });
    expect(database.rows).toHaveLength(6);
    expect(database.rows.every(row => row.key.endsWith(`:${row.vaId}`))).toBe(true);
  });

  it("handles concurrent independent worker saves without sharing a unique key", async () => {
    const database = memoryPostgres(); mocks.getDb.mockResolvedValue(database.db);
    const responses = await Promise.all([set(101, "setDailyGoal", { hours: 5 }), set(202, "setDailyGoal", { hours: 11 })]);
    responses.forEach(result);
    expect(result(await get(101, "getDailyGoal"))).toEqual({ hours: 5 });
    expect(result(await get(202, "getDailyGoal"))).toEqual({ hours: 11 });
  });

  it("keeps admin personal settings independent and ignores submitted identity overrides", async () => {
    const database = memoryPostgres(); mocks.getDb.mockResolvedValue(database.db);
    result(await set(101, "setDailyGoal", { hours: 7, vaId: 202, userId: 202 }));
    result(await set(1, "setDailyGoal", { hours: 4, vaId: 101 }));
    expect(result(await get(101, "getDailyGoal"))).toEqual({ hours: 7 });
    expect(result(await get(1, "getDailyGoal"))).toEqual({ hours: 4 });
    expect(result(await get(202, "getDailyGoal"))).toEqual({ hours: 9 });
    expect(database.rows.map(row => row.vaId).sort()).toEqual([1, 101]);
  });

  it.each([
    { key: "daily_hour_goal", get: "getDailyGoal", set: "setDailyGoal", legacy: "13", input: { hours: 6 } },
    { key: "daily_schedule", get: "getSchedule", set: "setSchedule", legacy: JSON.stringify(scheduleB), input: scheduleA },
    { key: "reply_monitor_badge_enabled", get: "getReplyMonitorBadge", set: "setReplyMonitorBadge", legacy: "false", input: { enabled: true } },
  ])("retains ambiguous historical $key rows without trusting or overwriting their value", async setting => {
    const legacy = { id: 1, vaId: 101, key: setting.key, value: setting.legacy };
    const database = memoryPostgres([legacy]); mocks.getDb.mockResolvedValue(database.db);
    const read = await get(101, setting.get);
    expect(read.status).toBe(412);
    expect(read.body.error.json.data.code).toBe("PRECONDITION_FAILED");
    expect(database.rows).toEqual([legacy]);
    result(await set(101, setting.set, setting.input));
    result(await set(202, setting.set, setting.input));
    expect(database.rows.find(row => row.key === setting.key)).toEqual(legacy);
    result(await get(101, setting.get)); result(await get(202, setting.get));
    expect(database.rows).toHaveLength(3);
  });

  it.each([202, null])("rejects a scoped key with mismatched or missing owner %j without adopting it", async vaId => {
    const retained = { id: 1, vaId, key: "daily_hour_goal:101", value: "13" };
    const database = memoryPostgres([retained]); mocks.getDb.mockResolvedValue(database.db);
    expect((await get(101, "getDailyGoal")).status).toBe(412);
    expect((await set(101, "setDailyGoal", { hours: 6 })).status).toBe(412);
    expect(database.rows).toEqual([retained]);
    const insert = database.queries.find(query => query.text.startsWith("insert"))!;
    expect(insert.text).toMatch(/where "app_settings"\."vaId" = \$\d+/);
    expect(insert.text).toContain('returning "id"');
  });

  it.each([
    { actor: 0, status: 401 }, { actor: 2, status: 403 }, { actor: 3, status: 403 },
    { actor: 303, status: 403 }, { actor: 404, status: 412 },
  ])("rejects anonymous, wrong-role, inactive or ambiguous actors: $actor", async ({ actor, status }) => {
    const database = memoryPostgres(); mocks.getDb.mockResolvedValue(database.db);
    for (const method of ["getDailyGoal", "getSchedule", "getReplyMonitorBadge"]) expect((await get(actor, method)).status).toBe(status);
    for (const [method, input] of [["setDailyGoal", { hours: 6 }], ["setSchedule", scheduleA], ["setReplyMonitorBadge", { enabled: false }]] as const) {
      expect((await set(actor, method, input)).status).toBe(status);
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(database.rows).toEqual([]);
  });

  it("does not persist invalid goals or schedules", async () => {
    const database = memoryPostgres(); mocks.getDb.mockResolvedValue(database.db);
    expect((await set(101, "setDailyGoal", { hours: 17 })).status).toBe(400);
    expect((await set(101, "setSchedule", { ...scheduleA, startTime: "18:00", endTime: "17:00" })).status).toBe(400);
    expect(database.rows).toEqual([]);
  });
});
