import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ results: [] as any[], gate: vi.fn(), selects: 0 }));
vi.mock("./db", () => ({ getDb: async () => ({ select: () => {
  fixture.selects++;
  const result = fixture.results.shift();
  const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => result };
  return chain;
} }) }));
vi.mock("./aptlssManagerReviewService", async original => ({ ...await original<any>(), getManagerGate: fixture.gate }));
import { getManagerStatus } from "./aptlssManagerService";

describe("manager status read path", () => {
  beforeEach(() => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    fixture.selects = 0;
    fixture.gate.mockReset().mockRejectedValue(new Error("Historical gate scan must not run on polling"));
    fixture.results = [[{ enabled: true, intervalMinutes: 5, checkedAt: new Date("2026-09-13T12:00:00Z") }], [], []];
  });
  it("returns current policy without scanning the complete acceptance history", async () => {
    const status = await getManagerStatus(2);
    expect(status.policy).toEqual({ enabled: true, intervalMinutes: 5, mode: "shadow" });
    expect(status.snapshot).toBeNull();
    expect(fixture.selects).toBe(3);
    expect(fixture.gate).not.toHaveBeenCalled();
  });
});
