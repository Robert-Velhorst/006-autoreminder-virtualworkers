import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("legacy cache refresh scheduling", () => {
  it("persists the schedule through the maintenance center instead of starting an in-memory loop", () => {
    const source = readFileSync(new URL("./routes/performance-optimization.ts", import.meta.url), "utf8");

    expect(source).toContain('updateMaintenanceSetting("database_preload", true, intervalMinutes)');
    expect(source).not.toContain("scheduleCacheRefresh(intervalMinutes)");
  });
});
