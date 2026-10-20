import type { Request, Router } from "express";
import express from "express";
import request from "supertest";
import { taskAssignments, timeEntries, vaProfiles, type User } from "../../drizzle/schema.postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));

import analyticsRouter from "./analytics";
import reportsRouter from "./reports";

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
  const isInArray = /\bin\b/i.test(operators);
  return isInArray ? values.includes(row[column.name]) : row[column.name] === values[0];
}

function database(profiles: Row[], tasks: Row[] = [], times: Row[] = []) {
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      let condition: unknown;
      const rows = () => {
        const source = table === vaProfiles ? profiles : table === taskAssignments ? tasks : table === timeEntries ? times : [];
        return condition ? source.filter(row => matchesWhere(row, condition)) : source;
      };
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: unknown) => { condition = value; return query; },
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject),
      };
      return query;
    }),
  };
  return db;
}

const worker = { id: 42, openId: "worker-42", name: "Worker", role: "worker" } as User;
const admin = { id: 1, openId: "admin-1", name: "Admin", role: "admin" } as User;
const founder = { id: 7, openId: "founder-7", name: "Founder", role: "user" } as User;

const profiles = [
  { id: 3, userId: 42, founderId: 7, name: "Active Worker", status: "active" },
  { id: 4, userId: 42, founderId: 7, name: "Inactive Worker", status: "inactive" },
];
const tasks = [
  { id: 31, taskId: "active-task", vaId: 3, founderId: 7, status: "completed", assignedAt: new Date("2026-09-01T09:00:00Z"), updatedAt: new Date("2026-09-02T09:00:00Z") },
  { id: 41, taskId: "inactive-task", vaId: 4, founderId: 7, status: "assigned", assignedAt: new Date("2026-09-01T09:00:00Z"), updatedAt: new Date("2026-09-02T09:00:00Z") },
];
const times = [
  { id: 51, taskId: "active-task", vaId: 42, founderId: 7, startTime: new Date("2026-09-02T09:00:00Z"), endTime: new Date("2026-09-02T09:30:00Z"), durationMinutes: 30, durationSeconds: null, isVoided: false },
  { id: 52, taskId: "active-task", vaId: 3, founderId: 7, startTime: new Date("2026-09-02T09:30:00Z"), endTime: new Date("2026-09-02T10:15:00Z"), durationMinutes: 45, durationSeconds: null, isVoided: false },
];

function appFor(path: "/api/analytics" | "/api/reports", route: Router, user: User = worker) {
  const app = express();
  app.use((req: Request, _res, next) => {
    (req as Request & { user?: User }).user = user;
    next();
  });
  app.use(path, route);
  return app;
}

