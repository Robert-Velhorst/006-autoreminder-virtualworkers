import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionCookieOptions } from "./cookies";

describe("session cookie options", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed with Secure cookies in production even when a proxy reports HTTP", () => {
    vi.stubEnv("NODE_ENV", "production");

    const options = getSessionCookieOptions({ protocol: "http", headers: {} } as Request);

    expect(options.secure).toBe(true);
  });

  it("keeps loopback development usable without TLS", () => {
    vi.stubEnv("NODE_ENV", "development");

    const options = getSessionCookieOptions({ protocol: "http", headers: {} } as Request);

    expect(options.secure).toBe(false);
  });
});
