import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("trello.weeklyHours local fallback", () => {
  it("does not require Trello credentials before returning local time targets", () => {
    const source = readFileSync(resolve(process.cwd(), "server/routes/manus-trello-aptlss.ts"), "utf8");
    const weeklyHours = source.slice(source.indexOf("weeklyHours: protectedProcedure"), source.indexOf("recentUpdates: protectedProcedure"));

    expect(weeklyHours).not.toContain('throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" })');
    expect(weeklyHours).toContain('getWeeklyHours(apiKey || "", apiToken || "", worker.memberId)');
  });
});
