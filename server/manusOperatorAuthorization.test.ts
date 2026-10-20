import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy Manus operator authorization", () => {
  it("limits the legacy dashboard router to worker and admin accounts", () => {
    const trpc = readFileSync(resolve(process.cwd(), "server/_core/trpc.ts"), "utf8");
    const manus = readFileSync(resolve(process.cwd(), "server/routes/manus.ts"), "utf8");

    expect(trpc).toContain('user.role !== "admin" && user.role !== "worker"');
    expect(manus).toContain("operatorAccountProcedure");
    expect(manus).not.toMatch(/protectedProcedure/);
  });
});
