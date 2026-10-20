import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, getDb } = vi.hoisted(() => ({
  execute: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb,
  incrementPayLogD1: vi.fn(),
}));

import {
  getAllReplyThreads,
  getAllUnsignedFlags,
  getAllVagueReplyFlags,
  deactivateMissingTrelloReplyThreads,
  MAX_REPLY_MONITOR_PAGE_SIZE,
  normalizeReplyMonitorLimit,
  resolveUnsignedFlag,
  resolveVagueReplyFlag,
  upsertReplyThread,
} from "./replyMonitorDb";

describe("reply monitor data access", () => {
  beforeEach(() => {
    execute.mockReset();
    getDb.mockResolvedValue({ execute });
  });

  it("clamps result limits before using them in database queries", async () => {
    execute.mockResolvedValue([[]]);

    await getAllReplyThreads(7, Number.POSITIVE_INFINITY);
    await getAllVagueReplyFlags(7, -3);
    await getAllUnsignedFlags(7, 10_000);

    expect(execute.mock.calls).toHaveLength(3);
    for (const call of execute.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[0]).not.toBeTypeOf("string");
    }
  });

  it("scopes manual flag resolution to the authenticated worker", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);

    await resolveVagueReplyFlag(7, 41);
    await resolveUnsignedFlag(7, 42, "Checked with the client");

    for (const call of execute.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[0]).not.toBeTypeOf("string");
    }
  });

  it("normalizes invalid values without allowing an unbounded query", () => {
    expect(normalizeReplyMonitorLimit(undefined, 50)).toBe(50);
    expect(normalizeReplyMonitorLimit(2.9, 50)).toBe(2);
    expect(normalizeReplyMonitorLimit(Number.NaN, 50)).toBe(50);
  });

  it("deactivates only missing Trello threads for the authenticated worker", async () => {
    execute.mockResolvedValue([{ affectedRows: 2 }]);

    const changed = await deactivateMissingTrelloReplyThreads(7, ["card-a", "card-b"]);

    expect(changed).toBe(2);
    expect(execute.mock.calls[0]).toHaveLength(1);
    expect(execute.mock.calls[0][0]).not.toBeTypeOf("string");
  });

  it("keeps legacy reply evidence columns synchronized during an upsert", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);

    await upsertReplyThread(7, {
      source: "trello",
      cardId: "card-a",
      cardName: "Card A",
      cardUrl: "https://trello.com/c/card-a",
      boardName: "Board",
      listName: "Doing",
      lastNonWorkerMsgAt: new Date("2026-08-14T12:00:00Z"),
      lastNonWorkerAuthor: "Client",
      lastNonWorkerText: "Please confirm.",
      lastWorkerReplyAt: null,
      status: "pending",
      demerited: false,
    });

    const [query] = execute.mock.calls[0];
    expect(execute.mock.calls[0]).toHaveLength(1);
    expect(query).not.toBeTypeOf("string");
  });
});
