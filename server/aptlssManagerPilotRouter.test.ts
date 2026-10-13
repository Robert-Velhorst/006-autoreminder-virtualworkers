import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
const db = vi.hoisted(() => ({ getDb: vi.fn().mockResolvedValue(null) }));
const planService = vi.hoisted(() => ({ update: vi.fn(), generate: vi.fn() }));
vi.mock("./db", () => db);
vi.mock("./operatorDailyPlan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./operatorDailyPlan")>();
  return {
    ...actual,
    updateOperatorDailyPlan: planService.update,
    generateOperatorDailyPlan: planService.generate,
  };
});
vi.mock("./workerOperatorContext", async original => ({
  ...(await original<typeof import("./workerOperatorContext")>()),
  getActiveWorkerProfileResolution: async (userId: number) => ({ profileId: userId, ambiguous: false }),
  resolveWorkerOperatorContext: async (user: { id: number }) => ({ userId: user.id }),
}));
import { operatorRouter } from "./operatorRouter";
import { OperatorDailyPlanConflictError } from "./operatorDailyPlan";
const caller = (id: number, role: "admin" | "worker" | "user" | null) => operatorRouter.createCaller({
  req: {}, res: {}, user: role ? { id, openId: `user-${id}`, role } : null,
} as TrpcContext);
beforeEach(() => {
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  vi.clearAllMocks();
  planService.update.mockImplementation(async () => { await db.getDb(); return null; });
  planService.generate.mockImplementation(async () => { await db.getDb(); return null; });
});
afterEach(() => vi.unstubAllEnvs());
describe("pilot API enforcement without weakening canonical authorization", () => {
  it("rejects active mode and restoration even for an admin", async () => {
    await expect(caller(1, "admin").setManagerMode({ vaId: 2, mode: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(1, "admin").restoreManagerPlan({ vaId: 2, runId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("rejects pilot-worker day-plan generation and edits before accessing persistence", async () => {
    const pilot = caller(2, "worker");
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
      expectedPlanVersion: null,
    };

    await expect(pilot.generateDailyPlan({ force: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(pilot.updateDailyPlan(plan)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("reports day-plan edit availability without exposing pilot configuration", async () => {
    await expect(caller(2, "worker").getDailyPlanEditingPolicy()).resolves.toEqual({ editable: false });
    await expect(caller(3, "worker").getDailyPlanEditingPolicy()).resolves.toEqual({ editable: true });
    await expect(caller(3, "user").getDailyPlanEditingPolicy()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("keeps the existing day-plan endpoints available to workers outside the pilot", async () => {
    const ordinary = caller(3, "worker");
    const results = await Promise.allSettled([
      ordinary.generateDailyPlan({ force: true }),
      ordinary.updateDailyPlan({
        version: 2,
        dateKey: "2026-09-25",
        generatedAt: new Date().toISOString(),
        blocks: [],
        robertItems: [],
        unscheduledCards: [],
        planHealth: { confidence: 0, scheduledMinutes: 0, availableMinutes: 0, overlaps: 0, gaps: 0 },
        constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
        auditTrail: [],
        expectedPlanVersion: null,
      }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).not.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.getDb).toHaveBeenCalled();
  });
  it("returns a conflict response for a stale saved-plan version", async () => {
    planService.update.mockRejectedValueOnce(new OperatorDailyPlanConflictError("a".repeat(64), "b".repeat(64)));
    await expect(caller(3, "worker").updateDailyPlan({
      version: 2,
      dateKey: "2026-09-25",
      generatedAt: new Date().toISOString(),
      blocks: [],
      robertItems: [],
      unscheduledCards: [],
      planHealth: { confidence: 0, scheduledMinutes: 0, availableMinutes: 0, overlaps: 0, gaps: 0 },
      constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
      auditTrail: [],
      expectedPlanVersion: "a".repeat(64),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/newer version.*saved.*reload/i),
    });

    planService.generate.mockRejectedValueOnce(new OperatorDailyPlanConflictError("a".repeat(64), "b".repeat(64)));
    await expect(caller(3, "worker").generateDailyPlan({ dateKey: "2026-09-25", force: true }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/newer version.*saved.*reload/i) });
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
      expectedPlanVersion: null,
    };
    const requests = [
      ordinary.getContext(),
      ordinary.getWorkQueueContext(),
      ordinary.getManagerStatus(),
      ordinary.runManager(),
      ordinary.updateManagerPolicy({ enabled: true, intervalMinutes: 5 }),
      ordinary.submitManagerUpdate({ cardId: "card", detail: "Worker report", expectedRunId: 1 }),
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
  it("keeps manager policy updates founder/admin-only", async () => {
    await expect(caller(2, "worker").updateManagerPolicy({ enabled: true, intervalMinutes: 5, mode: "active" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getDb).not.toHaveBeenCalled();
  });
  it("leaves the canonical operator context available for workers outside the pilot", async () => {
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "false");
    await expect(caller(3, "worker").getContext()).resolves.toEqual({ userId: 3 });
    await expect(caller(3, "user").getContext()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
