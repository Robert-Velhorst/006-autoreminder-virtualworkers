import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = (path: string) => readFileSync(new URL(`../client/src/${path}`, import.meta.url), "utf8");

describe("additive shadow manager UI integration", () => {
  it("adds worker guidance without removing reminders, Google intake or the inspector", () => {
    const worker = client("pages/worker/WorkerOperator.tsx");
    expect(worker).toContain("<ManagerCoach />");
    expect(worker).toContain("selectTodayQueue(cards, primary?.cardId ?? null)");
    for (const retained of ["<WorkerReminders />", "Google connection", "getGoogleEvidenceStatus", "INSPECTOR_WIDTH_KEY", "getWorkLaneRank", "describeBrowserConnection"])
      expect(worker).toContain(retained);
  });

  it("adds founder review without replacing invitations or weakening password rules", () => {
    const founder = client("pages/FounderDashboard.tsx");
    expect(founder).toContain("<AptlssManagerReview />");
    expect(founder).toContain("/api/va/vas/invite");
    expect(founder).toContain("editWorkerPassword.length < 12");
  });

  it("does not expose active manager execution or change the current plan", () => {
    const worker = client("pages/worker/WorkerOperator.tsx");
    expect(worker).not.toContain("replanDailyPlan.useMutation");
    expect(worker).not.toContain("updateDailyPlan.useMutation");
    expect(worker).not.toContain("compareManagerWork");
  });

  it("refreshes manager data over the existing identity-bound websocket", () => {
    const socket = client("hooks/useWebSocket.ts");
    expect(socket).toContain("aptlss:manager-updated");
    expect(socket).toContain("[userIdentity]");
  });
});
