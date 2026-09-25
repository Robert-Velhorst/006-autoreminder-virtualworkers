import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
const db = vi.hoisted(() => ({ getDb: vi.fn().mockResolvedValue(null) }));
vi.mock("./db", () => db);
vi.mock("./workerOperatorContext", async original => ({
  ...(await original<typeof import("./workerOperatorContext")>()),
  resolveWorkerOperatorContext: async (user: { id: number }) => ({ userId: user.id }),
}));
import { operatorRouter } from "./operatorRouter";
const caller = (id: number, role: "admin" | "worker" | "user" | null) => operatorRouter.createCaller({
  req: {}, res: {}, user: role ? { id, openId: `user-${id}`, role } : null,
} as TrpcContext);
beforeEach(() => {
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());
describe("pilot API enforcement without weakening canonical authorization", () => {
  it("rejects active mode and restoration even for an admin", async () => {
    await expect(caller(1, "admin").setManagerMode({ vaId: 2, mode: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(1, "admin").restoreManagerPlan({ vaId: 2, runId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("rejects manager and evidence operations for other workers", async () => {
    const other = caller(3, "worker");
    const requests = [other.getManagerStatus(), other.runManager(),
      other.reportManagerActionCompletion({ cardId: "card", actionId: "action", detail: "Completed the step.", requestKey: "a9de1a02-18b8-4db2-b923-bcfe3ab9ca14", sourceDescription: "Trello card" }),
      other.getCardEvidence({ cardId: "card" }), other.getVerificationFollowups(),
      other.recordEvidenceAssertion({ title: "A title", detail: "Details" }),
      other.createEvidenceConflict({ sourceEvidenceId: 1, assertedEvidenceId: 2, question: "Verify this" }),
      other.resolveVerificationFollowup({ followupId: 1, resolution: "Reviewed" }),
    ];
    for (const result of await Promise.allSettled(requests)) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("rejects every worker-only operator surface for a generic authenticated account", async () => {
    const ordinary = caller(3, "user");
    const plan = {
      version: 2 as const,
      dateKey: "2026-09-25",
      generatedAt: new Date().toISOString(),
      blocks: [],
      robertItems: [],
      unscheduledCards: [],
      planHealth: { confidence: 0, scheduledMinutes: 0, availableMinutes: 0, overlaps: 0, gaps: 0 },
      constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
      auditTrail: [],
    };
    const requests = [
      ordinary.getContext(),
      ordinary.getWorkQueueContext(),
      ordinary.getManagerStatus(),
      ordinary.runManager(),
      ordinary.updateManagerPolicy({ enabled: true, intervalMinutes: 5 }),
      ordinary.submitManagerUpdate({ cardId: "card", detail: "Worker report" }),
      ordinary.reportManagerActionCompletion({ cardId: "card", actionId: "action", detail: "Completed the step.", requestKey: "a9de1a02-18b8-4db2-b923-bcfe3ab9ca14", sourceDescription: "Trello card" }),
      ordinary.getCardEvidence({ cardId: "card" }),
      ordinary.getVerificationFollowups(),
      ordinary.recordEvidenceAssertion({ title: "A title", detail: "A report" }),
      ordinary.createEvidenceConflict({ sourceEvidenceId: 1, assertedEvidenceId: 2, question: "Check this conflict" }),
      ordinary.resolveVerificationFollowup({ followupId: 1, resolution: "Reviewed" }),
      ordinary.interpretWaitingReason({ reason: "Waiting for access" }),
      ordinary.recordWaitingReason({ reason: "Waiting for access", cardId: "card", cardName: "Task", cardUrl: "", boardName: "Board", listName: "TO DO" }),
      ordinary.getWaitingReasons(),
      ordinary.getWaitingReason({ cardId: "card" }),
      ordinary.getWaitingReasonHistory({ cardId: "card" }),
      ordinary.resolveWaitingReason({ cardId: "card" }),
      ordinary.getDecisionHistory(),
      ordinary.getDailyPlan(),
      ordinary.generateDailyPlan({ force: true }),
      ordinary.updateDailyPlan(plan),
      ordinary.getBrowserTabStatus(),
      ordinary.getBrowserTabPolicy(),
      ordinary.setBrowserTabPolicy({ enabled: true }),
      ordinary.getBrowserCollectorToken(),
      ordinary.getBrowserTabEvidenceHistory(),
      ordinary.getGoogleEvidenceStatus(),
      ordinary.updateGoogleEvidenceSettings({ gmail: { enabled: false } }),
      ordinary.syncGoogleEvidence({ gmail: true }),
      ordinary.disconnectGoogleEvidence(),
    ];

    for (const result of await Promise.allSettled(requests)) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it.each(["worker", "user", null] as const)("retains admin-only review controls for %s", async role => {
    await expect(caller(2, role).getManagerReviewInbox({ vaId: 2 })).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("does not accept mode smuggling through worker policy updates", async () => {
    await expect(caller(2, "worker").updateManagerPolicy({ enabled: true, intervalMinutes: 5, mode: "active" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("leaves the canonical operator context available for workers outside the pilot", async () => {
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "false");
    await expect(caller(3, "worker").getContext()).resolves.toEqual({ userId: 3 });
    await expect(caller(3, "user").getContext()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
