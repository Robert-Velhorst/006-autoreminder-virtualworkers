import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ post: provider.post }) } }));
vi.mock("./env", () => ({ ENV: { appId: "synthetic-app", oAuthServerUrl: "https://oauth.example.test",
  cookieSecret: crypto.randomUUID() + crypto.randomUUID() } }));
import { sdk } from "./sdk";

describe("external OAuth token exchange", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLIC_URL", "https://dashboard.example.com");
    vi.stubEnv("VITE_OAUTH_PORTAL_URL", "https://portal.example.test");
    provider.post.mockReset().mockResolvedValue({ data: { accessToken: "synthetic-provider-token" } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the explicit validated callback URI without decoding it as state", async () => {
    const redirectUri = "https://dashboard.example.com/api/oauth/callback";
    expect(await sdk.exchangeCodeForToken("synthetic-code", redirectUri))
      .toMatchObject({ accessToken: "synthetic-provider-token" });
    expect(provider.post).toHaveBeenCalledExactlyOnceWith(
      "/webdev.v1.WebDevAuthPublicService/ExchangeToken",
      expect.objectContaining({ code: "synthetic-code", redirectUri, grantType: "authorization_code" }),
    );
  });

  it.each([
    "https://other.example.com/api/oauth/callback",
    "https://dashboard.example.com/api/oauth/callback?changed=1",
    "http://dashboard.example.com/api/oauth/callback",
    Buffer.from("https://dashboard.example.com/api/oauth/callback").toString("base64"),
  ])("rejects an unconfigured or legacy encoded callback before provider exchange: %s", async callback => {
    await expect(sdk.exchangeCodeForToken("synthetic-code", callback)).rejects.toThrow();
    expect(provider.post).not.toHaveBeenCalled();
  });
});
