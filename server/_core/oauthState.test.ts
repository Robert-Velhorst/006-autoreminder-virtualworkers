import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configuration = vi.hoisted(() => ({ appId: "synthetic-app", oAuthServerUrl: "https://oauth.example.test",
  cookieSecret: crypto.randomUUID() + crypto.randomUUID() }));
vi.mock("./env", () => ({ ENV: configuration }));
import { createOAuthLoginNonce, getOAuthLoginConfiguration, hashOAuthLoginNonce, isOAuthLoginNonce,
  sealOAuthLoginBinding, openOAuthLoginBinding } from "./oauthState";
const originalCookieSecret = configuration.cookieSecret;

beforeEach(() => {
  configuration.appId = "synthetic-app";
  configuration.oAuthServerUrl = "https://oauth.example.test";
  configuration.cookieSecret = originalCookieSecret;
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PUBLIC_URL", "https://dashboard.example.test");
  vi.stubEnv("VITE_OAUTH_PORTAL_URL", "https://portal.example.test");
});
afterEach(() => vi.unstubAllEnvs());

describe("OAuth initiation configuration and nonce boundaries", () => {
  it("derives only the configured callback and produces distinct canonical random nonces", () => {
    expect(getOAuthLoginConfiguration()).toEqual({ appId: "synthetic-app", portalUrl: "https://portal.example.test",
      callbackUri: "https://dashboard.example.test/api/oauth/callback" });
    const nonces = Array.from({ length: 32 }, createOAuthLoginNonce);
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(nonces.every(isOAuthLoginNonce)).toBe(true);
    expect(hashOAuthLoginNonce(nonces[0])).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOAuthLoginNonce(nonces[0])).not.toContain(nonces[0]);
  });

  it.each([undefined, null, "", "a".repeat(42), "a".repeat(44), "!".repeat(43),
    "a".repeat(42) + "=", "a".repeat(42) + "b", "\u0000".repeat(43), ["a".repeat(43)]])(
    "rejects malformed or noncanonical nonce %j", value => {
      expect(isOAuthLoginNonce(value)).toBe(false);
      expect(() => hashOAuthLoginNonce(value as string)).toThrow();
    },
  );

  it.each(["", "not-a-url", "https://user:password@dashboard.example.test", "https://dashboard.example.test/path",
    "https://dashboard.example.test?query=1", "https://dashboard.example.test#fragment", "http://remote.example.test"])(
    "rejects unsafe or missing public origin %s", value => {
      vi.stubEnv("PUBLIC_URL", value);
      expect(() => getOAuthLoginConfiguration()).toThrow();
    },
  );

  it.each(["", "http://portal.example.test", "https://user:password@portal.example.test",
    "https://portal.example.test?query=1", "https://portal.example.test#fragment"])(
    "rejects unsafe or missing portal %s", value => {
      vi.stubEnv("VITE_OAUTH_PORTAL_URL", value);
      expect(() => getOAuthLoginConfiguration()).toThrow();
    },
  );

  it.each(["", "http://oauth.example.test", "https://user:password@oauth.example.test",
    "https://oauth.example.test?query=1", "https://oauth.example.test#fragment"])(
    "rejects unsafe or missing token server %s", value => {
      configuration.oAuthServerUrl = value;
      expect(() => getOAuthLoginConfiguration()).toThrow();
    },
  );

  it("requires an explicitly configured application identity", () => {
    configuration.appId = " ";
    expect(() => getOAuthLoginConfiguration()).toThrow();
  });

  it.each(["", "short", "a".repeat(31)])("rejects a missing or short cookie encryption key", secret => {
    configuration.cookieSecret = secret;
    expect(() => getOAuthLoginConfiguration()).toThrow();
  });

  it("encrypts the binding with randomized authenticated ciphertext scoped to the callback", () => {
    const binding = createOAuthLoginNonce();
    const callback = getOAuthLoginConfiguration().callbackUri;
    const first = sealOAuthLoginBinding(binding, callback);
    const second = sealOAuthLoginBinding(binding, callback);
    expect(first).not.toBe(second);
    expect(first).not.toContain(binding);
    expect(openOAuthLoginBinding(first, callback)).toBe(binding);
    expect(openOAuthLoginBinding(second, callback)).toBe(binding);
    expect(openOAuthLoginBinding(first, "https://different.example.test/api/oauth/callback")).toBeNull();
    configuration.cookieSecret = crypto.randomUUID() + crypto.randomUUID();
    expect(openOAuthLoginBinding(first, callback)).toBeNull();
  });

  it("rejects unauthenticated, malformed, oversized and tampered browser-binding cookies", () => {
    const callback = getOAuthLoginConfiguration().callbackUri;
    const sealed = sealOAuthLoginBinding(createOAuthLoginNonce(), callback);
    const parts = sealed.split(".");
    const changed = [...parts];
    changed[2] = (changed[2][0] === "A" ? "B" : "A") + changed[2].slice(1);
    for (const value of ["", "v2." + parts.slice(1).join("."), "invalid", sealed + ".extra",
      changed.join("."), "a".repeat(10000), createOAuthLoginNonce()]) {
      expect(openOAuthLoginBinding(value, callback)).toBeNull();
    }
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "allows loopback HTTP only outside production: %s", value => {
      vi.stubEnv("PUBLIC_URL", value);
      expect(getOAuthLoginConfiguration().callbackUri).toBe(`${value}/api/oauth/callback`);
      vi.stubEnv("NODE_ENV", "production");
      expect(() => getOAuthLoginConfiguration()).toThrow();
    },
  );
});
