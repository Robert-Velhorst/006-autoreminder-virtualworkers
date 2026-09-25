import { describe, expect, it } from "vitest";
import { toWorkerManagerSnapshot, toWorkerManagerStatus } from "./workerManagerResponse";

describe("worker manager response", () => {
  it("omits internal semantic-review diagnostics while retaining work guidance", () => {
    const snapshot = {
      version: 1 as const,
      assessedAt: "2026-09-25T09:00:00.000Z",
      assessments: [],
      actions: [{ id: "a1", cardId: "c1", title: "Read source", where: "Gmail", kind: "verify" as const, reason: "Read the full message.", blocked: false, stepIds: [1], dependsOn: [], completionCriteria: "Record result", evidenceIds: ["e1"], notBefore: null, priority: 7, draft: null, reviewedGuidance: [{ correction: "private model explanation" }], minutes: { low: 5, likely: 10, high: 20, samples: 0, basis: "uncalibrated" } }],
      interventions: [],
      sourceGaps: [],
      semanticReview: {
        success: false,
        sourceHash: "private-source-fingerprint",
        attemptedAt: "2026-09-25T09:00:00.000Z",
        retryAfter: "2026-09-25T09:05:00.000Z",
        failures: 2,
        provider: "codex-subscription" as const,
        attempts: [{ effort: "medium" as const, outcome: "rejected" as const, reason: "chronology" as const, durationMs: 30 }],
      },
      runId: 12,
      trigger: "manual",
      cards: [],
      evidence: [],
      changes: [],
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" as const },
      nextCheckAt: null,
      planVersion: "active-plan-version",
      proposal: {
        blocks: [], robertItems: [], unscheduledCards: [], planHealth: { confidence: 0 }, constraints: { startTime: "09:00", endTime: "17:00", breaks: [] },
        auditTrail: [{ detail: "private plan reasoning" }],
        planningImpact: {
          dateKey: "2026-09-25", baseline: "same_day_plan", scheduleChanged: true, requiresReview: false,
          planChanges: [{ kind: "moved", blockId: "b1", cardName: "Read source", before: { startTime: "09:00", endTime: "09:20" }, after: { startTime: "10:00", endTime: "10:20" }, reason: "Deadline moved", assumptionIds: ["private-assumption"] }],
          protectedBlocks: [{ blockId: "b2", reasons: ["active_timer"], preservedExactly: true, assumptionIds: ["private-assumption"] }],
          assumptions: [{ id: "private-assumption", inputPath: "private", value: "private plan reasoning", limitation: "private" }],
        } as any,
      },
      applied: false,
    };

    const result = toWorkerManagerSnapshot(snapshot);

    expect(result).toMatchObject({ applied: false, planVersion: "active-plan-version", actions: [{ title: "Read source", minutes: { low: 5, likely: 10, high: 20 } }] });
    expect(result).not.toHaveProperty("semanticReview");
    expect(result).not.toHaveProperty("assessments");
    expect(JSON.stringify(result)).not.toContain("runId");
    expect(result.proposal?.planningImpact).toMatchObject({
      dateKey: "2026-09-25",
      planChanges: [{ kind: "moved", cardName: "Read source", reason: "Deadline moved" }],
      protectedBlocks: [{ preservedExactly: true }],
    });
    expect(JSON.stringify(result)).not.toContain("uncalibrated");
    expect(JSON.stringify(result)).not.toContain("samples");
    expect(JSON.stringify(result)).not.toContain("private model explanation");
    expect(JSON.stringify(result)).not.toContain("private plan reasoning");
    expect(JSON.stringify(result)).not.toContain("private-assumption");
    expect(JSON.stringify(result)).not.toContain("private-source-fingerprint");
    expect(JSON.stringify(result)).not.toContain("chronology");
    expect(JSON.stringify(result)).not.toContain("calibrated");
  });

  it("strips internal queue and error details from the worker status endpoint", () => {
    const status = {
      snapshot: null,
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" as const },
      queue: { state: "failed", attempts: 3, lastError: "private model failure" },
      error: "private database detail",
      checkedAt: "2026-09-25T09:00:00.000Z",
      lastSuccessfulAt: null,
    };
    const result = toWorkerManagerStatus(status);

    expect(result).not.toHaveProperty("queue");
    expect(result.error).toMatch(/Work guidance could not be refreshed/);
    expect(JSON.stringify(result)).not.toContain("private model failure");
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });
});
