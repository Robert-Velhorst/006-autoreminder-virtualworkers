import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledJobLeaseLostError } from "../scheduledJobRuntime";
import { syncWorkerTrelloReplyEvidence } from "./trello-reply-evidence";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), cards: vi.fn(), comments: vi.fn(), upsert: vi.fn(), deactivate: vi.fn(),
}));
vi.mock("../replyMonitorDb", () => ({ upsertReplyThread: mocks.upsert, deactivateMissingTrelloReplyThreads: mocks.deactivate }));
vi.mock("./trello-manus", () => ({ getTrelloMemberIdentity: mocks.identity, getWorkerCards: mocks.cards, getCardCommentActions: mocks.comments }));
vi.mock("../db", () => ({ getDb: vi.fn() }));

const input = { vaId: 2, trelloMemberId: "worker", apiKey: "test-key", apiToken: "test-token" };
const card = { id: "card-1", name: "Task", url: "https://trello.com/c/test", dateLastActivity: "2026-10-01T00:00:00Z" };
const comment = {
  id: "comment", type: "commentCard", date: "2026-10-01T00:00:00Z",
  data: { card: { id: "card-1" }, text: "Please confirm" },
  memberCreator: { id: "owner", username: "owner", fullName: "Owner" },
};

function lease() {
  let owned = true;
  const controller = new AbortController();
  const context = { signal: controller.signal, assertOwnership: vi.fn(async () => {
    if (!owned) throw new ScheduledJobLeaseLostError();
  }) };
  return { context, controller, lose: () => { owned = false; } };
}

describe("Trello reply evidence scheduled ownership fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.identity.mockResolvedValue({ id: "worker", username: "worker" });
    mocks.cards.mockResolvedValue([card]);
    mocks.comments.mockResolvedValue([comment]);
    mocks.upsert.mockResolvedValue(undefined);
    mocks.deactivate.mockResolvedValue(0);
  });

  it("rejects an aborted context before starting reads", async () => {
    const state = lease();
    state.controller.abort();
    await expect(syncWorkerTrelloReplyEvidence({ ...input, context: state.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.cards).not.toHaveBeenCalled();
  });

  it.each(["identity", "cards", "comments"] as const)("rejects ownership lost during the %s read before durable writes", async read => {
    const state = lease();
    const result = read === "identity" ? { id: "worker", username: "worker" } : read === "cards" ? [card] : [comment];
    mocks[read].mockImplementation(async () => { state.lose(); return result; });
    await expect(syncWorkerTrelloReplyEvidence({ ...input, context: state.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });

  it("does not process another thread or deactivate missing threads after loss during an upsert", async () => {
    const state = lease();
    mocks.cards.mockResolvedValue([card, { ...card, id: "card-2" }]);
    mocks.upsert.mockImplementation(async () => { state.lose(); });
    await expect(syncWorkerTrelloReplyEvidence({ ...input, context: state.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });

  it("checks ownership immediately before the cleanup write even with no cards", async () => {
    const state = lease();
    mocks.cards.mockResolvedValue([]);
    // Entry, provider-read completion, empty evidence completion, then cleanup.
    state.context.assertOwnership.mockReset().mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ScheduledJobLeaseLostError());
    await expect(syncWorkerTrelloReplyEvidence({ ...input, context: state.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });

  it("propagates loss during cleanup rather than reporting successful counts", async () => {
    const state = lease();
    mocks.deactivate.mockImplementation(async () => { state.lose(); return 1; });
    await expect(syncWorkerTrelloReplyEvidence({ ...input, context: state.context })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
  });

  it("retains direct calls without a context", async () => {
    await expect(syncWorkerTrelloReplyEvidence(input)).resolves.toMatchObject({ scannedCards: 1, threads: 1, inactive: 0 });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.deactivate).toHaveBeenCalledWith(2, ["card-1"]);
  });
});
