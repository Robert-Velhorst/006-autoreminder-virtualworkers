import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => database);
import { collectManagerInput, getManagerStatus, runManager, submitManagerUpdate, updateManagerPolicy } from "./aptlssManagerService";
import { isManagerPilotWorker, managerPilotEnabled, managerPilotWorkerIds } from "./aptlssManagerPilot";
import { restoreManagerPlan, setManagerMode, getManagerReviewInbox, recordManagerReview } from "./aptlssManagerReviewService";
import { enqueueManagerTask } from "./aptlssManagerQueue";

beforeEach(() => {
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  database.getDb.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("Joyce-only shadow pilot service boundaries", () => {
  it.each([1, 3, 99, 0, -2, NaN, 2.5])("rejects worker %s before database access", async id => {
    await expect(async () => runManager(id)).rejects.toThrow(/pilot/i);
    await expect(getManagerStatus(id)).rejects.toThrow(/pilot/i);
    await expect(submitManagerUpdate(id, "card", "An update")).rejects.toThrow(/pilot/i);
    await expect(updateManagerPolicy(id, { enabled: true, intervalMinutes: 5 })).rejects.toThrow(/pilot/i);
    await expect(collectManagerInput({} as never, id, new Date())).rejects.toThrow(/pilot/i);
    expect(database.getDb).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "0", "2,", "02", "*", "2,-3", "2,1.5", "2,1e2", "2,9007199254740992", "2,2"])("fails closed for pilot IDs %s", async ids => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", ids);
    await expect(async () => runManager(2)).rejects.toThrow(/pilot/i);
    expect(database.getDb).not.toHaveBeenCalled();
  });
  it("accepts explicitly allowlisted fixture workers without hard-coded identities", () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "7,19,301");
    expect(isManagerPilotWorker(7)).toBe(true);
    expect(isManagerPilotWorker(19)).toBe(true);
    expect(isManagerPilotWorker(301)).toBe(true);
    expect(isManagerPilotWorker(2)).toBe(false);
    expect(managerPilotEnabled()).toBe(true);
  });
  it.each([undefined, "", "false", "TRUE", "1", " true ", "enabled"])("keeps pilot protections and disables APTLSS unless shadow-only is exactly true (%s)", async value => {
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", value);
    expect(managerPilotWorkerIds()).toEqual([2]);
    expect(isManagerPilotWorker(2)).toBe(true);
    expect(managerPilotEnabled()).toBe(false);
    await expect(async () => runManager(2)).rejects.toThrow(/pilot/i);
    expect(database.getDb).not.toHaveBeenCalled();
  });
  it("rejects active mode and restoration even for an administrator before DB access", async () => {
    await expect(setManagerMode(1, 2, "active")).rejects.toThrow(/shadow/i);
    await expect(restoreManagerPlan(1, 2, 123)).rejects.toThrow(/shadow/i);
    expect(database.getDb).not.toHaveBeenCalled();
  });
  it("rejects out-of-pilot review reads and writes", async () => {
    await expect(getManagerReviewInbox(1, 3)).rejects.toThrow(/pilot/i);
    await expect(recordManagerReview(1, { vaId: 3, runId: 1, verdict: "correct", critical: false, correction: "", source: "Review" })).rejects.toThrow(/pilot/i);
    expect(database.getDb).not.toHaveBeenCalled();
  });
  it("ignores non-pilot queue events without touching the caller transaction", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    await expect(enqueueManagerTask(tx as never, { vaId: 3, eventKey: "event", trigger: "source_ingested" })).resolves.toEqual({ accepted: false });
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
