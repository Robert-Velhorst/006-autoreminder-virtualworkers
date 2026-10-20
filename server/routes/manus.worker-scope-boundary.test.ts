import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
import { cardSnoozes, timeEntries, users, weeklyPayLog } from "../../drizzle/schema.postgres";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getActiveWorkerProfileResolution: vi.fn(),
  isManagerPilotWorker: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../workerOperatorContext", async importOriginal => ({
  ...(await importOriginal<typeof import("../workerOperatorContext")>()),
  getActiveWorkerProfileResolution: mocks.getActiveWorkerProfileResolution,
}));
vi.mock("../aptlssManagerPilot", () => ({ isManagerPilotWorker: mocks.isManagerPilotWorker }));

import { cardSnoozeRouter, payLogRouter, timerRouter } from "./manus";

type MockRows = {
  users: Array<Record<string, unknown>>;
  cardSnoozes: Array<Record<string, unknown>>;
  timeEntries: Array<Record<string, unknown>>;
  weeklyPayLog: Array<Record<string, unknown>>;
};

function matchesWhere(row: Record<string, unknown>, condition: unknown): boolean {
  const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const nestedSql = chunks.filter((chunk): chunk is { queryChunks: unknown[] } =>
    typeof chunk === "object" && chunk !== null && "queryChunks" in chunk
      && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)
  );
  if (nestedSql.length) return nestedSql.every(child => matchesWhere(row, child));

  const column = chunks.find((chunk): chunk is { name: string; table: unknown } =>
    typeof chunk === "object" && chunk !== null && "name" in chunk && "table" in chunk
      && typeof (chunk as { name?: unknown }).name === "string"
  );
  if (!column) return true;

  const values: unknown[] = [];
  const collectParams = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collectParams);
    else if (typeof value === "object" && value !== null) {
      if ("encoder" in value && "value" in value) values.push((value as { value: unknown }).value);
      else if ("queryChunks" in value) collectParams((value as { queryChunks: unknown[] }).queryChunks);
    }
  };
  collectParams(chunks);
  return row[column.name] === values[0];
}

function makeDb(options: {
  initialRows?: Partial<MockRows>;
  beforeUpdate?: (table: unknown, rows: MockRows) => void;
} = {}) {
  const rows: MockRows = {
    users: [{ id: 10 }, { id: 20 }],
    cardSnoozes: [],
    timeEntries: [],
    weeklyPayLog: [],
    ...options.initialRows,
  };
  let nextSnoozeId = Math.max(0, ...rows.cardSnoozes.map(row => Number(row.id) || 0)) + 1;
  let beforeUpdate = options.beforeUpdate;

  const tableRows = (table: unknown) => table === users ? rows.users
    : table === cardSnoozes ? rows.cardSnoozes
      : table === timeEntries ? rows.timeEntries
        : table === weeklyPayLog ? rows.weeklyPayLog
          : [];

  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      let condition: unknown;
      let rowLimit = Number.POSITIVE_INFINITY;
      const query: any = {
        from(value: unknown) { table = value; return query; },
        where(value: unknown) { condition = value; return query; },
        orderBy() { return query; },
        limit(value: number) { rowLimit = value; return query; },
        for() { return Promise.resolve(tableRows(table).filter(row => matchesWhere(row, condition)).slice(0, rowLimit)); },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve(tableRows(table).filter(row => matchesWhere(row, condition)).slice(0, rowLimit))
            .then(resolve, reject);
        },
      };
      return query;
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where: async (condition: unknown) => {
            beforeUpdate?.(table, rows);
            beforeUpdate = undefined;
            const matching = tableRows(table).filter(row => matchesWhere(row, condition));
            const changed = matching.filter(row => Object.entries(values).some(([key, value]) => {
              const previous = row[key];
              if (previous instanceof Date && value instanceof Date) return previous.getTime() !== value.getTime();
              return previous !== value;
            }));
            matching.forEach(row => Object.assign(row, values));
            return [{ affectedRows: changed.length }];
          },
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === cardSnoozes) rows.cardSnoozes.push({ id: nextSnoozeId++, ...values });
        return [{ insertId: nextSnoozeId - 1 }];
      },
    })),
    transaction: vi.fn(async (run: (database: any) => Promise<unknown>) => run(tx)),
  };

  return { db: tx, rows };
}

function context(id: number, role: "worker" | "admin" | "user" = "worker") {
  return {
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id, openId: `test-${id}`, role } as TrpcContext["user"],
  } as TrpcContext;
}

