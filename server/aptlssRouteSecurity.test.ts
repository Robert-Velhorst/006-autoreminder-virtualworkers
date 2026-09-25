import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./routes/manus-trello-aptlss.ts", import.meta.url), "utf8");
const followUpUi = readFileSync(new URL("../client/src/pages/manus/FollowUpDrafts.tsx", import.meta.url), "utf8");
const commandCenterUi = readFileSync(new URL("../client/src/pages/manus/PriorityCommandCenter.tsx", import.meta.url), "utf8");

describe("APTLSS route security boundaries", () => {
  it("has no public APTLSS mutation surface", () => {
    expect(source).not.toContain("publicProcedure");
  });

  it("requires operator accounts for operational router groups and founders for webhook inspection", () => {
    expect(source).not.toContain("protectedProcedure");
    expect(source).toContain("webhooks: adminProcedure");
  });

  it("scopes checklist and follow-up IDs to the authenticated worker without a worker decision resolver", () => {
    expect(source).toMatch(/setStepCompletionForWorker\(\s*Number\(ctx\.user\.id\)/);
    expect(source).not.toContain("resolveFounderStep:");
    expect(source).toContain("setFollowUpDraftStatusForWorker(Number(ctx.user.id), input.id");
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
