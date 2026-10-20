import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ results: [] as any[], gate: vi.fn(), selects: 0,
  runtime: { started: false, healthy: false, failed: false, observed: false, busy: false },
  start: vi.fn(), stop: vi.fn(),
}));
vi.mock("./aptlssManagerQueue", async original => ({ ...await original<any>(),
  createManagerQueueRunner: () => ({
    start: fixture.start, stop: fixture.stop, getStatus: () => fixture.runtime,
    drain: vi.fn(), pollFallback: vi.fn(),
  }),
}));
vi.mock("./db", () => ({ getDb: async () => ({ select: () => {
  fixture.selects++;
  const result = fixture.results.shift();
  const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => result };
  return chain;
} }) }));
vi.mock("./aptlssManagerReviewService", async original => ({ ...await original<any>(), getManagerGate: fixture.gate }));
import { getManagerStatus, getManagerSchedulerStatus, startManagerScheduler, stopManagerScheduler } from "./aptlssManagerService";
afterEach(async () => { await stopManagerScheduler(); vi.unstubAllEnvs(); });

describe("manager status read path", () => {
  beforeEach(() => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    vi.stubEnv("APTLSS_MANAGER_SCHEDULER", "true");
    fixture.runtime = { started: false, healthy: false, failed: false, observed: false, busy: false };
    fixture.start.mockReset(); fixture.stop.mockReset();
    fixture.selects = 0;
    fixture.gate.mockReset().mockRejectedValue(new Error("Historical gate scan must not run on polling"));
    fixture.results = [[{ enabled: true, intervalMinutes: 5, checkedAt: new Date("2026-09-13T12:00:00Z") }], [], []];
  });
  it("returns current policy without scanning the complete acceptance history", async () => {
    const status = await getManagerStatus(2);
    expect(status.policy).toEqual({ enabled: true, intervalMinutes: 5, mode: "shadow" });
    expect(status.snapshot).toBeNull();
    expect(status.scheduler).toEqual({ scope: "current_process", state: "stopped" });
    expect(fixture.selects).toBe(3);
    expect(fixture.gate).not.toHaveBeenCalled();
  });
  it("keeps suppressed scheduler stopped despite enabled worker policy", () => {
    vi.stubEnv("APTLSS_MANAGER_SCHEDULER", "false");
    startManagerScheduler();
    expect(getManagerSchedulerStatus().state).toBe("stopped");
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("requires fresh successful loop evidence, handles failures and stops truthfully", async () => {
    startManagerScheduler();
    expect(getManagerSchedulerStatus().state).toBe("checking");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fixture.start).toHaveBeenCalledOnce();
    fixture.runtime.started = true;
    expect(getManagerSchedulerStatus().state).toBe("checking");
    fixture.runtime.observed = fixture.runtime.healthy = true;
    expect(getManagerSchedulerStatus().state).toBe("responding");
    fixture.runtime.healthy = false;
    fixture.runtime.busy = true;
    expect(getManagerSchedulerStatus().state).toBe("checking");
    fixture.runtime.busy = false;
    expect(getManagerSchedulerStatus().state).toBe("unavailable");
    fixture.runtime.failed = fixture.runtime.busy = true;
    expect(getManagerSchedulerStatus().state).toBe("unavailable");
    await stopManagerScheduler();
    expect(getManagerSchedulerStatus().state).toBe("stopped");
    expect(fixture.stop).toHaveBeenCalledOnce();
  });
});