describe("legacy Manus worker-scope boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveWorkerProfileResolution.mockImplementation(async (userId: number) => ({
      profileId: userId + 100,
      ambiguous: false,
    }));
    mocks.isManagerPilotWorker.mockReturnValue(false);
  });

  it("ignores a caller-supplied worker ID when a worker reads pay history", async () => {
    const ownEntry = { id: 1, vaId: 10, weekStart: new Date("2026-09-21T00:00:00Z") };
    const otherEntry = { id: 2, vaId: 20, weekStart: new Date("2026-09-21T00:00:00Z") };
    const { db } = makeDb({ initialRows: { weeklyPayLog: [ownEntry, otherEntry] } });
    mocks.getDb.mockResolvedValue(db);

    const result = await payLogRouter.createCaller(context(10)).getAll({ vaId: 20 });

    expect(result).toEqual([ownEntry]);
  });

  it("makes repeated snooze submissions idempotent and keeps the state per worker", async () => {
    const { db, rows } = makeDb();
    mocks.getDb.mockResolvedValue(db);
    const snooze = (workerId: number, snoozedUntil: Date) => cardSnoozeRouter.createCaller(context(workerId)).snooze({
      cardId: "card-123",
      cardName: "Assigned card",
      cardUrl: "https://trello.com/c/card-123",
      snoozedUntil,
    });

    await snooze(10, new Date("2026-09-27T00:00:00Z"));
    await snooze(10, new Date("2026-09-28T00:00:00Z"));
    await snooze(20, new Date("2026-09-29T00:00:00Z"));

    expect(rows.cardSnoozes).toHaveLength(2);
    expect(rows.cardSnoozes).toEqual(expect.arrayContaining([
      expect.objectContaining({ vaId: 10, cardId: "card-123", isActive: true, snoozedUntil: new Date("2026-09-28T00:00:00Z") }),
      expect.objectContaining({ vaId: 20, cardId: "card-123", isActive: true, snoozedUntil: new Date("2026-09-29T00:00:00Z") }),
    ]));
  });

  it("does not update a time entry if its ownership changes after the scoped read", async () => {
    const entry = {
      id: 51,
      vaId: 10,
      startTime: new Date("2026-09-26T10:00:00Z"),
      endTime: null,
      durationSeconds: null,
      durationMinutes: null,
    };
    const { db, rows } = makeDb({
      initialRows: { timeEntries: [entry] },
      beforeUpdate: (table, currentRows) => {
        if (table === timeEntries) currentRows.timeEntries[0].vaId = 20;
      },
    });
    mocks.getDb.mockResolvedValue(db);

    await expect(timerRouter.createCaller(context(10)).updateEntry({ id: 51, durationSeconds: 900 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(rows.timeEntries[0]).toMatchObject({ vaId: 20, endTime: null, durationSeconds: null });
  });

  it("allows a worker to update their own time entry", async () => {
    const entry = {
      id: 52,
      vaId: 10,
      startTime: new Date("2026-09-26T10:00:00Z"),
      endTime: null,
      durationSeconds: null,
      durationMinutes: null,
    };
    const { db, rows } = makeDb({ initialRows: { timeEntries: [entry] } });
    mocks.getDb.mockResolvedValue(db);

    const result = await timerRouter.createCaller(context(10)).updateEntry({ id: 52, durationSeconds: 900 });

    expect(result).toMatchObject({ success: true, id: 52, durationSeconds: 900 });
    expect(rows.timeEntries[0]).toMatchObject({
      vaId: 10,
      durationSeconds: 900,
      durationMinutes: 15,
      endTime: new Date("2026-09-26T10:15:00Z"),
    });
  });

  it("treats an unchanged time-entry update as a successful replay", async () => {
    const entry = {
      id: 53,
      vaId: 10,
      startTime: new Date("2026-09-26T10:00:00Z"),
      endTime: new Date("2026-09-26T10:15:00Z"),
      durationSeconds: 900,
      durationMinutes: 15,
    };
    const { db } = makeDb({ initialRows: { timeEntries: [entry] } });
    mocks.getDb.mockResolvedValue(db);

    await expect(timerRouter.createCaller(context(10)).updateEntry({ id: 53, durationSeconds: 900 }))
      .resolves.toMatchObject({ success: true, id: 53, durationSeconds: 900 });
  });

  it("rejects generic authenticated accounts before opening the database", async () => {
    const { db } = makeDb();
    mocks.getDb.mockResolvedValue(db);

    await expect(cardSnoozeRouter.createCaller(context(10, "user")).snooze({
      cardId: "card-123",
      cardName: "Assigned card",
      cardUrl: "https://trello.com/c/card-123",
      snoozedUntil: new Date("2026-09-27T00:00:00Z"),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
