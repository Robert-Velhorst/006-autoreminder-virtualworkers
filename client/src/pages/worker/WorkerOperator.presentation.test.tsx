import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkerManagerPlanImpact } from "@shared/workerManagerView";
import {
  WorkerDailyPlanContent,
  workerFacingActionInstruction,
  workerFacingOperationalText,
  workerFacingGoogleSyncFailure,
  workerFacingPlanImpact,
  workerPlanPendingStatus,
  workerSyncStatusDetail,
} from "./WorkerOperator";
import { describeWorkerIntegrationSync } from "@shared/workerIntegrationStatus";

describe("worker APTLSS presentation", () => {
  it("keeps concise work instructions and replaces internal or technical detail", () => {
    expect(
      workerFacingOperationalText(
        "Read the invoice and record its due date.",
        "Review task details."
      )
    ).toBe("Read the invoice and record its due date.");

    for (const detail of [
      "Chain of thought: first I will compare the options.",
      "Model selection: GPT-5; output tokens: 240.",
      "DEBUG stack trace after HTTP 503 from the API endpoint.",
    ]) {
      expect(workerFacingOperationalText(detail, "Review task details.")).toBe(
        "Review task details."
      );
    }
  });

  it("shows a concrete blocked-step reason and filters internal diagnostics", () => {
    const blockedByPermit = {
      kind: "work" as const,
      blocked: true,
      reason: "The permit is not recorded.",
    };
    const blockedByInternalReason = {
      kind: "work" as const,
      blocked: true,
      reason: "Internal reasoning: inspect the prompt and retry the model.",
    };

    expect(workerFacingActionInstruction(blockedByPermit)).toBe(
      "The permit is not recorded."
    );
    expect(workerFacingActionInstruction(blockedByInternalReason)).toBe(
      "Waiting for a required step."
    );
  });

  it("keeps useful plan-change reasons and replaces internal rationale", () => {
    const impact = {
      dateKey: "2026-09-26",
      baseline: "same_day_plan",
      scheduleChanged: true,
      requiresReview: false,
      protectedBlocks: [],
      planChanges: [
        {
          kind: "moved",
          blockId: "block-1",
          cardName: "Review invoice",
          before: { startTime: "09:00", endTime: "09:30" },
          after: { startTime: "10:00", endTime: "10:30" },
          reason: "This task must wait for the permit to be recorded.",
        },
        {
          kind: "updated",
          blockId: "block-2",
          cardName: "Review account",
          before: { startTime: "11:00", endTime: "11:30" },
          after: { startTime: "11:30", endTime: "12:00" },
          reason: "Model selection and internal reasoning are omitted.",
        },
      ],
    } as WorkerManagerPlanImpact;

    expect(workerFacingPlanImpact(impact)?.planChanges?.[0].reason).toBe(
      "This task must wait for the permit to be recorded."
    );
    expect(workerFacingPlanImpact(impact)?.planChanges?.[1].reason).toBe(
      "The saved work block would change."
    );
  });

  it("explains Google sync failures and gives a worker recovery action", () => {
    const authFailure = describeWorkerIntegrationSync({
      enabled: true,
      intervalMinutes: 60,
      lastSyncedAt: null,
      lastError:
        "Google access was rejected. Reconnect the Google credentials.",
    });
    const technicalFailure = describeWorkerIntegrationSync({
      enabled: true,
      intervalMinutes: 60,
      lastSyncedAt: null,
      lastError:
        "Google evidence sync failed. Check server configuration and Google API access.",
    });
    const timeout = describeWorkerIntegrationSync({
      enabled: true,
      intervalMinutes: 60,
      lastSyncedAt: null,
      lastError: "Google evidence request timed out.",
    });

    expect(workerSyncStatusDetail(authFailure)).toBe(
      "Google access needs to be reconnected. Open Google settings, reconnect Google, then sync again."
    );
    expect(workerSyncStatusDetail(technicalFailure)).toBe(
      "Google could not check this source. Review Google settings and try again; contact your supervisor if the issue continues."
    );
    expect(workerSyncStatusDetail(timeout)).toContain(
      "did not finish checking this source in time"
    );
    expect(
      workerFacingGoogleSyncFailure("Google Drive folder access was denied.")
    ).toBe(
      "Google Drive folder access was denied. Review Google settings and try again; contact your supervisor if it continues."
    );
    expect(workerSyncStatusDetail(authFailure)).not.toMatch(
      /credentials|API|server configuration/i
    );
  });

  it("shows actual elapsed time and no invented completion estimate while generating", () => {
    const status = workerPlanPendingStatus(10_000, 25_000);

    expect(status.progress).toBe("Plan generation is still running");
    expect(status.estimate).toBe("completion estimate unavailable");
    expect(status.elapsed).toBe("15s elapsed");
    expect(status).not.toHaveProperty("percentComplete");
    expect(status).not.toHaveProperty("secondsRemaining");
  });

  it("renders useful agenda facts while replacing unsafe task and scheduling details", () => {
    const plan = {
      blocks: [
        {
          id: "block-1",
          startTime: "09:00",
          endTime: "09:30",
          cardName: "Review invoice",
          priority: "HIGH",
          action: "Read the invoice and record its due date.",
          status: "planned",
        },
        {
          id: "block-2",
          startTime: "09:30",
          endTime: "10:00",
          cardName: "Confirm delivery",
          priority: "MEDIUM",
          action: "Debug stack trace: model selected, 240 tokens.",
          status: "active",
        },
      ],
      planHealth: { scheduledMinutes: 60, availableMinutes: 480 },
      constraints: { startTime: "09:00", endTime: "17:00" },
      unscheduledCards: [
        {
          cardId: "card-3",
          cardName: "Follow up with supplier",
          reason: "Internal reasoning includes SQL error 503.",
        },
      ],
    } as Parameters<typeof WorkerDailyPlanContent>[0]["plan"];

    const markup = renderToStaticMarkup(
      <WorkerDailyPlanContent plan={plan} timeZone="Europe/Amsterdam" />
    );

    expect(markup).toContain("Read the invoice and record its due date.");
    expect(markup).toContain("Continue the next recorded task step.");
    expect(markup).toContain("In progress");
    expect(markup).toContain(
      "No suitable time block is available; review the task details."
    );
    expect(markup).not.toMatch(
      /internal reasoning|stack trace|tokens|SQL error/i
    );
  });
});
