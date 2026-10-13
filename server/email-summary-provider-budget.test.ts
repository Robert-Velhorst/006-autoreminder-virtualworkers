import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("briefing provider budget", () => {
  it("uses bounded Trello summary concurrency for briefing and EOD emails", () => {
    const source = readFileSync(new URL("./routes/va-management.ts", import.meta.url), "utf8");
    const emailRoutes = source.slice(
      source.indexOf("router.post('/email/morning-briefing"),
      source.indexOf("router.get('/worker/profile'"),
    );

    expect(source).toContain('const BRIEFING_TRELLO_CONCURRENCY = 5');
    expect(emailRoutes).toContain('mapWithConcurrency(assignments, BRIEFING_TRELLO_CONCURRENCY');
    expect(emailRoutes).not.toContain('Promise.all(assignments.map(async');
  });
});
