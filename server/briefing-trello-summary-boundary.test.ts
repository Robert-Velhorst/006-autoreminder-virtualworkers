import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("briefing Trello summary boundary", () => {
  it("encodes card identifiers and keeps email summary retries bounded", () => {
    const source = readFileSync(new URL("./routes/va-management.ts", import.meta.url), "utf8");
    const helper = source.slice(source.indexOf('async function fetchTrelloCardSummary'), source.indexOf('// ============================================\n// VA MANAGEMENT'));

    expect(helper).toContain('encodeURIComponent(cardId)');
    expect(helper).toContain('{ maxRetries: 1, timeoutMs: 15_000 }');
  });
});
