import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ownerBootstrapTokenMatches, trelloLoginReturnUrl } from "./routes/local-auth";

describe("owner bootstrap token comparison", () => {
  it("accepts only the exact one-time token", () => {
    const token = "owner-bootstrap-token-1234567890";
    expect(ownerBootstrapTokenMatches(token, token)).toBe(true);
    expect(ownerBootstrapTokenMatches(token, `${token}x`)).toBe(false);
    expect(ownerBootstrapTokenMatches(token, "")).toBe(false);
  });
});

describe("Trello login callback configuration", () => {
  it("uses the explicit login callback when configured", () => {
    expect(trelloLoginReturnUrl({
      TRELLO_LOGIN_RETURN_URL: "https://dashboard.example/trello-callback",
      TRELLO_WEBHOOK_CALLBACK_URL: "https://webhook.example/api/trello-webhook",
    })).toBe("https://dashboard.example/trello-callback");
  });

  it("derives the login callback from the configured public origin", () => {
    expect(trelloLoginReturnUrl({
      TRELLO_WEBHOOK_CALLBACK_URL: "https://dashboard.example/api/trello-webhook",
    })).toBe("https://dashboard.example/trello-callback");
  });

  it("does not trust an unconfigured request origin in production", () => {
    expect(trelloLoginReturnUrl({})).toBeNull();
  });
});

describe("Trello login provider boundary", () => {
  it("bounds token verification so a provider outage cannot hang sign-in", () => {
    const source = readFileSync(new URL("./routes/local-auth.ts", import.meta.url), "utf8");
    expect(source).toContain("const TRELLO_LOGIN_REQUEST_TIMEOUT_MS = 15_000");
    expect(source).toContain("signal: AbortSignal.timeout(TRELLO_LOGIN_REQUEST_TIMEOUT_MS)");
  });
});
