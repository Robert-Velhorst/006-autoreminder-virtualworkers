import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const calls = vi.hoisted(() => ({
  postCardComment: vi.fn(),
  logAuditAction: vi.fn(),
  getAllAptlssPlans: vi.fn(),
  getAutopilotLevel: vi.fn(),
  setFollowUpDraftStatusForWorker: vi.fn(),
  resolveVagueReplyFlag: vi.fn(),
  resolveUnsignedFlag: vi.fn(),
  getRegisteredWebhooks: vi.fn(),
  invokeLLM: vi.fn(),
  assertCardAccess: vi.fn(),
}));

vi.mock("./services/trello-manus", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/trello-manus")>()),
  postCardComment: calls.postCardComment,
  getRegisteredWebhooks: calls.getRegisteredWebhooks,
}));
vi.mock("./aptlssAuditDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssAuditDb")>()),
  logAuditAction: calls.logAuditAction,
}));
vi.mock("./aptlssDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssDb")>()),
  getAllAptlssPlans: calls.getAllAptlssPlans,
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("APTLSS external message policy", () => {
  it("denies generic authenticated accounts across the Trello, APTLSS, and reply-monitor APIs", async () => {
    await expect(caller("user").getPolicies()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(trelloCaller("user").weeklyHours()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(replyCaller("user").getPendingThreads()).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(calls.getRegisteredWebhooks).not.toHaveBeenCalled();
    expect(calls.postCardComment).not.toHaveBeenCalled();
  });

  it("allows only admins to inspect shared Trello webhooks", async () => {
    calls.getRegisteredWebhooks.mockResolvedValue([{ id: "hook-1" }]);
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");

    await expect(trelloCaller("worker").webhooks()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(trelloCaller("admin").webhooks()).resolves.toEqual([{ id: "hook-1" }]);
    expect(calls.getRegisteredWebhooks).toHaveBeenCalledWith("test-key", "test-token");
  });

  it.each(["admin", "worker"] as const)("blocks generated follow-up posting for %s accounts", async role => {
    await expect(caller(role).postFollowUpToTrello({ id: 12 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.postCardComment).not.toHaveBeenCalled();
    expect(calls.getAutopilotLevel).not.toHaveBeenCalled();
    expect(calls.setFollowUpDraftStatusForWorker).not.toHaveBeenCalled();
    expect(calls.logAuditAction).not.toHaveBeenCalled();
  });

  it("blocks legacy daily-update posting and bulk follow-up routes", async () => {
    const admin = caller("admin");
    await expect(admin.postDailyUpdateDraft({ cardId: "card-1", cardName: "Case", draft: "Follow up" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(admin.batchFollowUp({ cardIds: ["card-1"] }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.postCardComment).not.toHaveBeenCalled();
    expect(calls.assertCardAccess).not.toHaveBeenCalled();
    expect(calls.getAllAptlssPlans).not.toHaveBeenCalled();
    expect(calls.logAuditAction).not.toHaveBeenCalled();
  });

  it("requires completion reports before pilot workers can close a legacy checklist step", async () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "9");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    await expect(caller("worker").syncCheckItem({ trelloCheckItemId: "check-1", state: "complete" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects legacy auto-post flags before reading data or generating a draft", async () => {
    await expect(caller("admin").batchDraftDailyUpdates({ cardIds: [], autoPost: true } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls.getAllAptlssPlans).not.toHaveBeenCalled();
    expect(calls.invokeLLM).not.toHaveBeenCalled();
    expect(calls.postCardComment).not.toHaveBeenCalled();
  });

  it("retains operator and admin role boundaries for retired send endpoints", async () => {
    await expect(caller("user").postFollowUpToTrello({ id: 12 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("worker").postDailyUpdateDraft({ cardId: "card-1", cardName: "Case", draft: "Text" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("worker").batchFollowUp({ cardIds: ["card-1"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
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
