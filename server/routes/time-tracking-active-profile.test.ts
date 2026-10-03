import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { timeEntries, users, vaProfiles } from "../../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  isManagerPilotWorker: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));
vi.mock("../aptlssManagerQueue", () => ({ enqueueManagerTask: vi.fn() }));

import timeTrackingRoutes from "./time-tracking";

type Profile = { id: number; status: string; founderId?: number; userId?: number };
type Endpoint = {
  method: "get" | "post";
  path: string;
  body?: Record<string, unknown>;
};

const workerEndpoints: Endpoint[] = [
  { method: "get", path: "/time-tracking/active" },
  { method: "get", path: "/time-tracking/task/task-1" },
  { method: "get", path: "/time-tracking/summary" },
  { method: "get", path: "/time-tracking/weekly-progress" },
  { method: "post", path: "/time-tracking/start", body: { taskId: "task-1" } },
  { method: "post", path: "/time-tracking/stop" },
  { method: "post", path: "/time-tracking/pause" },
];

function makeDb(profiles: Profile[] = [], options: {
  directEntries?: Array<Record<string, unknown>>;
  transactionEntries?: Array<Record<string, unknown>>;
  profileAfterMiddleware?: Profile[];
  profileCollisions?: Profile[];
  otherAccountIds?: number[];
} = {}) {
  const transactionReads: unknown[] = [];
  const directReads: unknown[] = [];
  const transactionReadCounts = new Map<unknown, number>();
  const directReadCounts = new Map<unknown, number>();
  let profileReadCount = 0;
  const insertedValues: Array<Record<string, unknown>> = [];
  let insertedEntry: Record<string, unknown> | null = null;

  function query(readTables: unknown[], readCounts: Map<unknown, number>, rowsFor: (table: unknown, count: number) => unknown[]) {
    let table: unknown;
    let rows: unknown[] = [];
    const builder: any = {
      from: vi.fn((value: unknown) => {
        table = value;
        readTables.push(value);
        const count = (readCounts.get(value) ?? 0) + 1;
        readCounts.set(value, count);
        rows = rowsFor(value, count);
        return builder;
      }),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  }

  const transactionInsert = vi.fn(() => ({
    values: vi.fn(async (values: Record<string, unknown>) => {
      insertedValues.push(values);
      insertedEntry = { id: 501, ...values, startTime: new Date(), endTime: null };
      return [{ insertId: 501 }];
    }),
  }));
  const transactionUpdate = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => []) })),
  }));

  const transaction = {
    select: vi.fn(() => query(transactionReads, transactionReadCounts, (table, count) => {
      if (table === vaProfiles) {
        const profileRead = profileReadCount++;
        if (profileRead === 0) return profiles;
        if (profileRead === 1) return options.profileAfterMiddleware ?? profiles;
        return options.profileCollisions ?? profiles;
      }
      if (table === users) return [{ id: 42 }, ...(options.otherAccountIds ?? []).map(id => ({ id }))];
      if (table === timeEntries) return options.transactionEntries
        ?? (count === 1 ? [] : insertedEntry ? [insertedEntry] : []);
      return [];
    })),
    insert: transactionInsert,
    update: transactionUpdate,
  };

  const db = {
    select: vi.fn(() => query(directReads, directReadCounts, () => options.directEntries ?? [])),
    transaction: vi.fn(async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction)),
  };

  return { db, directReads, transactionReads, transactionInsert, transactionUpdate, insertedValues };
}

function createApp(role: "worker" | "user" | "admin", db: ReturnType<typeof makeDb>["db"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 42, openId: `${role}-42`, role, name: "Test user" };
    next();
  });
  app.use(timeTrackingRoutes);
  mocks.getDb.mockResolvedValue(db);
  return app;
}

