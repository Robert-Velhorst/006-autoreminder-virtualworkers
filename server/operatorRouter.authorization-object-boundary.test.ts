import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const calls = vi.hoisted(() => ({
  workerProfile: vi.fn(),
  managerUpdate: vi.fn(),
  evidenceAssertion: vi.fn(),
  evidenceConflict: vi.fn(),
  verificationFollowup: vi.fn(),
  runManager: vi.fn(),
  managerStatus: vi.fn(),
  managerPolicy: vi.fn(),
  founderInbox: vi.fn(),
  managerReviewInbox: vi.fn(),
  managerReview: vi.fn(),
  closeTrial: vi.fn(),
  restartTrial: vi.fn(),
  revokeCorrection: vi.fn(),
  setMode: vi.fn(),
  restorePlan: vi.fn(),
  runForReview: vi.fn(),
  setDeadline: vi.fn(),
  deferDecision: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock("./workerOperatorContext", async importOriginal => ({
  ...(await importOriginal<typeof import("./workerOperatorContext")>()),
  getActiveWorkerProfileResolution: calls.workerProfile,
}));

vi.mock("./aptlssManagerService", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssManagerService")>()),
  getManagerStatus: calls.managerStatus,
  updateManagerPolicy: calls.managerPolicy,
  runManager: calls.runManager,
  submitManagerUpdate: calls.managerUpdate,
}));

vi.mock("./aptlssManagerReviewService", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssManagerReviewService")>()),
  getManagerReviewInbox: calls.managerReviewInbox,
  recordManagerReview: calls.managerReview,
  closeManagerTrial: calls.closeTrial,
  restartManagerTrial: calls.restartTrial,
  revokeManagerCorrection: calls.revokeCorrection,
  setManagerMode: calls.setMode,
  restoreManagerPlan: calls.restorePlan,
}));

vi.mock("./aptlssEvidenceGraphDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./aptlssEvidenceGraphDb")>()),
  recordWorkerEvidenceAssertion: calls.evidenceAssertion,
  createEvidenceConflict: calls.evidenceConflict,
  resolveVerificationFollowup: calls.verificationFollowup,
}));

vi.mock("./founderDecisionInbox", async importOriginal => ({
  ...(await importOriginal<typeof import("./founderDecisionInbox")>()),
  getFounderDecisionInbox: calls.founderInbox,
  setFounderDecisionDeadline: calls.setDeadline,
  deferFounderDecisionDeadline: calls.deferDecision,
}));

vi.mock("./decisionOutcomesDb", async importOriginal => ({
  ...(await importOriginal<typeof import("./decisionOutcomesDb")>()),
  recordDecisionOutcome: calls.recordOutcome,
}));

import { operatorRouter } from "./operatorRouter";

type Role = "admin" | "worker" | "user";
function caller(
  role: Role | null,
  id = 42,
  openId = `${role ?? "anonymous"}-${id}`
) {
  const user = role ? { id, openId, role } : null;
  return operatorRouter.createCaller({ user, req: {}, res: {} } as TrpcContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "42");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  calls.workerProfile.mockImplementation(async (userId: number) => ({
    profileId: userId,
    ambiguous: false,
  }));
  calls.managerUpdate.mockResolvedValue({
    applied: false,
    reportId: 12,
    alreadyRecorded: false,
  });
  calls.evidenceAssertion.mockResolvedValue({ id: 31 });
  calls.evidenceConflict.mockResolvedValue({ id: 32 });
  calls.verificationFollowup.mockResolvedValue({ resolved: true });
  calls.runManager.mockResolvedValue({ applied: false });
  calls.managerStatus.mockResolvedValue({
    policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
    snapshot: null,
  });
  calls.managerPolicy.mockResolvedValue({
    enabled: false,
    intervalMinutes: 15,
    mode: "shadow",
  });
  calls.founderInbox.mockResolvedValue({ items: [] });
  calls.managerReviewInbox.mockResolvedValue({ items: [] });
  calls.managerReview.mockResolvedValue({ recorded: true });
  calls.closeTrial.mockResolvedValue({ recorded: true });
  calls.restartTrial.mockResolvedValue({ recorded: true });
  calls.revokeCorrection.mockResolvedValue({ recorded: true });
  calls.setMode.mockResolvedValue({ mode: "shadow" });
  calls.restorePlan.mockResolvedValue({ restored: true });
  calls.setDeadline.mockResolvedValue({ changed: true });
  calls.deferDecision.mockResolvedValue({ changed: true });
  calls.recordOutcome.mockResolvedValue({ id: 33, reassessmentQueued: true });
});

