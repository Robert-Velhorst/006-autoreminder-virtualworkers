import { describe, expect, it } from "vitest";
import {
  consumeMemoryRateLimit,
  consumeRedisRateLimit,
  getRateLimitIdentifier,
  isAnonymousApiReadProbe,
  isAnonymousAuthReadProbe,
  isAnonymousSessionProbe,
  isAptlssExpensiveRequest,
} from "./middleware/rate-limiter";

describe("rate-limit counter consumption", () => {
  it("uses the authenticated local user before a shared proxy IP", () => {
    expect(getRateLimitIdentifier({ user: { id: 42 }, ip: "203.0.113.5" })).toBe("user:42");
    expect(getRateLimitIdentifier({ user: { openId: "oauth-user" }, ip: "203.0.113.5" })).toBe("user:oauth-user");
    expect(getRateLimitIdentifier({ ip: "203.0.113.5" })).toBe("ip:203.0.113.5");
  });

  it("counts concurrent in-memory requests without losing increments", async () => {
    const key = `test:${Date.now()}`;
    const counters = await Promise.all(Array.from({ length: 6 }, () => consumeMemoryRateLimit(key, 60_000)));

    expect(counters.map((entry) => entry.count).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses one Redis script to increment and set the expiry", async () => {
    let call: unknown[] | null = null;
    const redis = {
      eval: async (...args: unknown[]) => {
        call = args;
        return ["3", "59000"];
      },
    };

    await expect(consumeRedisRateLimit(redis, "ratelimit:/auth/login:127.0.0.1", 60_000)).resolves.toMatchObject({ count: 3 });
    expect(call).not.toBeNull();
    expect(String(call?.[0])).toContain("INCR");
    expect(String(call?.[0])).toContain("PEXPIRE");
  });
});

describe("APTLSS generation rate-limit scope", () => {
  it("limits APTLSS mutations only", () => {
    expect(isAptlssExpensiveRequest("POST", "/aptlss/generate")).toBe(true);
    expect(isAptlssExpensiveRequest("POST", "/aptlss/generate-batch")).toBe(true);
    expect(isAptlssExpensiveRequest("DELETE", "/aptlss/scheduled/1")).toBe(true);
    expect(isAptlssExpensiveRequest("GET", "/aptlss/history")).toBe(false);
    expect(isAptlssExpensiveRequest("GET", "/trpc/auth.me")).toBe(false);
    expect(isAptlssExpensiveRequest("POST", "/trello/cards/1/status")).toBe(false);
  });
});

describe("anonymous session probe rate-limit scope", () => {
  it("exempts only the read-only unauthenticated auth.me query", () => {
    expect(isAnonymousSessionProbe("GET", "/trpc/auth.me", null)).toBe(true);
    expect(isAnonymousSessionProbe("GET", "/trpc/auth.me", { openId: "worker-1" })).toBe(false);
    expect(isAnonymousSessionProbe("POST", "/trpc/auth.me", null)).toBe(false);
    expect(isAnonymousSessionProbe("GET", "/trpc/settings.get", null)).toBe(false);
  });
});

describe("anonymous auth read rate-limit scope", () => {
  it("exempts only the login screen's safe GET probes from the strict auth budget", () => {
    expect(isAnonymousAuthReadProbe("GET", "/owner-bootstrap/status")).toBe(true);
    expect(isAnonymousAuthReadProbe("GET", "/trello/client-key")).toBe(true);
    expect(isAnonymousAuthReadProbe("POST", "/login")).toBe(false);
    expect(isAnonymousAuthReadProbe("POST", "/owner-bootstrap")).toBe(false);
    expect(isAnonymousAuthReadProbe("POST", "/trello/login-token")).toBe(false);
    expect(isAnonymousAuthReadProbe("GET", "/register")).toBe(false);
  });
});

describe("anonymous API read probe rate-limit scope", () => {
  it("exempts login-screen reads from the global API budget without exempting writes", () => {
    expect(isAnonymousApiReadProbe("GET", "/auth/owner-bootstrap/status", null)).toBe(true);
    expect(isAnonymousApiReadProbe("GET", "/auth/trello/client-key", null)).toBe(true);
    expect(isAnonymousApiReadProbe("GET", "/auth/owner-bootstrap/status", { openId: "owner-1" })).toBe(false);
    expect(isAnonymousApiReadProbe("POST", "/auth/login", null)).toBe(false);
    expect(isAnonymousApiReadProbe("GET", "/auth/register", null)).toBe(false);
  });
});
