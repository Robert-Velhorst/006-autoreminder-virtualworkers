import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./routes/manus-trello-aptlss.ts", import.meta.url), "utf8");

describe("APTLSS route security boundaries", () => {
  it("has no public APTLSS mutation surface", () => {
    expect(source).not.toContain("publicProcedure");
  });

  it("scopes checklist, decision, and follow-up IDs to the authenticated worker", () => {
    expect(source).toMatch(/setStepCompletionForWorker\(\s*Number\(ctx\.user\.id\)/);
    expect(source).toMatch(/resolveFounderStepForWorker\(Number\(ctx\.user\.id\)/);
    expect(source).toContain("getFollowUpDraftByIdForWorker(vaId, input.id)");
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

  it("records provider-confirmed Trello mutations instead of reporting draft activity as posted", () => {
    expect(source).toContain('action: "comment_posted"');
    expect(source).toContain('action: "follow_up_posted"');
    expect(source).toContain("Trello credentials not configured");
    expect(source).toContain("await assertCardAccess(ctx.user, cardId)");
  });

  it("does not expose a dormant per-worker Trello token store", () => {
    expect(source).not.toContain("trello_comment_token");
    expect(source).not.toContain("setCommentToken");
    expect(source).not.toContain("getCommentToken");
  });
});
