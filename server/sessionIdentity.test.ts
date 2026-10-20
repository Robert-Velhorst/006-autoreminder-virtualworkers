import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionAudience } from "./_core/sessionIdentity";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
});

describe("session identity", () => {
  it("uses a stable local audience when Manus is not configured", () => {
    expect(getSessionAudience({})).toBe("va-dashboard");
  });

  it("prefers an explicit session audience", () => {
    expect(getSessionAudience({
      SESSION_APP_ID: "worker-production",
      VITE_APP_ID: "legacy-manus-app",
    })).toBe("worker-production");
  });

  it("keeps the legacy Manus app id as a compatibility fallback", () => {
    expect(getSessionAudience({ VITE_APP_ID: "legacy-manus-app" })).toBe("legacy-manus-app");
  });

  it("round-trips a local session without a Manus app id", async () => {
    process.env.JWT_SECRET = "test-session-secret-with-at-least-32-characters";
    delete process.env.SESSION_APP_ID;
    delete process.env.VITE_APP_ID;
    vi.resetModules();

    const { sdk } = await import("./_core/sdk");
    const token = await sdk.createSessionToken("worker-local", {
      name: "Worker",
      expiresInMs: 60_000,
    });

    await expect(sdk.verifySession(token)).resolves.toEqual({
      openId: "worker-local",
      appId: "va-dashboard",
      name: "Worker",
    });
  }, 15_000);
});