async function callEndpoint(app: express.Express, endpoint: Endpoint) {
  const test = endpoint.method === "get"
    ? request(app).get(endpoint.path)
    : request(app).post(endpoint.path).send(endpoint.body ?? {});
  return test;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isManagerPilotWorker.mockReturnValue(false);
});

describe.each([
  { label: "no profile", profiles: [] as Profile[] },
  { label: "inactive profile", profiles: [{ id: 7, status: "inactive" }] as Profile[] },
])("worker access with $label", ({ profiles }) => {
  it.each(workerEndpoints)("denies $method $path before timer access", async endpoint => {
    const { db, directReads, transactionReads, transactionInsert, transactionUpdate } = makeDb(profiles);
    const response = await callEndpoint(createApp("worker", db), endpoint);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "An active worker profile is required" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(transactionReads).toEqual([vaProfiles]);
    expect(directReads).toEqual([]);
    expect(transactionInsert).not.toHaveBeenCalled();
    expect(transactionUpdate).not.toHaveBeenCalled();
  });
});

describe.each(["user", "admin"] as const)("existing %s access", role => {
  it("keeps summary reads available without a worker profile", async () => {
    const { db, directReads, transactionReads } = makeDb();
    const response = await callEndpoint(createApp(role, db), { method: "get", path: "/time-tracking/summary" });

    expect(response.status).toBe(200);
    expect(directReads).toEqual([timeEntries]);
    expect(transactionReads).toEqual([]);
  });

  it("keeps timer start available without a worker profile", async () => {
    const { db, transactionReads, transactionInsert, insertedValues } = makeDb();
    const response = await callEndpoint(createApp(role, db), {
      method: "post",
      path: "/time-tracking/start",
      body: { taskId: "task-1" },
    });

    expect(response.status).toBe(200);
    expect(transactionReads).toContain(users);
    expect(transactionReads).toContain(timeEntries);
    expect(transactionReads).not.toContain(vaProfiles);
    expect(transactionInsert).toHaveBeenCalledTimes(1);
    expect(insertedValues[0]).toMatchObject({ vaId: 42, founderId: 42, taskId: "task-1" });
  });
});

