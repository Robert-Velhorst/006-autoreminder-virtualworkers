import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("operator daily-plan query shape", () => {
  it("loads open steps once for the queued cards instead of once per card", () => {
    const source = readFileSync(resolve(process.cwd(), "server/operatorDailyPlan.ts"), "utf8");

    expect(source).toContain("getOpenStepsForCards");
    expect(source).not.toContain("plans.map(async (plan)");
  });
});
