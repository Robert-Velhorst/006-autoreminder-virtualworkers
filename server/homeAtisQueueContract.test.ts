import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("legacy home queue contract", () => {
  it("uses the supported ATIS queue for both populated and empty states", () => {
    const source = readFileSync(new URL("../client/src/pages/Home.tsx", import.meta.url), "utf8");

    expect(source).toContain("/api/atis/timeline-tasks?filter=all");
    expect(source).not.toContain("fetch('/api/trello/tasks')");
    expect(source).toContain("Failed to load the ATIS work queue");
  });

  it("does not expose the final timeline exception to the browser", () => {
    const source = readFileSync(new URL("../server/routes/atis.ts", import.meta.url), "utf8");
    const timeline = source.slice(source.indexOf("router.get('/timeline-tasks'"), source.indexOf("router.post('/checklist/toggle'"));
    expect(timeline).toContain("error: 'Failed to fetch timeline tasks after multiple attempts'");
    expect(timeline).not.toContain("lastError?.message || 'Failed to fetch timeline tasks after multiple attempts'");
  });
});