describe("worker profile API access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("limits worker analytics and task exports to the unique active profile", async () => {
    const analyticsDb = database(profiles, tasks, times);
    mocks.getDb.mockResolvedValue(analyticsDb);

    const productivity = await request(appFor("/api/analytics", analyticsRouter))
      .get("/api/analytics/worker-productivity");

    expect(productivity.status).toBe(200);
    expect(productivity.body.productivity).toEqual([expect.objectContaining({
      workerId: 3,
      workerName: "Active Worker",
      totalAssigned: 1,
      completed: 1,
      actualMinutes: 75,
    })]);
    expect(productivity.body.unattributedTimeEntries).toBeUndefined();

    const reportDb = database(profiles, tasks);
    mocks.getDb.mockResolvedValue(reportDb);
    const report = await request(appFor("/api/reports", reportsRouter))
      .get("/api/reports/export?format=csv&type=task-summary");

    expect(report.status).toBe(200);
    expect(report.text).toContain("active-task");
    expect(report.text).not.toContain("inactive-task");
  });

  it("does not attribute another worker's time when profile and account IDs collide", async () => {
    const now = new Date();
    const schedule = {
      workingDays: "0,1,2,3,4,5,6",
      workStartHour: 9,
      workEndHour: 17,
      breakfastTime: null,
      breakfastDuration: null,
      lunchTime: null,
      lunchDuration: null,
      dinnerTime: null,
      dinnerDuration: null,
    };
    const ownProfile = { ...profiles[0], ...schedule };
    const otherProfile = {
      ...schedule,
      id: worker.id,
      userId: 84,
      founderId: 7,
      name: "Other Worker",
      status: "active",
    };
    const scopedTasks = [
      { ...tasks[0], updatedAt: now },
      tasks[1],
      { ...tasks[0], id: 53, taskId: "cross-founder-task", founderId: 99, updatedAt: now },
    ];
    const db = database([ownProfile, otherProfile], scopedTasks, [
      { ...times[0], id: 51, vaId: ownProfile.id, startTime: now, durationMinutes: 30 },
      { ...times[0], id: 52, vaId: worker.id, startTime: now, durationMinutes: 240 },
    ]);
    mocks.getDb.mockResolvedValue(db);

    const productivity = await request(appFor("/api/analytics", analyticsRouter))
      .get("/api/analytics/worker-productivity")
      .expect(200);
    expect(productivity.body.productivity).toEqual([expect.objectContaining({
      workerId: ownProfile.id,
      totalAssigned: 1,
      completed: 1,
      actualMinutes: 30,
    })]);
    expect(productivity.body.unattributedTimeEntries).toBeUndefined();

    const capacity = await request(appFor("/api/analytics", analyticsRouter))
      .get("/api/analytics/team-capacity")
      .expect(200);
    expect(capacity.body.trackedMinutes).toBe(30);
    expect(capacity.body.workers).toEqual([expect.objectContaining({
      workerId: ownProfile.id,
      trackedMinutes: 30,
    })]);
    expect(capacity.body.unattributedTimeEntries).toBeUndefined();

    const trends = await request(appFor("/api/analytics", analyticsRouter))
      .get("/api/analytics/trends")
      .expect(200);
    expect(trends.body.trends.reduce((sum: number, day: { trackedMinutes: number }) => sum + day.trackedMinutes, 0)).toBe(30);
    expect(trends.body.trends.reduce((sum: number, day: { completedTasks: number }) => sum + day.completedTasks, 0)).toBe(1);
    expect(trends.body.trends.every((day: { unattributedTimeEntries?: unknown }) =>
      day.unattributedTimeEntries === undefined
    )).toBe(true);
  });

  it.each([
    { name: "admin", user: admin },
    { name: "founder", user: founder },
  ])("preserves $name access to all of their active and historical profile records", async ({ user }) => {
    const db = database(profiles, tasks);
    mocks.getDb.mockResolvedValue(db);

    const analytics = await request(appFor("/api/analytics", analyticsRouter, user))
      .get("/api/analytics/worker-productivity");

    expect(analytics.status).toBe(200);
    expect(analytics.body.productivity.map((item: { workerId: number }) => item.workerId)).toEqual([3, 4]);

    const report = await request(appFor("/api/reports", reportsRouter, user))
      .get("/api/reports/export?format=csv&type=task-summary");

    expect(report.status).toBe(200);
    expect(report.text).toContain("active-task");
    expect(report.text).toContain("inactive-task");
  });

  it("blocks analytics and report queries for inactive or ambiguous worker profiles", async () => {
    const endpoints = [
      { app: appFor("/api/analytics", analyticsRouter), url: "/api/analytics/worker-productivity" },
      { app: appFor("/api/reports", reportsRouter), url: "/api/reports/export?format=csv&type=task-summary" },
    ];
    const profileCases = [
      [{ id: 3, status: "inactive" }],
      [{ id: 3, status: "active" }, { id: 4, status: "active" }],
    ];

    for (const endpoint of endpoints) {
      for (const profiles of profileCases) {
        const db = database(profiles);
        mocks.getDb.mockResolvedValue(db);

        const response = await request(endpoint.app).get(endpoint.url);

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: "An active worker profile is required" });
        expect(mocks.getDb).toHaveBeenCalledOnce();
        expect(db.select).toHaveBeenCalledOnce();
        mocks.getDb.mockClear();
      }
    }
  });
});