describe("operator router authorization and actor boundaries", () => {
  it.each(["user", "admin", null] as const)(
    "rejects %s from worker-only operator procedures",
    async role => {
      const workerOnly = caller(role);

      await expect(
        workerOnly.getDailyPlanEditingPolicy()
      ).rejects.toMatchObject({
        code: role ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      await expect(
        workerOnly.recordEvidenceAssertion({
          title: "Verified fact",
          detail: "A source was checked.",
        })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      expect(calls.evidenceAssertion).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the authenticated worker has no active profile", async () => {
    calls.workerProfile.mockResolvedValueOnce({
      profileId: null,
      ambiguous: false,
    });

    await expect(
      caller("worker").getDailyPlanEditingPolicy()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("limits manager policy changes to admins and binds the target worker explicitly", async () => {
    const policy = { vaId: 42, enabled: false, intervalMinutes: 15 };

    await expect(
      caller("worker").updateManagerPolicy({
        enabled: false,
        intervalMinutes: 15,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller("user").updateManagerPolicy(policy)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(null).updateManagerPolicy(policy)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(calls.managerPolicy).not.toHaveBeenCalled();

    await caller("admin", 9).updateManagerPolicy(policy);
    expect(calls.managerPolicy).toHaveBeenCalledWith(42, {
      enabled: false,
      intervalMinutes: 15,
    });
    await expect(
      caller("admin", 9).updateManagerPolicy({
        ...policy,
        mode: "active",
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls.managerPolicy).toHaveBeenCalledTimes(1);
  });

  it("binds manager status and reassessment to the authenticated worker", async () => {
    const worker = caller("worker", 42, "worker-session-42");

    await worker.getManagerStatus();
    await worker.runManager();

    expect(calls.managerStatus).toHaveBeenCalledWith(42);
    expect(calls.runManager).toHaveBeenCalledWith(42, "manual");
  });

  it("binds worker evidence and manager updates to the authenticated worker", async () => {
    const worker = caller("worker", 42, "worker-session-42");

    await worker.recordEvidenceAssertion({
      cardId: "card-1",
      title: "Verified fact",
      detail: "A source was checked.",
    });
    await worker.createEvidenceConflict({
      sourceEvidenceId: 4,
      assertedEvidenceId: 5,
      cardId: "card-1",
      question: "Which claim is current?",
    });
    await worker.resolveVerificationFollowup({
      followupId: 6,
      resolution: "The source confirms the current value.",
    });
    await worker.submitManagerUpdate({
      cardId: "card-1",
      detail: "The source has been checked.",
      expectedRunId: 17,
    });

    expect(calls.evidenceAssertion).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: 42,
        recordedBy: "worker-session-42",
      })
    );
    expect(calls.evidenceConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: 42,
        createdBy: "worker-session-42",
      })
    );
    expect(calls.verificationFollowup).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: 42,
        resolvedBy: "worker-session-42",
      })
    );
    expect(calls.runManager).toHaveBeenCalledWith(42, "worker_update");
    expect(calls.managerUpdate).toHaveBeenCalledWith(
      42,
      "card-1",
      "The source has been checked.",
      undefined,
      expect.objectContaining({ cardId: "card-1", expectedRunId: 17 })
    );
  });

  it("requires a positive assessment run ID at the authenticated worker API", async () => {
    const worker = caller("worker");
    const update = { cardId: "card-1", detail: "The source has been checked." };

    await expect(
      worker.submitManagerUpdate(update as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      worker.submitManagerUpdate({ ...update, expectedRunId: 0 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      worker.submitManagerUpdate({ ...update, expectedRunId: 1.5 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls.managerUpdate).not.toHaveBeenCalled();
  });

  it.each(["worker", "user", null] as const)(
    "rejects %s from founder decision and review procedures",
    async role => {
      const restricted = caller(role);
      const deadline = {
        vaId: 77,
        stepId: 501,
        dueAt: "2026-10-01T09:00:00.000Z",
        source: "Verified source record",
      };

      await expect(restricted.getFounderDecisionInbox()).rejects.toMatchObject({
        code: role ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      await expect(
        restricted.setFounderDecisionDeadline(deadline)
      ).rejects.toMatchObject({
        code: role ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      await expect(
        restricted.deferFounderDecision({
          vaId: 77,
          stepId: 501,
          dueAt: deadline.dueAt,
          reason: "Waiting for a source confirmation",
        })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      await expect(
        restricted.recordFounderDecisionOutcome({
          vaId: 77,
          stepId: 501,
          disposition: "approved",
          outcome: "Approved after checking the source",
        })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      await expect(
        restricted.getManagerReviewInbox({ vaId: 77 })
      ).rejects.toMatchObject({
        code: role ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      const review = {
        vaId: 77,
        runId: 19,
        verdict: "incorrect" as const,
        critical: false,
        correction: "Correct the conclusion",
        source: "Verified source",
      };
      const trial = {
        vaId: 77,
        reason: "The pilot review period needs to be closed",
      };
      await expect(
        restricted.recordManagerReview(review)
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      await expect(restricted.closeManagerTrial(trial)).rejects.toMatchObject({
        code: role ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      await expect(restricted.restartManagerTrial(trial)).rejects.toMatchObject(
        { code: role ? "FORBIDDEN" : "UNAUTHORIZED" }
      );
      await expect(
        restricted.revokeManagerCorrection({
          vaId: 77,
          correctionId: 2,
          reason: "Superseded by a verified source",
        })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      await expect(
        restricted.setManagerMode({ vaId: 77, mode: "shadow" })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      await expect(
        restricted.restoreManagerPlan({ vaId: 77, runId: 19 })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      await expect(
        restricted.runManagerForReview({ vaId: 77 })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });

      expect(calls.founderInbox).not.toHaveBeenCalled();
      expect(calls.managerReviewInbox).not.toHaveBeenCalled();
      expect(calls.managerReview).not.toHaveBeenCalled();
      expect(calls.closeTrial).not.toHaveBeenCalled();
      expect(calls.restartTrial).not.toHaveBeenCalled();
      expect(calls.revokeCorrection).not.toHaveBeenCalled();
      expect(calls.setMode).not.toHaveBeenCalled();
      expect(calls.restorePlan).not.toHaveBeenCalled();
      expect(calls.runManager).not.toHaveBeenCalled();
      expect(calls.setDeadline).not.toHaveBeenCalled();
      expect(calls.deferDecision).not.toHaveBeenCalled();
      expect(calls.recordOutcome).not.toHaveBeenCalled();
    }
  );

  it("records founder decision audit identities from the admin session", async () => {
    const admin = caller("admin", 9, "admin-session-9");
    const dueAt = "2026-10-01T09:00:00.000Z";

    await admin.setFounderDecisionDeadline({
      vaId: 77,
      stepId: 501,
      dueAt,
      source: "Verified source record",
      recordedBy: "forged-client-identity",
    } as never);
    await admin.deferFounderDecision({
      vaId: 77,
      stepId: 501,
      dueAt,
      reason: "Waiting for a source confirmation",
      recordedBy: "forged-client-identity",
    } as never);
    await admin.recordFounderDecisionOutcome({
      vaId: 77,
      stepId: 501,
      disposition: "approved",
      outcome: "Approved after checking the source",
      resolvedBy: "forged-client-identity",
    } as never);

    expect(calls.setDeadline).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: 77,
        stepId: 501,
        dueAt: new Date(dueAt),
        recordedBy: "admin-session-9",
      })
    );
    expect(calls.deferDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: 77,
        stepId: 501,
        dueAt: new Date(dueAt),
        recordedBy: "admin-session-9",
      })
    );
    expect(calls.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: 77,
        stepId: 501,
        resolvedBy: "admin-session-9",
      })
    );
  });
});
