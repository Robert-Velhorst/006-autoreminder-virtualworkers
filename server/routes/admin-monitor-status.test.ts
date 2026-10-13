import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const io = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getDb: vi.fn(),
  getSyncStats24h: vi.fn(), getLastSuccessfulSync: vi.fn(), getRecentSyncLog: vi.fn(), getRecentAuditLog: vi.fn(),
}));
vi.mock("axios", () => ({ default: {
  get: io.get, post: io.post, put: io.put, delete: io.delete,
  isAxiosError: (error: any) => error?.isAxiosError === true,
} }));
vi.mock("../db", () => ({ getDb: io.getDb, incrementPayLogD1: vi.fn() }));
vi.mock("../aptlssAuditDb", async importOriginal => ({
  ...(await importOriginal<typeof import("../aptlssAuditDb")>()),
  getSyncStats24h: io.getSyncStats24h, getLastSuccessfulSync: io.getLastSuccessfulSync,
  getRecentSyncLog: io.getRecentSyncLog, getRecentAuditLog: io.getRecentAuditLog,
}));
import { aptlssRouter } from "./manus-trello-aptlss";
import { getRegisteredWebhooks } from "../services/trello-manus";

const context = (role: string | null = "admin") => ({
  req: {}, res: {}, user: role ? { id: 7, role, name: "Test owner" } : null,
}) as TrpcContext;
const read = () => aptlssRouter.createCaller(context()).getAdminMonitor();

beforeEach(() => {
  vi.resetAllMocks();
  io.getDb.mockImplementation(() => { throw new Error("Unexpected database access"); });
  io.getSyncStats24h.mockResolvedValue({ totalRuns: 3 });
  io.getLastSuccessfulSync.mockResolvedValue(null);
  io.getRecentSyncLog.mockResolvedValue([]);
  io.getRecentAuditLog.mockResolvedValue([]);
  vi.stubEnv("TRELLO_API_KEY", "fakeTrello-key");
  vi.stubEnv("TRELLO_TOKEN", "fakeTrello-token");
  vi.stubEnv("TrelloAPIKey", "");
  vi.stubEnv("TrelloAPIToken", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  expect(io.getDb).not.toHaveBeenCalled();
  expect(io.post).not.toHaveBeenCalled();
  expect(io.put).not.toHaveBeenCalled();
  expect(io.delete).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getAdminMonitor read-only webhook health", () => {
  it.each(["TRELLO_API_KEY", "TRELLO_TOKEN"])("reports unconfigured without provider I/O when %s is missing", async key => {
    vi.stubEnv(key, "");
    expect((await read()).webhookStatus).toEqual({ state: "unconfigured", active: null, count: null });
    expect(io.get).not.toHaveBeenCalled();
  });
  it.each([403, 429, 500, undefined])("reports provider failure %s as unknown health, not inactive or forbidden", async status => {
    io.get.mockRejectedValue({
      isAxiosError: true, code: "ECONNABORTED", response: { status, data: "fakeTrello-token" },
      config: { url: "https://api.trello.com/1/tokens/fakeTrello-token/webhooks" },
    });
    const result = await read();
    expect(result.webhookStatus).toEqual({ state: "unavailable", active: null, count: null });
    expect(result.syncStats).toEqual({ totalRuns: 3 });
    expect(JSON.stringify(result)).not.toMatch(/fakeTrello|ECONNABORTED/);
    expect(io.get).toHaveBeenCalledTimes(1);
    expect(io.get).toHaveBeenCalledWith(expect.stringContaining("/webhooks"), {
      timeout: 15_000, params: { key: "fakeTrello-key", token: "fakeTrello-token" },
    });
  });
  it.each([
    [[], "inactive", false, 0],
    [[{ active: false }], "inactive", false, 1],
    [[{ active: false }, { active: true }], "active", true, 2],
  ])("derives verified health from active flags in %j", async (hooks, state, active, count) => {
    io.get.mockResolvedValue({ data: (hooks as object[]).map(hook => ({
      ...hook, callbackURL: "https://callback.invalid?token=fakeTrello-token", description: "private-config",
    })) });
    const result = await read();
    expect(result.webhookStatus).toEqual({ state, active, count });
    expect(JSON.stringify(result)).not.toMatch(/callbackURL|private-config|fakeTrello/);
    expect(io.getSyncStats24h).toHaveBeenCalledWith(7);
    expect(io.getRecentAuditLog).toHaveBeenCalledWith(7, 50);
  });
  it.each([null, {}, [{ id: "hook-without-active" }], [{ active: "true" }]])("treats malformed payload %j as unavailable", async data => {
    io.get.mockResolvedValue({ data });
    expect((await read()).webhookStatus).toEqual({ state: "unavailable", active: null, count: null });
  });
  it.each(["worker", "user", null])("keeps real admin denial for %s ahead of all reads", async role => {
    await expect(aptlssRouter.createCaller(context(role)).getAdminMonitor()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(io.get).not.toHaveBeenCalled();
    expect(io.getSyncStats24h).not.toHaveBeenCalled();
    expect(io.getRecentAuditLog).not.toHaveBeenCalled();
  });
  it("does not mask monitoring read failures as successful zero counts", async () => {
    io.getSyncStats24h.mockRejectedValue(new Error("Monitoring store unavailable"));
    await expect(read()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(io.get).not.toHaveBeenCalled();
  });
  it("keeps the legacy array caller compatible on success and failure", async () => {
    const hooks = [{ id: "hook-1", active: false }];
    io.get.mockResolvedValueOnce({ data: hooks }).mockRejectedValueOnce(new Error("Offline"));
    await expect(getRegisteredWebhooks("fakeTrello-key", "fakeTrello-token")).resolves.toEqual(hooks);
    await expect(getRegisteredWebhooks("fakeTrello-key", "fakeTrello-token")).resolves.toEqual([]);
  });
});
