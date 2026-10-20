import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../drizzle/schema.postgres";
const { query, getDb } = vi.hoisted(() => ({ query: vi.fn(), getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb, incrementPayLogD1: vi.fn() }));
import {
  getAllReplyThreads, getAllUnsignedFlags, getAllVagueReplyFlags,
  deactivateMissingTrelloReplyThreads, MAX_REPLY_MONITOR_PAGE_SIZE,
  normalizeReplyMonitorLimit, resolveUnsignedFlag, resolveVagueReplyFlag,
  upsertReplyThread,
} from "./replyMonitorDb";

describe("reply monitor PostgreSQL data access", () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
    // Real Drizzle compiles and maps the PG queries; only the network is mocked.
    getDb.mockResolvedValue(drizzle({ query } as never, { schema }));
  });
  it("bounds pages, including invalid caller limits", async () => {
    await getAllReplyThreads(7, Infinity);
    await getAllVagueReplyFlags(7, -3);
    await getAllUnsignedFlags(7, 10000);
    expect(query.mock.calls.map(call => call[1].at(-1))).toEqual([100, 1, MAX_REPLY_MONITOR_PAGE_SIZE]);
  });
  it("scopes both manual resolutions to the authenticated worker", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    await expect(resolveVagueReplyFlag(7, 41)).resolves.toBe(true);
    await expect(resolveUnsignedFlag(7, 42, "Checked with client")).resolves.toBe(true);
    for (const [configuration, values] of query.mock.calls) {
      expect(configuration.text).toMatch(/where .*"id" = \$[0-9]+.*"vaId" = \$[0-9]+.*"resolvedAt" is null/i);
      expect(values.slice(-2)).toEqual([values.includes(41) ? 41 : 42, 7]);
    }
    expect(query.mock.calls[1][1]).toContain("Checked with client");
  });
  it("treats already resolved owned flags as idempotent while rejecting foreign flags", async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [[41]] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(resolveVagueReplyFlag(7, 41)).resolves.toBe(true);
    await expect(resolveUnsignedFlag(7, 42)).resolves.toBe(false);
    expect(query.mock.calls[1][1]).toEqual([41, 7, 1]);
    expect(query.mock.calls[3][1]).toEqual([42, 7, 1]);
  });
  it("propagates storage failures", async () => {
    query.mockRejectedValue(new Error("database unavailable"));
    await expect(resolveVagueReplyFlag(7, 41)).rejects.toMatchObject({ cause: { message: "database unavailable" } });
    await expect(resolveUnsignedFlag(7, 42)).rejects.toMatchObject({ cause: { message: "database unavailable" } });
  });
  it("normalizes invalid page values", () => {
    expect(normalizeReplyMonitorLimit(undefined, 50)).toBe(50);
    expect(normalizeReplyMonitorLimit(2.9, 50)).toBe(2);
    expect(normalizeReplyMonitorLimit(NaN, 50)).toBe(50);
  });
  it("deactivates only missing active Trello threads in the worker's scope", async () => {
    query.mockResolvedValue({ rowCount: 2, rows: [] });
    expect(await deactivateMissingTrelloReplyThreads(7, ["a", "b"])).toBe(2);
    const [configuration, values] = query.mock.calls[0];
    expect(configuration.text).toContain('"cardId" not in');
    expect(values).toEqual(expect.arrayContaining([7, "trello", "pending", "overdue", "a", "b"]));
  });
  it("upserts canonical PG reply evidence under the worker/card/source unique key", async () => {
    await upsertReplyThread(7, { source: "trello", cardId: "a", cardName: "A", cardUrl: "https://trello.com/c/a",
      boardName: "Board", listName: "Doing", lastNonWorkerMsgAt: new Date("2026-08-14T12:00:00Z"),
      lastNonWorkerAuthor: "Client", lastNonWorkerText: "Please confirm.", lastWorkerReplyAt: null,
      status: "pending", demerited: false });
    expect(query.mock.calls[0][0].text).toContain('on conflict ("vaId","cardId","source") do update');
    expect(query.mock.calls[0][1]).toContain("Please confirm.");
  });
});
