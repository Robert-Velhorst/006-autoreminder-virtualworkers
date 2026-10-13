import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { assertWorkerReviewedComment } from "./aptlssExternalActionPolicy";

const calls = vi.hoisted(() => ({
  postCardComment: vi.fn(),
  logAuditAction: vi.fn(),
  upsertAptlssPlan: vi.fn(),
  upsertAptlssSteps: vi.fn(),
  writeChecklistToTrello: vi.fn(),
  setStepCompletionForWorker: vi.fn(),
  getAllAptlssPlans: vi.fn(),
  getAutopilotLevel: vi.fn(),
  setFollowUpDraftStatusForWorker: vi.fn(),
  resolveVagueReplyFlag: vi.fn(),
  resolveUnsignedFlag: vi.fn(),
  getRegisteredWebhooks: vi.fn(),
  invokeLLM: vi.fn(),
  assertCardAccess: vi.fn(),
  fetchAuthorizedTrelloCard: vi.fn(),
  resolveWorkerOperatorContext: vi.fn(),
  getWorkerCards: vi.fn(),
  getWorkerRecentActions: vi.fn(),
  getWorkerCommentedCardIdsToday: vi.fn(),
  getCardsDueToday: vi.fn(),
  getOverdueCards: vi.fn(),
}));

vi.mock("./services/trello-manus", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/trello-manus")>()),
  postCardComment: calls.postCardComment,
  getRegisteredWebhooks: calls.getRegisteredWebhooks,
  getWorkerCards: calls.getWorkerCards,
  getWorkerRecentActions: calls.getWorkerRecentActions,
  getWorkerCommentedCardIdsToday: calls.getWorkerCommentedCardIdsToday,
  getCardsDueToday: calls.getCardsDueToday,
  getOverdueCards: calls.getOverdueCards,
}));
vi.mock("./aptlssAuditDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssAuditDb")>()),
  logAuditAction: calls.logAuditAction,
}));
vi.mock("./aptlssDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssDb")>()),
  upsertAptlssPlan: calls.upsertAptlssPlan,
  getAllAptlssPlans: calls.getAllAptlssPlans,
}));
vi.mock("./aptlssStepsDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssStepsDb")>()),
  upsertAptlssSteps: calls.upsertAptlssSteps,
  setStepCompletionForWorker: calls.setStepCompletionForWorker,
}));
vi.mock("./aptlssEngine", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssEngine")>()),
  writeChecklistToTrello: calls.writeChecklistToTrello,
}));
vi.mock("./aptlssPoliciesDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssPoliciesDb")>()),
  getAutopilotLevel: calls.getAutopilotLevel,
  setFollowUpDraftStatusForWorker: calls.setFollowUpDraftStatusForWorker,
}));
vi.mock("./replyMonitorDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./replyMonitorDb")>()),
  resolveVagueReplyFlag: calls.resolveVagueReplyFlag,
  resolveUnsignedFlag: calls.resolveUnsignedFlag,
}));
vi.mock("./_core/llm", async importOriginal => ({
  ...(await importOriginal<typeof import("./_core/llm")>()),
  invokeLLM: calls.invokeLLM,
}));
vi.mock("./trelloCardAccess", async importOriginal => ({
  ...(await importOriginal<typeof import("./trelloCardAccess")>()),
  assertCardAccess: calls.assertCardAccess,
  fetchAuthorizedTrelloCard: calls.fetchAuthorizedTrelloCard,
}));
vi.mock("./workerOperatorContext", async importOriginal => ({
  ...(await importOriginal<typeof import("./workerOperatorContext")>()),
  getActiveWorkerProfileResolution: async (userId: number) => ({ profileId: userId, ambiguous: false }),
  getActiveWorkerProfileId: async (userId: number) => userId,
  resolveWorkerOperatorContext: calls.resolveWorkerOperatorContext,
}));

import { aptlssRouter, replyMonitorRouter, trelloRouter } from "./routes/manus-trello-aptlss";

