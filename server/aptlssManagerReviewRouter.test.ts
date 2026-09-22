import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
const calls = vi.hoisted(() => ({
  inbox: vi.fn(),
  review: vi.fn(),
  close: vi.fn(),
  restart: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("./aptlssManagerReviewService", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssManagerReviewService")>()),
  getManagerReviewInbox: calls.inbox,
  recordManagerReview: calls.review,
  closeManagerTrial: calls.close,
  restartManagerTrial: calls.restart,
  revokeManagerCorrection: calls.revoke,
}));
import { operatorRouter } from "./operatorRouter";
const caller = (role: "admin" | "worker" | null = "admin") =>
  operatorRouter.createCaller({
    req: {},
    res: {},
    user: role ? { id: 99, role } : null,
  } as TrpcContext);
beforeEach(() => {
  Object.values(calls).forEach(fn =>
    fn.mockReset().mockResolvedValue({ recorded: true })
  );
});
describe("founder review API contract", () => {
  it("forwards the requested proposal page and authenticated reviewer", async () => {
    await caller().getManagerReviewInbox({ vaId: 7, page: 3 });
    expect(calls.inbox).toHaveBeenCalledWith(99, 7, 3);
  });
  it("defaults omitted page to the first page", async () => {
    await caller().getManagerReviewInbox({ vaId: 7 });
    expect(calls.inbox).toHaveBeenCalledWith(99, 7, 0);
  });
  it("retains optional scoped correction evidence rather than stripping it", async () => {
    const input = {
      vaId: 7,
      runId: 2,
      verdict: "incorrect" as const,
      critical: false,
      correction: "Include the source section",
      source: "Report review",
      correctionKnowledge: {
        scope: "card" as const,
        cardId: "c",
        topic: "report",
        evidenceIds: ["source:1"],
        conditions: { actionKind: "work" as const },
        validUntil: "2026-10-01T00:00:00Z",
      },
    };
    await caller().recordManagerReview(input);
    expect(calls.review).toHaveBeenCalledWith(99, input);
  });
  it.each(["closeManagerTrial", "restartManagerTrial"] as const)(
    "forwards %s with a required reason",
    async method => {
      const input = { vaId: 7, reason: "Procedure changed after review" };
      await caller()[method](input);
      expect(
        method === "closeManagerTrial" ? calls.close : calls.restart
      ).toHaveBeenCalledWith(99, input);
    }
  );
  it("forwards scoped guidance revocation", async () => {
    const input = { vaId: 7, correctionId: 3, reason: "Superseded source" };
    await caller().revokeManagerCorrection(input);
    expect(calls.revoke).toHaveBeenCalledWith(99, input);
  });
  it.each(["worker", null] as const)(
    "rejects non-founder role %s for all new lifecycle routes",
    async role => {
      const c = caller(role),
        input = { vaId: 7, reason: "Procedure changed after review" };
      await expect(c.closeManagerTrial(input)).rejects.toThrow();
      await expect(c.restartManagerTrial(input)).rejects.toThrow();
      await expect(
        c.revokeManagerCorrection({ ...input, correctionId: 3 })
      ).rejects.toThrow();
      expect(calls.close).not.toHaveBeenCalled();
      expect(calls.restart).not.toHaveBeenCalled();
      expect(calls.revoke).not.toHaveBeenCalled();
    }
  );
  it("rejects invalid paging and missing lifecycle reasons before service writes", async () => {
    await expect(
      caller().getManagerReviewInbox({ vaId: 7, page: -1 })
    ).rejects.toThrow();
    await expect(
      caller().closeManagerTrial({ vaId: 7, reason: "" })
    ).rejects.toThrow();
    await expect(
      caller().restartManagerTrial({ vaId: 7, reason: "" })
    ).rejects.toThrow();
    await expect(
      caller().revokeManagerCorrection({ vaId: 7, correctionId: 1, reason: "" })
    ).rejects.toThrow();
    expect(calls.inbox).not.toHaveBeenCalled();
    expect(calls.close).not.toHaveBeenCalled();
    expect(calls.restart).not.toHaveBeenCalled();
    expect(calls.revoke).not.toHaveBeenCalled();
  });
});
