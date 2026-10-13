import { afterEach, describe, expect, it, vi } from "vitest";

describe("owner notification delivery", () => {
  const originalForgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;
  const originalForgeApiKey = process.env.BUILT_IN_FORGE_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    if (originalForgeApiUrl === undefined) delete process.env.BUILT_IN_FORGE_API_URL;
    else process.env.BUILT_IN_FORGE_API_URL = originalForgeApiUrl;
    if (originalForgeApiKey === undefined) delete process.env.BUILT_IN_FORGE_API_KEY;
    else process.env.BUILT_IN_FORGE_API_KEY = originalForgeApiKey;
  });

  it("passes a 15-second timeout signal to the upstream request", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example.test";
    process.env.BUILT_IN_FORGE_API_KEY = "test-key";
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const { notifyOwner } = await import("./_core/notification");

    await expect(notifyOwner({ title: "Title", content: "Content" })).resolves.toBe(true);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://forge.example.test/webdevtoken.v1.WebDevService/SendNotification",
      expect.objectContaining({ signal: timeoutSignal })
    );
  });
});