const caller = (role: "admin" | "worker" | "user" | null) => aptlssRouter.createCaller({
  req: {},
  res: {},
  user: role ? { id: 9, role } : null,
} as TrpcContext);
const replyCaller = (role: "admin" | "worker" | "user" | null) => replyMonitorRouter.createCaller({
  req: {},
  res: {},
  user: role ? { id: 9, role } : null,
} as TrpcContext);
const trelloCaller = (role: "admin" | "worker" | "user" | null) => trelloRouter.createCaller({
  req: {},
  res: {},
  user: role ? { id: 9, role } : null,
} as TrpcContext);
const namedTrelloCaller = (role: "admin" | "worker", name: string) => trelloRouter.createCaller({
  req: {},
  res: {},
  user: { id: 9, role, name },
} as TrpcContext);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("APTLSS external message policy", () => {
  it("allows only the explicit admin role to bypass worker confirmation", () => {
    expect(() =>
      assertWorkerReviewedComment({ role: "admin" }, "Admin update")
    ).not.toThrow();
    expect(() =>
      assertWorkerReviewedComment({ role: "admin" }, "   ")
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    expect(() =>
      assertWorkerReviewedComment({ role: "service" }, "Admin update")
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      assertWorkerReviewedComment(null, "Admin update")
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      assertWorkerReviewedComment(undefined, "Admin update")
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it.each([undefined, null, "", "   "])(
    "keeps a worker message as a draft when the worker identity is missing (%s)",
    name => {
      expect(() =>
        assertWorkerReviewedComment(
          { role: "worker", name },
          "Update\n~ Worker"
        )
      ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    }
  );

  it.each([null, undefined, "", "   "])(
    "rejects an empty or malformed worker comment (%s)",
    text => {
      expect(() =>
        assertWorkerReviewedComment(
          { role: "worker", name: "Joyce Example" },
          text
        )
      ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    }
  );

  it("retains the worker's explicit signature confirmation path", () => {
    expect(() =>
      assertWorkerReviewedComment(
        { role: "worker", name: "Joyce Kuvuna Mwabaya" },
        "I reviewed this message before posting.\n~ Joyce"
      )
    ).not.toThrow();
  });

  it("denies generic authenticated accounts across the Trello, APTLSS, and reply-monitor APIs", async () => {
    await expect(caller("user").getPolicies()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(trelloCaller("user").weeklyHours()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(replyCaller("user").getPendingThreads()).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );

    expect(calls.getRegisteredWebhooks).not.toHaveBeenCalled();
    expect(calls.postCardComment).not.toHaveBeenCalled();
  });

  it("allows only admins to inspect shared Trello webhooks", async () => {
    calls.getRegisteredWebhooks.mockResolvedValue([{ id: "hook-1" }]);
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");

    await expect(trelloCaller("worker").webhooks()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(trelloCaller("admin").webhooks()).resolves.toEqual([
      { id: "hook-1" },
    ]);
    expect(calls.getRegisteredWebhooks).toHaveBeenCalledWith(
      "test-key",
      "test-token"
    );
  });

  it("requires the worker's signature before the explicit comment send and forwards the reviewed text unchanged", async () => {
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "9");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    calls.fetchAuthorizedTrelloCard.mockResolvedValue({ id: "card-1" });
    calls.postCardComment.mockResolvedValue({
      id: "comment-1",
      date: "2026-09-26T12:00:00.000Z",
    });
    const worker = namedTrelloCaller("worker", "Joyce Kuvuna Mwabaya");
    const reviewedText =
      "I checked the source and recorded the requested next step.\n\n~ Joyce";

    await expect(
      trelloCaller("user").postComment({ cardId: "card-1", text: reviewedText })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      worker.postComment({ cardId: "card-1", text: "Unreviewed draft" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.postCardComment).not.toHaveBeenCalled();

    await expect(
      worker.postComment({ cardId: "card-1", text: reviewedText })
    ).resolves.toEqual({ id: "comment-1", date: "2026-09-26T12:00:00.000Z" });
    expect(calls.fetchAuthorizedTrelloCard).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 9,
        role: "worker",
        name: "Joyce Kuvuna Mwabaya",
      }),
      "card-1",
      { fields: "id,idMembers" }
    );
    expect(calls.postCardComment).toHaveBeenCalledWith(
      "card-1",
      reviewedText,
      "test-key",
      "test-token"
    );
    expect(calls.logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: "card-1",
        source: "manual",
        approved: true,
      })
    );
  });

  it("keeps a nameless worker's comment as a draft and performs no external write", async () => {
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");

    await expect(
      trelloCaller("worker").postComment({
        cardId: "card-1",
        text: "Update\n~ Worker",
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(calls.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
    expect(calls.postCardComment).not.toHaveBeenCalled();
    expect(calls.logAuditAction).not.toHaveBeenCalled();
  });

  it("preserves admin comment posting without a worker signature", async () => {
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    calls.fetchAuthorizedTrelloCard.mockResolvedValue({ id: "card-2" });
    calls.postCardComment.mockResolvedValue({
      id: "comment-2",
      date: "2026-09-26T12:00:00.000Z",
    });

    await namedTrelloCaller("admin", "Robert").postComment({
      cardId: "card-2",
      text: "Admin-approved update",
    });

    expect(calls.postCardComment).toHaveBeenCalledWith(
      "card-2",
      "Admin-approved update",
      "test-key",
      "test-token"
    );
  });

  it("does not fall back to the shared Trello token owner when a worker has no linked member", async () => {
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    calls.resolveWorkerOperatorContext.mockResolvedValue({
      trelloMemberId: null,
      timezone: "UTC",
      weeklyHoursMin: 40,
      weeklyHoursMax: 40,
    });

    const worker = trelloCaller("worker");
    await expect(worker.recentUpdates()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(worker.actionAlerts()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(calls.getWorkerCards).not.toHaveBeenCalled();
    expect(calls.getWorkerRecentActions).not.toHaveBeenCalled();
  });

  it("filters Trello activity using the worker's explicit linked member", async () => {
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    calls.resolveWorkerOperatorContext.mockResolvedValue({
      trelloMemberId: "worker-member",
      timezone: "UTC",
      weeklyHoursMin: 40,
      weeklyHoursMax: 40,
    });
    calls.getWorkerCards.mockResolvedValue([]);
    calls.getWorkerRecentActions.mockResolvedValue([]);
    calls.getWorkerCommentedCardIdsToday.mockResolvedValue(new Set());
    calls.getCardsDueToday.mockResolvedValue([]);
    calls.getOverdueCards.mockResolvedValue([]);

    const worker = trelloCaller("worker");
    await worker.recentUpdates();
    expect(calls.getWorkerCards).toHaveBeenCalledWith(
      "test-key",
      "test-token",
      "worker-member"
    );
    expect(calls.getWorkerRecentActions).toHaveBeenCalledWith(
      "test-key",
      "test-token",
      "worker-member",
      15
    );

    vi.clearAllMocks();
    calls.resolveWorkerOperatorContext.mockResolvedValue({
      trelloMemberId: "worker-member",
      timezone: "UTC",
      weeklyHoursMin: 40,
      weeklyHoursMax: 40,
    });
    calls.getWorkerCards.mockResolvedValue([]);
    calls.getWorkerRecentActions.mockResolvedValue([]);
    calls.getWorkerCommentedCardIdsToday.mockResolvedValue(new Set());
    calls.getCardsDueToday.mockResolvedValue([]);
    calls.getOverdueCards.mockResolvedValue([]);

    await worker.actionAlerts();
    expect(calls.getWorkerCards).toHaveBeenCalledWith(
      "test-key",
      "test-token",
      "worker-member"
    );
    expect(calls.getWorkerRecentActions).toHaveBeenCalledWith(
      "test-key",
      "test-token",
      "worker-member",
      50
    );
    expect(calls.getWorkerCommentedCardIdsToday).toHaveBeenCalledWith(
      "test-key",
      "test-token",
      "worker-member",
      undefined,
      undefined,
      "UTC"
    );
  });

  it("reports missing Trello credentials as unavailable read data without calling the provider", async () => {
    vi.stubEnv("TRELLO_API_KEY", "");
    vi.stubEnv("TRELLO_TOKEN", "");
    vi.stubEnv("TrelloAPIKey", "");
    vi.stubEnv("TrelloAPIToken", "");

    await expect(trelloCaller("worker").actionAlerts()).resolves.toMatchObject({
      available: false,
      noDueDateCards: [],
      dueTodayCards: [],
      overdueCards: [],
      onHoldCards: [],
      doingCards: [],
      recentActions: [],
      commentedCardIds: [],
    });
    expect(calls.getWorkerCards).not.toHaveBeenCalled();
    expect(calls.getWorkerRecentActions).not.toHaveBeenCalled();
    expect(calls.getWorkerCommentedCardIdsToday).not.toHaveBeenCalled();
  });

  it.each(["admin", "worker"] as const)(
    "blocks generated follow-up posting for %s accounts",
    async role => {
      await expect(
        caller(role).postFollowUpToTrello({ id: 12 })
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(calls.postCardComment).not.toHaveBeenCalled();
      expect(calls.getAutopilotLevel).not.toHaveBeenCalled();
      expect(calls.setFollowUpDraftStatusForWorker).not.toHaveBeenCalled();
      expect(calls.logAuditAction).not.toHaveBeenCalled();
    }
  );

  it("blocks legacy daily-update posting and bulk follow-up routes", async () => {
    const admin = caller("admin");
    await expect(
      admin.postDailyUpdateDraft({
        cardId: "card-1",
        cardName: "Case",
        draft: "Follow up",
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      admin.batchFollowUp({ cardIds: ["card-1"] })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.postCardComment).not.toHaveBeenCalled();
    expect(calls.assertCardAccess).not.toHaveBeenCalled();
    expect(calls.getAllAptlssPlans).not.toHaveBeenCalled();
    expect(calls.logAuditAction).not.toHaveBeenCalled();
  });

  it("blocks legacy plan writes for shadow pilot workers before checking Trello credentials", async () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "9");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");

    await expect(
      caller("worker").upsertAptlssPlan({ cardId: "card-1", planJson: "{}" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/shadow-only/i),
    });

    expect(calls.assertCardAccess).not.toHaveBeenCalled();
    expect(calls.upsertAptlssPlan).not.toHaveBeenCalled();
    expect(calls.writeChecklistToTrello).not.toHaveBeenCalled();
    expect(calls.upsertAptlssSteps).not.toHaveBeenCalled();
  });

  it("does not apply the shadow-pilot plan restriction to other workers", async () => {
    await expect(
      caller("worker").upsertAptlssPlan({ cardId: "card-1", planJson: "{}" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Trello credentials not configured",
    });
  });

  it.each(["complete", "incomplete"] as const)(
    "blocks legacy %s checklist writes for shadow pilot workers",
    async state => {
      vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "9");
      vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
      calls.setStepCompletionForWorker.mockResolvedValue(true);

      await expect(
        caller("worker").syncCheckItem({ trelloCheckItemId: "check-1", state })
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(calls.setStepCompletionForWorker).not.toHaveBeenCalled();
    }
  );

  it("keeps the legacy AI day planner out of the shadow pilot execution path", async () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "9");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");

    await expect(caller("worker").planMyDay()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/Work guidance/i),
    });

    expect(calls.getAutopilotLevel).not.toHaveBeenCalled();
    expect(calls.getAllAptlssPlans).not.toHaveBeenCalled();
    expect(calls.invokeLLM).not.toHaveBeenCalled();
  });

  it("rejects legacy auto-post flags before reading data or generating a draft", async () => {
    await expect(
      caller("admin").batchDraftDailyUpdates({
        cardIds: [],
        autoPost: true,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls.getAllAptlssPlans).not.toHaveBeenCalled();
    expect(calls.invokeLLM).not.toHaveBeenCalled();
    expect(calls.postCardComment).not.toHaveBeenCalled();
  });

  it("retains operator and admin role boundaries for retired send endpoints", async () => {
    await expect(
      caller("user").postFollowUpToTrello({ id: 12 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller("worker").postDailyUpdateDraft({
        cardId: "card-1",
        cardName: "Case",
        draft: "Text",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller("worker").batchFollowUp({ cardIds: ["card-1"] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls.postCardComment).not.toHaveBeenCalled();
  });
});

describe("reply monitor resolution outcomes", () => {
  const worker = replyMonitorRouter.createCaller({
    req: {},
    res: {},
    user: { id: 9, role: "worker" },
  } as TrpcContext);

  it("returns not found for missing or foreign reply flags", async () => {
    calls.resolveVagueReplyFlag.mockResolvedValue(false);

    await expect(worker.resolveVagueReplyFlag({ id: 41 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.resolveVagueReplyFlag).toHaveBeenCalledWith(9, 41);
  });

  it("hides database error details while reporting reply-flag storage failures", async () => {
    calls.resolveVagueReplyFlag.mockRejectedValue(new Error("mysql://private-user:private-password@host"));

    await expect(worker.resolveVagueReplyFlag({ id: 41 })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not update this item. Please try again.",
    });
  });

  it("returns not found for missing or foreign unsigned-message flags", async () => {
    calls.resolveUnsignedFlag.mockResolvedValue(false);

    await expect(worker.resolveUnsignedFlag({ id: 42, note: "Verified" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.resolveUnsignedFlag).toHaveBeenCalledWith(9, 42, "Verified");
  });
});
