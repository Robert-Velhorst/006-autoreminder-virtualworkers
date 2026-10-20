import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("worker query index declarations", () => {
  it("declares indexes for the worker cockpit's high-frequency filters", () => {
    const schema = readFileSync(resolve(process.cwd(), "drizzle/schema.ts"), "utf8");

    expect(schema).toContain("va_time_entries_period_idx");
    expect(schema).toContain("va_aptlss_step_card_idx");
    expect(schema).toContain("email_tasks_va_status_received_idx");
    expect(schema).toContain("email_tasks_va_trello_card_idx");
  });
});
