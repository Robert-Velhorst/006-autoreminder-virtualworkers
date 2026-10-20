import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { adminProcedure, router } from "./_core/trpc";

const source = readFileSync(new URL("./routes/manus-trello-aptlss.ts", import.meta.url), "utf8");
const followUpUi = readFileSync(new URL("../client/src/pages/manus/FollowUpDrafts.tsx", import.meta.url), "utf8");
const commandCenterUi = readFileSync(new URL("../client/src/pages/manus/PriorityCommandCenter.tsx", import.meta.url), "utf8");
const adminGateProbe = router({
  read: adminProcedure.query(({ ctx }) => ctx.user.id),
});

function context(role: "admin" | "worker"): TrpcContext {
  const id = role === "admin" ? 1 : 9;
  return {
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id, openId: `test-${id}`, role } as TrpcContext["user"],
  };
}

describe("APTLSS route security boundaries", () => {
  it("has no public APTLSS mutation surface", () => {
    expect(source).not.toContain("publicProcedure");
  });

  it("requires operator accounts for operational router groups and founders for webhook inspection", () => {
    expect(source).not.toContain("protectedProcedure");
    expect(source).toContain("webhooks: adminProcedure");
  });

  it("scopes checklist and follow-up IDs to the authenticated worker without a worker decision resolver", () => {
    const checklistRoute = source.indexOf("syncCheckItem:");
    const pilotGuard = source.indexOf("if (isManagerPilotWorker(vaId)) {", checklistRoute);
    const checklistWrite = source.indexOf("setStepCompletionForWorker(", checklistRoute);
    expect(pilotGuard).toBeGreaterThanOrEqual(0);
    expect(pilotGuard).toBeLessThan(checklistWrite);
    expect(source).toContain("Checklist changes are paused in shadow mode.");
    expect(source).toMatch(/setStepCompletionForWorker\(\s*vaId,/);
    expect(source).not.toContain("resolveFounderStep:");
    expect(source).toContain("setFollowUpDraftStatusForWorker(Number(ctx.user.id), input.id");
  });

  it("gates legacy plan writes for pilot workers before any provider access", () => {
    const planRoute = source.indexOf("upsertAptlssPlan: operatorAccountProcedure");
    const pilotGuard = source.indexOf("if (isManagerPilotWorker(vaId)) assertManagerPlanMutationAllowed(vaId);", planRoute);
    const trelloAccess = source.indexOf("const apiKey = process.env.TRELLO_API_KEY", planRoute);
    expect(pilotGuard).toBeGreaterThanOrEqual(0);
    expect(pilotGuard).toBeLessThan(trelloAccess);
  });

  it("keeps legacy command-center mutations admin-only", () => {
    for (const procedure of [
      "recordWorkerSignal",
      "batchKeepOnHold",
      "batchMoveToDoing",
      "batchDraftDailyUpdates",
      "postDailyUpdateDraft",
      "batchFollowUp",
      "batchSnooze",
    ]) {
      expect(source).toContain(`${procedure}: adminProcedure`);
    }
  });

  it("restricts founder-only APTLSS reads while preserving the worker decision queue", () => {
    for (const procedure of [
      "getRisksAndExceptions",
      "getCommandCenter",
      "getCached",
      "getAll",
      "getFounderDecisionQueue",
      "getLatestWeeklyAnalysis",
      "getWeeklyAnalysisHistory",
    ]) {
      expect(source).toMatch(new RegExp(`\\b${procedure}:\\s*adminProcedure\\b`));
    }

    expect(source).toMatch(/\bgetDecisionQueue:\s*operatorAccountProcedure\b/);
  });

  it("enforces worker-deny and admin-allow behavior of the read-route admin gate", async () => {
    await expect(adminGateProbe.createCaller(context("worker")).read())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminGateProbe.createCaller(context("admin")).read()).resolves.toBe(1);
  });

  it("keeps authored comments scoped and disables posting generated drafts from the dashboard", () => {
    expect(source).toContain('action: "comment_posted"');
    expect(source).toContain("await assertCardAccess(ctx.user, input.cardId)");
    expect(source).toContain("Dashboard posting is disabled.");
    expect(source).not.toContain("Auto-posted daily update");
  });

  it("offers draft copy and manual-send tracking instead of dashboard send controls", () => {
    expect(followUpUi).toContain("Mark manually sent");
    expect(followUpUi).not.toContain("postFollowUpToTrello");
    expect(followUpUi).not.toContain("Post to Trello");
    expect(commandCenterUi).toContain("Copy draft");
    expect(commandCenterUi).not.toContain("batchFollowUp");
    expect(commandCenterUi).not.toContain("postDailyUpdateDraft");
    expect(commandCenterUi).not.toContain("autoPost");
  });

  it("does not expose a dormant per-worker Trello token store", () => {
    expect(source).not.toContain("trello_comment_token");
    expect(source).not.toContain("setCommentToken");
    expect(source).not.toContain("getCommentToken");
  });
});
