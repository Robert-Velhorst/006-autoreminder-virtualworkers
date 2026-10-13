import { describe, expect, it } from "vitest";
import { dashboardApiDeadline } from "../client/src/lib/api-deadline";

const origin = "https://dashboard.example";
describe("dashboard API deadlines", () => {
  it.each(["runManager", "runManagerForReview", "submitManagerUpdate"])("allows the complete bounded assessment for %s", method => {
    expect(dashboardApiDeadline(`/api/trpc/operator.${method}`, { method: "POST" }, origin)).toBe(450_000);
  });
  it.each(["/api/trpc/operator.getManagerStatus", "/api/trpc/timer.start", "/api/trpc/operator.runManagerExtra"])("keeps the normal deadline for %s", path => {
    expect(dashboardApiDeadline(path, { method: "POST" }, origin)).toBe(30_000);
  });
  it("does not extend reads or cross-origin requests", () => {
    expect(dashboardApiDeadline("/api/trpc/operator.runManager", undefined, origin)).toBe(30_000);
    expect(dashboardApiDeadline("https://other.example/api/trpc/operator.runManager", { method: "POST" }, origin)).toBeNull();
    expect(dashboardApiDeadline("/assets/app.js", undefined, origin)).toBeNull();
  });
  it("honors Request objects and explicit method overrides", () => {
    const request = new Request(`${origin}/api/trpc/operator.runManager`, { method: "POST" });
    expect(dashboardApiDeadline(request, undefined, origin)).toBe(450_000);
    expect(dashboardApiDeadline(request, { method: "GET" }, origin)).toBe(30_000);
  });
});