describe("worker timer entry ownership", () => {
  const activeProfile = [{ id: 7, userId: 42, founderId: 8, status: "active" }];
  const foreignEntry = {
    id: 900,
    vaId: 42,
    founderId: 99,
    taskId: "another-founder's-task",
    startTime: new Date("2026-09-26T09:00:00.000Z"),
    endTime: null,
    durationMinutes: 45,
  };

  it.each([
    { method: "get" as const, path: "/time-tracking/active" },
    { method: "get" as const, path: "/time-tracking/task/another-founder's-task" },
    { method: "get" as const, path: "/time-tracking/summary" },
    { method: "get" as const, path: "/time-tracking/weekly-progress" },
  ])("does not expose another founder's timer through $path", async endpoint => {
    const { db } = makeDb(activeProfile, { transactionEntries: [foreignEntry] });
    const response = await callEndpoint(createApp("worker", db), endpoint);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("another-founder's-task");
    expect(JSON.stringify(response.body)).not.toContain('"id":900');
    if (endpoint.path === "/time-tracking/weekly-progress") {
      expect(response.body.actualMinutes).toBe(0);
    }
  });

  it("includes this worker's legacy profile-ID and account-ID entries in the summary", async () => {
    const ownEntries = [
      { ...foreignEntry, id: 901, vaId: 42, founderId: 8, taskId: "account-row", durationMinutes: 30 },
      { ...foreignEntry, id: 902, vaId: 7, founderId: 8, taskId: "profile-row", durationMinutes: 45 },
    ];
    const { db } = makeDb(activeProfile, { transactionEntries: ownEntries });
    const response = await callEndpoint(createApp("worker", db), { method: "get", path: "/time-tracking/summary" });

    expect(response.status).toBe(200);
    expect(response.body.totalMinutes).toBe(75);
    expect(response.body.entries.map((entry: { taskId: string }) => entry.taskId).sort())
      .toEqual(["account-row", "profile-row"]);
  });

  it.each([
    { method: "get" as const, path: "/time-tracking/task/task-1" },
    { method: "get" as const, path: "/time-tracking/summary" },
    { method: "get" as const, path: "/time-tracking/weekly-progress" },
  ])("warns when $path omits history with an ambiguous owner ID", async endpoint => {
    const ambiguousHistory = {
      ...foreignEntry,
      id: 902,
      vaId: 42,
      founderId: 8,
      taskId: "task-1",
      endTime: new Date("2026-09-26T09:45:00.000Z"),
    };
    const { db } = makeDb(activeProfile, {
      transactionEntries: [ambiguousHistory],
      profileCollisions: [{ id: 42, userId: 77, founderId: 8, status: "active" }],
      otherAccountIds: [],
    });

    const response = await callEndpoint(createApp("worker", db), endpoint);

    expect(response.status).toBe(200);
    expect(response.body.ownershipWarning).toMatch(/ownership overlaps another account or profile ID/i);
    expect(JSON.stringify(response.body)).not.toContain("ambiguousHistory");
    expect(JSON.stringify(response.body)).not.toContain('"id":902');
  });

  it.each([
    {
      label: "another worker's profile ID",
      profileCollisions: [{ id: 42, userId: 77, founderId: 8, status: "active" }],
      otherAccountIds: [],
      entryVaId: 42,
    },
    {
      label: "another account's ID",
      profileCollisions: [],
      otherAccountIds: [7],
      entryVaId: 7,
    },
  ])("fails closed when a timer identity collides with $label", async collision => {
    const ambiguousEntry = {
      ...foreignEntry,
      id: 901,
      vaId: collision.entryVaId,
      founderId: 8,
      taskId: "ambiguous-same-founder-entry",
    };
    const getDbFixture = makeDb(activeProfile, {
      transactionEntries: [ambiguousEntry],
      profileCollisions: collision.profileCollisions,
      otherAccountIds: collision.otherAccountIds,
    });
    const getResponse = await callEndpoint(createApp("worker", getDbFixture.db), {
      method: "get",
      path: "/time-tracking/active",
    });

    expect(getResponse.status).toBe(409);
    expect(getResponse.body.error).toMatch(/ownership overlaps another account or profile ID/i);
    expect(JSON.stringify(getResponse.body)).not.toContain("ambiguous-same-founder-entry");

    const stopDbFixture = makeDb(activeProfile, {
      transactionEntries: [ambiguousEntry],
      profileCollisions: collision.profileCollisions,
      otherAccountIds: collision.otherAccountIds,
    });
    const stopResponse = await callEndpoint(createApp("worker", stopDbFixture.db), {
      method: "post",
      path: "/time-tracking/stop",
    });
    expect(stopResponse.status).toBe(409);
    expect(stopDbFixture.transactionUpdate).not.toHaveBeenCalled();
  });

  it.each(["stop", "pause"] as const)("does not %s another founder's active timer through an account/profile ID collision", async transition => {
    const { db, transactionUpdate } = makeDb(activeProfile, { transactionEntries: [foreignEntry] });
    const response = await callEndpoint(createApp("worker", db), {
      method: "post",
      path: `/time-tracking/${transition}`,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "No active timer found" });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it.each(["stop", "pause"] as const)("does not %s a timer from a former founder after the profile is transferred", async transition => {
    const previousFounderEntry = { ...foreignEntry, founderId: 8 };
    const transferredProfile = [{ id: 7, userId: 42, founderId: 9, status: "active" }];
    const { db, transactionUpdate } = makeDb(activeProfile, {
      transactionEntries: [previousFounderEntry],
      profileAfterMiddleware: transferredProfile,
    });
    const response = await callEndpoint(createApp("worker", db), {
      method: "post",
      path: `/time-tracking/${transition}`,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "No active timer found" });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });
});
