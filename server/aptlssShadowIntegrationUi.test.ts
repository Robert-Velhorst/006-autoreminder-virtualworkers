import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = (path: string) => readFileSync(new URL(`../client/src/${path}`, import.meta.url), "utf8");

describe("additive shadow manager UI integration", () => {
  it("uses the shared observed collector status on Today instead of inventing a missing report", () => {
    const worker = client("pages/worker/WorkerOperator.tsx");
    expect(worker).toContain("const browserConnection = describeBrowserConnection(browserQuery.data)");
    expect(worker).toContain('`${browserQuery.data.actionableTabs} tabs` : browserConnection.label');
    expect(worker).toContain('`Limit ${browserQuery.data.allowedTabs}` : browserConnection.detail');
    expect(worker).not.toContain("Collector has not reported");
  });

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

  it("explains that the pilot agenda is protected and hides plan-edit controls", () => {
    const worker = client("pages/worker/WorkerOperator.tsx");
    expect(worker).toContain("getDailyPlanEditingPolicy.useQuery");
    expect(worker).toContain("const canEditPlan = editingPolicy.data?.editable === true");
    expect(worker).toContain("Agenda changes are paused");
    expect(worker).toContain("Suggested changes above are not applied");
    expect(worker).toContain("Contact ${founderName} to set today's schedule.");
  });

  it("refreshes manager data over the existing identity-bound websocket", () => {
    const socket = client("hooks/useWebSocket.ts");
    expect(socket).toContain("aptlss:manager-updated");
    expect(socket).toContain("[userIdentity]");
  });
});
