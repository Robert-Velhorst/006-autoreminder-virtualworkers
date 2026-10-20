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

function request(protocol: string, headers: Request["headers"]): Request {
  return {
    protocol,
    secure: protocol === "https",
    headers,
  } as Request;
}

describe("session cookie security", () => {
  it("uses the trusted request protocol to mark HTTPS cookies secure", () => {
    expect(getSessionCookieOptions(request("https", {})).secure).toBe(true);
  });

  it("does not trust a forwarded-proto header on an insecure request", () => {
    expect(
      getSessionCookieOptions(request("http", { "x-forwarded-proto": "https" }))
        .secure
    ).toBe(false);
  });

  it("keeps the session cookie HTTP-only and same-site", () => {
    expect(getSessionCookieOptions(request("https", {}))).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });
});
