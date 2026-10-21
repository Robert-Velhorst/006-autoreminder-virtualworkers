import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ url: "", key: "", reads: vi.fn() }));
vi.mock("./env", () => ({ ENV: {
  get forgeApiUrl() { config.reads(); return config.url; },
  get forgeApiKey() { config.reads(); return config.key; },
} }));
import { notifyOwner } from "./notification";

beforeEach(() => {
  config.url = "https://synthetic-provider.example.test/";
  config.key = "synthetic-not-a-real-key";
  config.reads.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("owner notification global policy", () => {
  it.each([undefined, "false", "TRUE", "1", ""])("blocks %j before configuration, payload validation or network", async flag => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", flag);
    config.url = ""; config.key = "";
    await expect(notifyOwner({ title: "", content: "" })).resolves.toBe(false);
    expect(config.reads).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only when explicitly enabled and honors subsequent disabling without module reload", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    await expect(notifyOwner({ title: " Synthetic ", content: " Body " })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("SendNotification"), expect.objectContaining({
      method: "POST", body: JSON.stringify({ title: "Synthetic", content: "Body" }), signal: expect.any(AbortSignal),
    }));
    vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
    await expect(notifyOwner({ title: "Synthetic", content: "Body" })).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves enabled-mode validation and missing-provider errors without network calls", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    await expect(notifyOwner({ title: "", content: "Body" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    config.url = "";
    await expect(notifyOwner({ title: "Synthetic", content: "Body" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns false when an enabled provider rejects delivery", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable", text: async () => "" } as Response);
    await expect(notifyOwner({ title: "Synthetic", content: "Body" })).resolves.toBe(false);
  });
});
